import type { Token } from "./tokenizer.js";

// 文頭・文末を表す擬似トークン。本文に出てこない文字をキーに使う。
const BOS: Token = { surface: "", normalized: "\u0001BOS", pos: ["BOS"] };
const EOS: Token = { surface: "", normalized: "\u0001EOS", pos: ["EOS"] };

// この品詞で始まる文は不自然なので、文頭候補から弾く。
const BAD_START_POS = new Set(["助詞", "助動詞", "記号", "空白", "接続詞"]);

type Candidate = {
  token: Token;
  weight: number;
};

// 返信時に、相手が使った語から文を始めるための文脈。
type SeedContext = {
  /** シード語の直前のトークン (文頭のときは BOS)。 */
  prev: Token;
  seed: Token;
};

export type SentenceOptions = {
  /** この正規化形の語から文を始める (返信時のシード)。 */
  seed?: string;
  /** 1 文あたりの最大トークン数。 */
  maxTokens?: number;
  /** 長さの下限・上限・目標 (文字数)。目標に近い候補が採用される。 */
  minChars?: number;
  maxChars?: number;
  targetChars?: number;
  /** 生成の試行回数。 */
  attempts?: number;
};

export type NoteOptions = SentenceOptions & {
  maxNoteChars?: number;
  maxSentences?: number;
};

