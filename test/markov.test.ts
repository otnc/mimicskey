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
