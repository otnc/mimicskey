import type { Token } from "./tokenizer.js";

// 文頭・文末を表す擬似トークン。本文に出てこない文字をキーに使う。
const BOS: Token = { surface: "", normalized: "\u0001BOS", pos: ["BOS"] };
const EOS: Token = { surface: "", normalized: "\u0001EOS", pos: ["EOS"] };

// この品詞で始まる文は不自然なので、文頭候補から弾く。
const BAD_START_POS = new Set(["助詞", "助動詞", "記号", "空白", "接続詞"]);

// 文の評価スコアに、1 トークンあたりの平均対数確率をどれだけ反映するか。
// 目標文字数からの差 (文字数単位) と同じスケール感になるよう、経験的に選んだ値。
const LIKELIHOOD_WEIGHT = 10;

type Candidate = {
  token: Token;
  weight: number;
};

// 文脈 (正規化形の文字列キー) ごとの、次に出た語の統計。
type WordStat = { token: Token; count: number };

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

/**
 * 二階マルコフ連鎖。自然な日本文を出すための仕掛け:
 * - 文単位で BOS/EOS 付きで学習し、文の形をしたものだけ生成する
 * - キーは正規化形・出力は表層形で、表記揺れを同じ遷移にまとめる
 * - 二階 (直前 2 トークン) の分布は、一階 (直前 1 トークン) の分布へ補間バックオフする。
 *   observed/unobserved で分布を丸ごと切り替えるのではなく、絶対値割引 (absolute discounting) で
 *   二階から引いた分の確率質量を一階の分布に混ぜる、補間 Kneser-Ney 近似
 *   (Chen & Goodman, "An Empirical Study of Smoothing Techniques for Language Modeling", 1999;
 *    Teh, "A Bayesian Interpretation of Interpolated Kneser-Ney", 2006)
 * - 一階の分布自体も、素の頻度ではなく継続確率 (その語が何種類の直前文脈の後に現れたか) を使う。
 *   頻出語が稀な文脈でも不当に高確率にならないという Kneser-Ney の核になる工夫
 * - 割引量 D は固定値ではなく、その階の出現回数 1 回・2 回の語数の比から都度推定する
 *   (D = n1 / (n1 + 2*n2); 同じく Chen & Goodman 1999 の推定式)
 * - 一階にも文脈がない語 (低頻度語・未知語) は、まず品詞ベースの分布 (この品詞の後には何が来やすいか) へ、
 *   それも空なら学習全体の頻度分布へとさらにバックオフし、生成が途中で止まらないようにする
 *   (Bilmes & Kirchhoff, "Factored Language Models and Generalized Parallel Backoff", 2003 の
 *    考え方: 語の履歴が疎なら、別の factor へ落ちる)
 * - 文頭と遷移は、上記の分布による重み付きサンプリング
 * - 助詞始まり・助詞終わりの文は棄却、bigram のループと学習文の逐語コピーも棄却
 * - 候補は目標長への近さでスコア化し、試行の中で最良のものを採用する
 *
 * @param rng 乱数源。テストで決定的な結果を得るために差し替え可能。
 */