// 二階マルコフ連鎖。自然な日本文を出すための仕掛け:
// - 文単位で BOS/EOS 付きで学習し、文の形をしたものだけ生成する
// - キーは正規化形・出力は表層形で、表記揺れを同じ遷移にまとめる
// - 観測されていない三階状態では一階にバックオフして、歩みが止まらないようにする
// - 文頭と遷移は出現頻度で重み付きサンプリング
// - 助詞始まり・助詞終わりの文は棄却、bigram のループと学習文の逐語コピーも棄却
// - 候補は目標長への近さでスコア化し、試行の中で最良のものを採用する
export const createMarkovChain = (rng: () => number = Math.random) => {
  // 直前 2 トークン -> 次トークン (二階) と、直前 1 トークン -> 次 (一階、バックオフ用)。
  const t2 = new Map<string, Candidate[]>();
  const t1 = new Map<string, Candidate[]>();
  // 逐語コピーを弾くための、学習済み文の正規化形の集合。
  const sentenceNorms = new Set<string>();
  // 正規化形 -> その出現位置の文脈 (返信のシード用)。
  const seedContexts = new Map<string, SeedContext[]>();

  const addCandidate = (map: Map<string, Candidate[]>, key: string, token: Token) => {
    const list = map.get(key);
    if (list === undefined) {
      map.set(key, [{ token, weight: 1 }]);
      return;
    }
    const last = list[list.length - 1];
    if (last.token === token) last.weight += 1;
    else list.push({ token, weight: 1 });
  };

  // 文を学習する。文には終端記号 (。など) を含んでいること。
  const build = (sentences: Token[][]) => {
    for (const toks of sentences) {
      if (toks.length < 2) continue;
      sentenceNorms.add(toks.map((t) => t.normalized).join(""));

      // 先頭のトークンも二階の履歴を持てるように、BOS を 2 つ前置する。
      const seq: Token[] = [BOS, BOS, ...toks, EOS];
      for (let i = 2; i < seq.length; i++) {
        const cur = seq[i];
        const p1 = seq[i - 2];
        const p2 = seq[i - 1];
        addCandidate(t2, p1.normalized + "\u0000" + p2.normalized, cur);
        addCandidate(t1, p2.normalized, cur);
      }

      // 返信のシードに使えるよう、各トークンの出現位置を覚えておく。
      for (let i = 0; i < toks.length; i++) {
        const key = toks[i].normalized;
        let list = seedContexts.get(key);
        if (!list) {
          list = [];
          seedContexts.set(key, list);
        }
        list.push({ prev: i > 0 ? toks[i - 1] : BOS, seed: toks[i] });
      }
    }
  };

  const startCandidates = () => t2.get(`${BOS.normalized}\u0000${BOS.normalized}`) ?? [];

  // 出現頻度による重み付きサンプリング。
  const pick = (cands: Candidate[]) => {
    if (cands.length === 0) return null;
    let total = 0;
    for (const c of cands) total += c.weight;
    let r = rng() * total;
    for (const c of cands) {
      r -= c.weight;
      if (r < 0) return c.token;
    }
    return cands[cands.length - 1].token;
  };

  // 同じ bigram が 2 回出たら、退化したループ文として棄却する。
  const hasRepeatedBigram = (out: Token[]) => {
    const seen = new Set<string>();
    for (let i = 0; i + 1 < out.length; i++) {
      const key = `${out[i].normalized}\u0000${out[i + 1].normalized}`;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  };

  const joinSurfaces = (toks: Token[]) =>
    toks
      .map((t) => t.surface)
      .join("")
      .replace(/^[、。,.！？!?…\s]+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  // 1 文生成する。妥当な候補が見つからなければ null。
  const generateSentence = (opts: SentenceOptions = {}) => {
    const maxTokens = opts.maxTokens ?? 40;
    const minChars = opts.minChars ?? 6;
    const maxChars = opts.maxChars ?? 70;
    const targetChars = opts.targetChars ?? 30;
    const attempts = opts.attempts ?? 40;

    let best: { text: string; score: number } | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const out: Token[] = [];
      let state: [Token, Token];

      if (opts.seed !== undefined) {
        const ctxs = seedContexts.get(opts.seed);
        if (ctxs === undefined) {
          // チェーンが知らない語なら、通常の文頭から始める。
          return generateSentence({ ...opts, seed: undefined });
        }
        const ctx = ctxs[Math.floor(rng() * ctxs.length)];
        state = [ctx.prev, ctx.seed];
        out.push(ctx.seed);
      } else {
        const starts = startCandidates().filter((c) => !BAD_START_POS.has(c.token.pos[0] ?? ""));
        if (starts.length === 0) return null;
        const startTok = pick(starts);
        if (!startTok) return null;
        state = [BOS, startTok];
        out.push(startTok);
      }

      // EOS に届くか、行き止まりか、トークン上限まで歩く。
      let terminated = false;
      while (out.length < maxTokens) {
        const c2 = t2.get(state[0].normalized + "\u0000" + state[1].normalized);
        const c1 = t1.get(state[1].normalized);
        const cands = c2 !== undefined && c2.length > 0 ? c2 : c1;
        if (cands === undefined || cands.length === 0) break;
        const tok = pick(cands);
        if (tok === null) break;
        if (tok === EOS) {
          terminated = true;
          break;
        }
        out.push(tok);
        state = [state[1], tok];
      }

      if (out.length < 2) continue;
      if (!terminated && out.length >= maxTokens) continue; // 上限まで歩いても終わらない文は棄却
      const text = joinSurfaces(out);
      if (text.length < minChars || text.length > maxChars) continue;
      if (hasRepeatedBigram(out)) continue; // ループ文
      if (sentenceNorms.has(out.map((t) => t.normalized).join(""))) continue; // 逐語コピー
      if (out[out.length - 1].pos[0] === "助詞") continue; // 助詞で終わる文は棄却

      // 終端できた文を優先し、その中で目標長に近いものを選ぶ。
      const score = (terminated ? 50 : 0) - Math.abs(text.length - targetChars);
      if (best === null || score > best.score) best = { text, score };
      if (best.score >= 40) break;
    }
    return best === null ? null : best.text;
  };

  // ノート 1 つ分を生成する。長さ上限の中で 1..maxSentences 文。
  // 目標長 (targetChars) に満たない間は文を足していく。
  const generateNote = (opts: NoteOptions = {}) => {
    const maxNoteChars = opts.maxNoteChars ?? 140;
    const targetNoteChars = opts.targetChars ?? 40;
    const maxSentences = opts.maxSentences ?? 2;
    const sentenceOpts: SentenceOptions = {
      ...opts,
      maxChars: Math.min(opts.maxChars ?? 70, maxNoteChars),
    };

    const first = generateSentence(sentenceOpts);
    if (first === null) return null;

    const parts: string[] = [first];
    let total = first.length;
    while (parts.length < maxSentences && total < targetNoteChars) {
      const s = generateSentence({ ...sentenceOpts, seed: undefined });
      if (s === null) break;
      if (total + s.length > maxNoteChars) break;
      parts.push(s);
      total += s.length;
    }

    let text = parts.join("");
    if (!/[。！？!?…‼⁉]$/.test(text)) text += "。";
    return text.length <= maxNoteChars ? text : text.slice(0, maxNoteChars);
  };

  return {
    build,
    hasSeed: (normalized: string) => seedContexts.has(normalized),
    get isEmpty() {
      return startCandidates().length === 0;
    },
    generateSentence,
    generateNote,
  };
};

export type MarkovChain = ReturnType<typeof createMarkovChain>;
