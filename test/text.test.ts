import { describe, expect, test } from "vitest";
import { cleanNoteText, splitSentences } from "../src/text.js";

describe("cleanNoteText", () => {
  test("メンション・URL・MFM 記法を除いて語を残す", () => {
    const cleaned = cleanNoteText("@bot hello $[x2 **check**] https://example.com #テスト");
    expect(cleaned).not.toContain("@");
    expect(cleaned).not.toContain("http");
    expect(cleaned).toContain("hello");
    expect(cleaned).toContain("check");
    expect(cleaned).toContain("テスト");
    expect(cleaned).not.toContain("#");
  });

  test("ネストした MFM 関数も中身を取り出す", () => {
    expect(cleanNoteText("$[x2 $[spin すごい]]")).toBe("すごい");
  });

  test("カスタム絵文字コードは捨てる", () => {
    expect(cleanNoteText("良い :innocent:")).toBe("良い");
  });

  test("引用とコードブロックは捨てる", () => {
    expect(cleanNoteText("> 引用された文\n返信本文")).toBe("返信本文");
    expect(cleanNoteText("```\ncode\n```\n本文")).toBe("本文");
  });

  test("改行は文の境界として残す", () => {
    expect(cleanNoteText("一行目\n二行目")).toBe("一行目\n二行目");
  });
});

describe("splitSentences", () => {
  test("終端記号と改行で分割する", () => {
    expect(splitSentences("今日は晴れです。明日は雨かな？\nそうだね")).toEqual([
      "今日は晴れです。",
      "明日は雨かな？",
      "そうだね",
    ]);
  });

  test("閉じ括弧は直前の文に残る", () => {
    expect(splitSentences("「はい」と言った。次の文")).toEqual(["「はい」と言った。", "次の文"]);
  });

  test("連続した終端記号をまとめる", () => {
    expect(splitSentences("すごい！！本当に？")).toEqual(["すごい！！", "本当に？"]);
  });

  test("実質 1 文字の断片は捨てる", () => {
    expect(splitSentences("あ。長い文です。")).toEqual(["長い文です。"]);
  });
});