export const createMarkovChain = (rng: () => number = Math.random) => {
  // 直前 2 トークン (正規化形 \u0000 連結) -> 次トークンの正規化形 -> 出現回数。
  const t2 = new Map<string, Map<string, WordStat>>();
  // 直前 1 トークン (正規化形) -> 次トークンの正規化形 -> 出現回数。二階のバックオフ先。
  const t1 = new Map<string, Map<string, WordStat>>();
  // 直前語の品詞大分類 -> 次トークンの正規化形 -> 出現回数。
  // 直前の語そのものが一階にも出てこない (低頻度語・未知語) ときの、語彙全体よりは的を絞ったバックオフ先。
  // Bilmes & Kirchhoff (2003) の factored language model の考え方: 語の履歴が疎なら、別の factor (ここでは品詞) へ落ちる。
  const posContext = new Map<string, Map<string, WordStat>>();
  // コーパス全体での出現回数。品詞バックオフ先も見つからないときの最終手段。
  const unigramCounts = new Map<string, WordStat>();
  // 逐語コピーを弾くための、学習済み文の正規化形の集合。
  const sentenceNorms = new Set<string>();
  // 正規化形 -> その出現位置の文脈 (返信のシード用)。
  const seedContexts = new Map<string, SeedContext[]>();

  const bump = (map: Map<string, WordStat>, token: Token) => {
    const stat = map.get(token.normalized);
    if (stat === undefined) map.set(token.normalized, { token, count: 1 });
    else stat.count += 1;
  };

  const addCandidate = (map: Map<string, Map<string, WordStat>>, key: string, token: Token) => {
    let inner = map.get(key);
    if (inner === undefined) {
      inner = new Map();
      map.set(key, inner);
    }
    bump(inner, token);
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
        addCandidate(posContext, p2.pos[0] ?? "", cur);
        bump(unigramCounts, cur);
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
    smoothingDirty = true;
  };

  // --- 補間 Kneser-Ney 近似のための下位分布 (一度計算したら build まで使い回す) ---

  // 一階の文脈 (直前 1 トークン) ごとの継続カウント: その語が何種類の直前文脈 (二階の p1) の後に現れたか。
  // 素の頻度の代わりにこれを使うのが Kneser-Ney の核。
  const continuation1 = new Map<string, Map<string, number>>();
  const continuation1Total = new Map<string, number>();
  // 文脈なし (ユニグラム) の継続カウント: その語が何種類の直前文脈 (一階の文脈) の後に現れたか。
  const continuation0 = new Map<string, number>();
  let continuation0Total = 0;
  // 各階の割引量。出現回数 1 回・2 回の語数の比から推定する (Good-Turing 的な簡易推定)。
  let discount2 = 0.75;
  let discount1 = 0.75;
  let smoothingDirty = true;

  // D = n1 / (n1 + 2*n2)。データが少なすぎるときは暴れないよう [0.1, 0.75] に収める。
  const estimateDiscount = (counts: number[]): number => {
    let n1 = 0;
    let n2 = 0;
    for (const c of counts) {
      if (c === 1) n1++;
      else if (c === 2) n2++;
    }
    if (n1 === 0) return 0.75;
    const d = n1 / (n1 + 2 * Math.max(n2, 1));
    return Math.min(0.75, Math.max(0.1, d));
  };

  const rebuildSmoothing = () => {
    continuation1.clear();
    continuation1Total.clear();
    continuation0.clear();
    continuation0Total = 0;

    const t2Counts: number[] = [];
    for (const [ctxKey, wordMap] of t2) {
      const p2 = ctxKey.slice(ctxKey.indexOf("\u0000") + 1);
      let inner = continuation1.get(p2);
      if (inner === undefined) {
        inner = new Map();
        continuation1.set(p2, inner);
      }
      for (const [w, stat] of wordMap) {
        inner.set(w, (inner.get(w) ?? 0) + 1);
        continuation1Total.set(p2, (continuation1Total.get(p2) ?? 0) + 1);
        t2Counts.push(stat.count);
      }
    }
    discount2 = estimateDiscount(t2Counts);

    for (const wordMap of t1.values()) {
      for (const w of wordMap.keys()) {
        continuation0.set(w, (continuation0.get(w) ?? 0) + 1);
        continuation0Total += 1;
      }
    }
    const continuation1Counts: number[] = [];
    for (const inner of continuation1.values()) {
      for (const c of inner.values()) continuation1Counts.push(c);
    }
    discount1 = estimateDiscount(continuation1Counts);

    smoothingDirty = false;
  };

  const ensureSmoothing = () => {
    if (smoothingDirty) rebuildSmoothing();
  };

  // 一階のバックオフ分布 P(w | p2)。p2 自体が未知ならさらにユニグラムの継続確率へ落ちる。
  const prob0 = (w: string): number =>
    continuation0Total === 0 ? 0 : (continuation0.get(w) ?? 0) / continuation0Total;

  const prob1 = (p2: string, w: string): number => {
    const contMap = continuation1.get(p2);
    const total = continuation1Total.get(p2);
    if (contMap === undefined || total === undefined || total === 0) return prob0(w);
    const discounted = Math.max((contMap.get(w) ?? 0) - discount1, 0) / total;
    const lambda = (discount1 * contMap.size) / total;
    return discounted + lambda * prob0(w);
  };

  // 文脈 (p1, p2) の次に来る語の候補と重みを、補間バックオフで求める。
  // 直接観測された語は割引後の頻度、未観測の語は一階のバックオフ分布から重みを割り当てる。
  const stepCandidates = (p1: Token, p2: Token): Candidate[] => {
    ensureSmoothing();
    const p2n = p2.normalized;
    const wordMap2 = t2.get(p1.normalized + "\u0000" + p2n);
    const wordMap1 = t1.get(p2n);

    if (wordMap2 === undefined && wordMap1 === undefined) {
      // p2 が直前文脈として一度も観測されていない (低頻度語・未知語)。
      // 語彙全体より的を絞った、品詞ベースの分布 (「この品詞の後には何が来やすいか」) へ落ちる。
      // それも空なら学習全体の頻度分布まで落ち、歩みを止めない。
      const posMap = posContext.get(p2.pos[0] ?? "");
      const source = posMap !== undefined && posMap.size > 0 ? posMap : unigramCounts;
      return [...source.values()].map((stat) => ({ token: stat.token, weight: stat.count }));
    }

    const out: Candidate[] = [];
    const seen = new Set<string>();
    let total2 = 0;
    if (wordMap2) for (const stat of wordMap2.values()) total2 += stat.count;
    const types2 = wordMap2?.size ?? 0;

    if (wordMap2) {
      for (const [w, stat] of wordMap2) {
        const weight = Math.max(stat.count - discount2, 0);
        if (weight > 0) out.push({ token: stat.token, weight });
        seen.add(w);
      }
    }

    // 割引いた分の確率質量 (D2 * 観測された語の種類数) を、一階の分布に従って未観測語へ配る。
    const leftoverMass = total2 > 0 ? discount2 * types2 : 1;
    if (wordMap1) {
      for (const [w, stat] of wordMap1) {
        if (seen.has(w)) continue;
        const p = prob1(p2n, w);
        if (p > 0) out.push({ token: stat.token, weight: leftoverMass * p });
      }
    }
    return out;
  };

  const startCandidates = () => stepCandidates(BOS, BOS);

  // 重み付きサンプリング (重みは割引後の出現回数、またはバックオフ確率に比例する値)。
  // 選んだ候補の対数確率も返す。文全体の尤もらしさをスコアに使うため (後述)。
  const pick = (cands: Candidate[]): { token: Token; logProb: number } | null => {
    if (cands.length === 0) return null;
    let total = 0;
    for (const c of cands) total += c.weight;
    let r = rng() * total;
    for (const c of cands) {
      r -= c.weight;
      if (r < 0) return { token: c.token, logProb: Math.log(c.weight / total) };
    }
    const last = cands[cands.length - 1];
    return { token: last.token, logProb: Math.log(last.weight / total) };
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
  // トークン列も返す内部版: ノート内で次の文のシードを選ぶのに品詞情報が要るため (generateNote 参照)。
  const generateSentenceWithTokens = (
    opts: SentenceOptions = {},
  ): { text: string; tokens: Token[] } | null => {
    const maxTokens = opts.maxTokens ?? 40;
    const minChars = opts.minChars ?? 6;
    const maxChars = opts.maxChars ?? 70;
    const targetChars = opts.targetChars ?? 30;
    const attempts = opts.attempts ?? 40;

    let best: { text: string; tokens: Token[]; score: number } | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const out: Token[] = [];
      let state: [Token, Token];
      // 歩みの中で実際に選んだ候補の対数確率の合計。文の尤もらしさのスコアに使う (後述)。
      let logProbSum = 0;

      if (opts.seed !== undefined) {
        const ctxs = seedContexts.get(opts.seed);
        if (ctxs === undefined) {
          // チェーンが知らない語なら、通常の文頭から始める。
          return generateSentenceWithTokens({ ...opts, seed: undefined });
        }
        const ctx = ctxs[Math.floor(rng() * ctxs.length)];
        state = [ctx.prev, ctx.seed];
        out.push(ctx.seed);
      } else {
        const starts = startCandidates().filter((c) => !BAD_START_POS.has(c.token.pos[0] ?? ""));
        if (starts.length === 0) return null;
        const picked = pick(starts);
        if (!picked) return null;
        state = [BOS, picked.token];
        out.push(picked.token);
        logProbSum += picked.logProb;
      }

      // EOS に届くか、行き止まりか、トークン上限まで歩く。
      let terminated = false;
      while (out.length < maxTokens) {
        const cands = stepCandidates(state[0], state[1]);
        if (cands.length === 0) break;
        const picked = pick(cands);
        if (picked === null) break;
        logProbSum += picked.logProb;
        if (picked.token === EOS) {
          terminated = true;
          break;
        }
        out.push(picked.token);
        state = [state[1], picked.token];
      }

      if (out.length < 2) continue;
      if (!terminated && out.length >= maxTokens) continue; // 上限まで歩いても終わらない文は棄却
      const text = joinSurfaces(out);
      if (text.length < minChars || text.length > maxChars) continue;
      if (hasRepeatedBigram(out)) continue; // ループ文
      if (sentenceNorms.has(out.map((t) => t.normalized).join(""))) continue; // 逐語コピー
      if (out[out.length - 1].pos[0] === "助詞") continue; // 助詞で終わる文は棄却

      // 終端できた文を優先し、目標長への近さと文全体の尤もらしさ (1 トークンあたりの平均対数確率) で評価する。
      // 複数候補を生成してモデル自身の尤度でより良いものを選ぶという rollout の考え方
      // (Li & Bertsekas, "Most Likely Sequence Generation for n-Grams, Transformers, HMMs,
      //  and Markov Chains, by Using Rollout Algorithms", 2024) を、既存の複数試行の仕組みに取り込む。
      const avgLogProb = logProbSum / out.length;
      const score =
        (terminated ? 50 : 0) -
        Math.abs(text.length - targetChars) +
        LIKELIHOOD_WEIGHT * avgLogProb;
      if (best === null || score > best.score) best = { text, tokens: out, score };
      if (best.score >= 40) break;
    }
    return best === null ? null : { text: best.text, tokens: best.tokens };
  };

  const generateSentence = (opts: SentenceOptions = {}) =>
    generateSentenceWithTokens(opts)?.text ?? null;

  // 生成済みの文から、チェーンが知っている語の中で一番長い名詞を選ぶ。
  // 返信のシード選び (notify.ts の generateReply) と同じ考え方を、ノート内の文同士にも使う。
  const pickNounSeed = (tokens: Token[]): string | undefined =>
    tokens
      .filter((t) => t.pos[0] === "名詞" && t.normalized.length >= 2)
      .sort((a, b) => b.normalized.length - a.normalized.length)
      .find((t) => seedContexts.has(t.normalized))?.normalized;

  // ノート 1 つ分を生成する。長さ上限の中で 1..maxSentences 文。
  // 目標長 (targetChars) に満たない間は文を足していく。
  // 2 文目以降は、直前の文から拾った名詞をシードにして話題をつなげる
  // (事象の連想と共起性に基づいたマルコフ連鎖による文生成, 秋山・寺岡, 情報システム学会 2021 の着想)。
  const generateNote = (opts: NoteOptions = {}) => {
    const maxNoteChars = opts.maxNoteChars ?? 140;
    const targetNoteChars = opts.targetChars ?? 40;
    const maxSentences = opts.maxSentences ?? 2;
    const sentenceOpts: SentenceOptions = {
      ...opts,
      maxChars: Math.min(opts.maxChars ?? 70, maxNoteChars),
    };

    const first = generateSentenceWithTokens(sentenceOpts);
    if (first === null) return null;

    const parts: string[] = [first.text];
    let total = first.text.length;
    let prevTokens = first.tokens;
    while (parts.length < maxSentences && total < targetNoteChars) {
      const s = generateSentenceWithTokens({ ...sentenceOpts, seed: pickNounSeed(prevTokens) });
      if (s === null) break;
      if (total + s.text.length > maxNoteChars) break;
      parts.push(s.text);
      total += s.text.length;
      prevTokens = s.tokens;
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
