import { describe, expect, test } from "vitest";
import { parseMisskeyTargetUsers, parseSinceDate, parseTwitterTargetUsers } from "../src/config.js";

describe("parseSinceDate", () => {
  test("JST のその日 0:00 を UTC ms で返す", () => {
    expect(parseSinceDate("2024/01/01")).toBe(Date.parse("2023-12-31T15:00:00Z"));
  });

  test("ゼロ埋めなしの月日も受け付ける", () => {
    expect(parseSinceDate("2024/1/5")).toBe(parseSinceDate("2024/01/05"));
  });

  test("書式違いと存在しない日付は弾く", () => {
    expect(() => parseSinceDate("2024-01-01")).toThrow();
    expect(() => parseSinceDate("2024/02/30")).toThrow();
    expect(() => parseSinceDate("2024/13/01")).toThrow();
  });
});

describe("parseMisskeyTargetUsers", () => {
  test("ローカル・リモートのユーザーと開始日を読む", () => {
    expect(parseMisskeyTargetUsers("alice, bob@example.com:2024/01/01")).toEqual([
      { username: "alice", sinceMs: undefined },
      { username: "bob", host: "example.com", sinceMs: parseSinceDate("2024/01/01") },
    ]);
  });

  test("空文字列は空配列", () => {
    expect(parseMisskeyTargetUsers("")).toEqual([]);
  });

  test("@ が 2 つ以上ある指定は弾く", () => {
    expect(() => parseMisskeyTargetUsers("a@b@c")).toThrow();
  });
});

describe("parseTwitterTargetUsers", () => {
  test("先頭の @ を外して小文字にそろえる", () => {
    expect(parseTwitterTargetUsers("@Jack,dorsey:2025/04/01")).toEqual([
      { screenName: "jack", sinceMs: undefined },
      { screenName: "dorsey", sinceMs: parseSinceDate("2025/04/01") },
    ]);
  });

  test("X のユーザー名として不正な指定は弾く", () => {
    expect(() => parseTwitterTargetUsers("user@example.com")).toThrow();
    expect(() => parseTwitterTargetUsers("a_name_longer_than_15")).toThrow();
  });
});
