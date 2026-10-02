import { describe, expect, test } from "vitest";
import { createMarkovChain } from "../src/markov.js";
import type { Token } from "../src/tokenizer.js";

const tok = (surface: string, pos = "名詞,普通名詞,一般,*,*,*"): Token => ({
  surface,
  normalized: surface,
  pos: pos.split(","),
});
const PUNCT = tok("。", "記号,句点,*,*,*,*");
const WA = tok("は", "助詞,格助詞,*,*,*,*");
const GA = tok("が", "助詞,格助詞,*,*,*,*");

// 組み合わせの自由度が十分ある小さなコーパス。
// 逐語コピーにならない再結合文を生成できる。
const corpus: Token[][] = [
  [tok("今日"), WA, tok("天気"), GA, tok("良い", "形容詞,一般,*,*,*,*"), PUNCT],
  [tok("明日"), WA, tok("雨"), GA, tok("降る", "動詞,一般,*,*,*,*"), PUNCT],
  [
    tok("猫"),
    GA,
    tok("庭"),
    tok("で", "助詞,格助詞,*,*,*,*"),
    tok("泣いて", "動詞,一般,*,*,*,*"),
    tok("いる", "動詞,非自立可能,*,*,*,*"),
    PUNCT,
  ],
  [
    tok("今日"),
    WA,
    tok("猫"),
    tok("と", "助詞,格助詞,*,*,*,*"),
    tok("遊んだ", "動詞,一般,*,*,*,*"),
    PUNCT,
  ],
  [
    tok("天気"),
    GA,
    tok("良い", "形容詞,一般,*,*,*,*"),
    tok("日"),
    WA,
    tok("散歩", "名詞,普通名詞,サ変可能,*,*,*"),
    tok("する", "動詞,非自立可能,*,*,*,*"),
    PUNCT,
  ],
  [
    tok("猫"),
    GA,
    tok("庭"),
    tok("で", "助詞,格助詞,*,*,*,*"),
    tok("遊んだ", "動詞,一般,*,*,*,*"),
    PUNCT,
  ],
];

// テストを再現可能にする決定的な乱数 (LCG)。
const makeRng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

