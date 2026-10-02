import { describe, expect, test } from "vitest";
import {
  cleanNoteText,
  extractLearningSentences,
  isJapaneseSentence,
  splitSentences,
} from "../src/text.js";

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

  test("MFM が URL と見なさないスキームの URL も捨てる", () => {
    expect(cleanNoteText("wss://example.com/stream に繋ぐ")).toBe("に繋ぐ");
  });

  test("【】の見出しとバージョン番号を捨てる", () => {
    expect(cleanNoteText("【お知らせ】v0.4.1をリリースしました")).toBe("をリリースしました");
  });

  test("英数字だけのハッシュタグは捨て、日本語を含むタグは語幹を残す", () => {
    const cleaned = cleanNoteText("良い湯 #onsenfun #温泉");
    expect(cleaned).not.toContain("onsenfun");
    expect(cleaned).toContain("温泉");
  });

  test("…!? や ！？ のような記号は残す", () => {
    expect(cleanNoteText("マジで…!? 本当に！？")).toBe("マジで…!? 本当に！？");
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

  test("…!? のような終端記号の連なりは文末に残す", () => {
    expect(splitSentences("マジで…!?本当に！？")).toEqual(["マジで…!?", "本当に！？"]);
  });

  test("改行の直後に終端記号が続いても文の中に改行を残さない", () => {
    expect(splitSentences("使うようにしている\n…")).toEqual(["使うようにしている…"]);
  });
});

describe("isJapaneseSentence", () => {
  test("技術用語の英単語が混ざる日本語の文は残す", () => {
    expect(isJapaneseSentence("TypeScriptで書き直した。")).toBe(true);
  });

  test("英文は外す", () => {
    expect(isJapaneseSentence("This is also in the testing phase.")).toBe(false);
  });

  test("コード片やハッシュ値を含む文は外す", () => {
    expect(isJapaneseSentence("x = foo(bar); を書いた")).toBe(false);
    expect(isJapaneseSentence("コミット 1a2b3c4d を戻した")).toBe(false);
  });
});

describe("extractLearningSentences", () => {
  test("本文から学習に向く日本語の文だけを取り出す", () => {
    expect(extractLearningSentences("今日は晴れ！？\nHello world!\n明日も晴れ")).toEqual([
      "今日は晴れ！？",
      "明日も晴れ",
    ]);
  });
});