describe("createMarkovChain", () => {
  test("空のチェーンは何も生成しない", () => {
    const chain = createMarkovChain();
    chain.build([]);
    expect(chain.isEmpty).toBe(true);
    expect(chain.generateSentence()).toBeNull();
    expect(chain.generateNote()).toBeNull();
  });

  test("生成文は句点で終わる", () => {
    const chain = createMarkovChain(makeRng(42));
    chain.build(corpus);
    expect(chain.isEmpty).toBe(false);
    const s = chain.generateSentence({ minChars: 4, maxChars: 50, attempts: 50 });
    expect(s).not.toBeNull();
    if (s === null) return; // 上の expect が失敗しているのでここには来ない
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.endsWith("。")).toBe(true);
  });

  test("学習文の逐語コピーは出さない", () => {
    const chain = createMarkovChain(makeRng(1234));
    chain.build(corpus);
    const corpusTexts = new Set(corpus.map((c) => c.map((t) => t.surface).join("")));
    for (let i = 0; i < 200; i++) {
      const s = chain.generateSentence({ minChars: 2, maxChars: 60, attempts: 50 });
      if (s === null) continue;
      expect(corpusTexts.has(s)).toBe(false);
    }
  });

  test("シード語から文を始める", () => {
    const chain = createMarkovChain(makeRng(1));
    chain.build(corpus);
    expect(chain.hasSeed("猫")).toBe(true);
    const s = chain.generateSentence({ seed: "猫", minChars: 2, maxChars: 60, attempts: 50 });
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(s.startsWith("猫")).toBe(true);
  });

  test("知らないシード語なら通常の文頭から始める", () => {
    const chain = createMarkovChain(makeRng(2));
    chain.build(corpus);
    const s = chain.generateSentence({ seed: "存在しない語", minChars: 2, attempts: 50 });
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(s.endsWith("。")).toBe(true);
  });

  test("同じ語の別の活用形の続きをつなげない", () => {
    // 知っ (連用形) と 知ら (未然形) は正規化形が同じ 知る になる。
    const shitt = { ...tok("知っ", "動詞,一般,*,*,五段-ラ行,連用形-促音便"), normalized: "知る" };
    const shira = { ...tok("知ら", "動詞,一般,*,*,五段-ラ行,未然形-一般"), normalized: "知る" };
    const te = tok("て", "助詞,接続助詞,*,*,*,*");
    const iru = tok("いる", "動詞,非自立可能,*,*,上一段-ア行,終止形-一般");
    const nai = tok("ない", "助動詞,*,*,*,助動詞-ナイ,終止形-一般");
    const chain = createMarkovChain(makeRng(7));
    chain.build([
      [tok("私"), WA, shitt, te, iru, PUNCT],
      [tok("彼"), WA, shira, nai, PUNCT],
    ]);
    for (let i = 0; i < 100; i++) {
      const s = chain.generateSentence({ minChars: 2, attempts: 20 });
      if (s === null) continue;
      expect(s).not.toContain("知っない");
      expect(s).not.toContain("知らて");
    }
  });

  test("括弧の対応が崩れた文は出さない", () => {
    const open = tok("「", "補助記号,括弧開,*,*,*,*");
    const close = tok("」", "補助記号,括弧閉,*,*,*,*");
    const to = tok("と", "助詞,格助詞,*,*,*,*");
    const run = tok("走る", "動詞,一般,*,*,*,終止形-一般");
    const chain = createMarkovChain(makeRng(11));
    chain.build([
      [open, tok("猫"), close, to, tok("言う", "動詞,一般,*,*,*,終止形-一般"), PUNCT],
      [tok("猫"), GA, run, PUNCT],
      [tok("犬"), GA, run, PUNCT],
    ]);
    for (let i = 0; i < 100; i++) {
      const s = chain.generateSentence({ minChars: 2, attempts: 20 });
      if (s === null) continue;
      expect(s.split("「").length).toBe(s.split("」").length);
    }
  });

  test("用言の連用形で途中で切れた文は出さない", () => {
    const futt = tok("降っ", "動詞,一般,*,*,五段-ラ行,連用形-促音便");
    const ta = tok("た", "助動詞,*,*,*,助動詞-タ,終止形-一般");
    const chain = createMarkovChain(makeRng(13));
    chain.build([
      [tok("雨"), GA, futt, ta, PUNCT],
      [tok("雪"), GA, futt, PUNCT],
    ]);
    for (let i = 0; i < 100; i++) {
      const s = chain.generateSentence({ minChars: 2, attempts: 20 });
      if (s === null) continue;
      expect(s.endsWith("降っ。")).toBe(false);
    }
  });

  test("英単語同士はスペースを挟んでつなぐ", () => {
    const to = tok("と", "助詞,格助詞,*,*,*,*");
    const chain = createMarkovChain(makeRng(17));
    chain.build([
      [tok("Hello"), tok("world"), to, tok("言う", "動詞,一般,*,*,*,終止形-一般"), PUNCT],
      [tok("world"), to, tok("書く", "動詞,一般,*,*,*,終止形-一般"), PUNCT],
    ]);
    const generated = Array.from({ length: 50 }, () =>
      chain.generateSentence({ minChars: 2, attempts: 20 }),
    );
    expect(generated).toContain("Hello worldと書く。");
  });

  test("generateNote は長さ上限を守り、終端記号で終わる", () => {
    const chain = createMarkovChain(makeRng(5));
    chain.build(corpus);
    const note = chain.generateNote({
      maxNoteChars: 60,
      maxSentences: 3,
      attempts: 50,
    });
    expect(note).not.toBeNull();
    if (note === null) return;
    expect(note.length).toBeLessThanOrEqual(60);
    expect(/[。！？…]/.test(note.slice(-1))).toBe(true);
  });
});
