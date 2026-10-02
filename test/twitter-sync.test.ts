import { describe, expect, test } from "vitest";
import type { Config } from "../src/config.js";
import type { Tweet } from "../src/twitter.js";
import { buildSearchQuery, isLearnableTweet } from "../src/twitter-sync.js";

const cfg = (overrides: { includeReplies?: boolean; excludeWords?: string[] } = {}) =>
  ({
    includeReplies: overrides.includeReplies ?? true,
    twitter: { excludeWords: overrides.excludeWords ?? [] },
  }) as Config;

const tweet = (overrides: Partial<Tweet> = {}) =>
  ({ text: "今日はいい天気", reposted_by: null, replying_to: null, ...overrides }) as Tweet;

describe("isLearnableTweet", () => {
  test("本人のツイートは学習する", () => {
    expect(isLearnableTweet(tweet(), cfg())).toBe(true);
  });

  test("リツイートは学習しない", () => {
    const reposted = tweet({ reposted_by: {} as Tweet["reposted_by"] });
    expect(isLearnableTweet(reposted, cfg())).toBe(false);
  });

  test("includeReplies が false ならリプライを学習しない", () => {
    const reply = tweet({ replying_to: {} as Tweet["replying_to"] });
    expect(isLearnableTweet(reply, cfg())).toBe(true);
    expect(isLearnableTweet(reply, cfg({ includeReplies: false }))).toBe(false);
  });

  test("除外ワードを含むツイートと空のツイートは学習しない", () => {
    expect(isLearnableTweet(tweet(), cfg({ excludeWords: ["天気"] }))).toBe(false);
    expect(isLearnableTweet(tweet({ text: " " }), cfg())).toBe(false);
  });
});

describe("buildSearchQuery", () => {
  test("バックフィルは from: だけ", () => {
    expect(buildSearchQuery({ screenName: "jack" }, {}, true)).toBe("from:jack");
  });

  test("中断したバックフィルは max_id: で続きから取る", () => {
    expect(buildSearchQuery({ screenName: "jack" }, { maxId: "456" }, true)).toBe(
      "from:jack max_id:456",
    );
  });

  test("カーソル・開始日・リプライ除外を演算子にする", () => {
    const sinceMs = Date.parse("2024-01-01T00:00:00Z");
    expect(buildSearchQuery({ screenName: "jack", sinceMs }, { sinceId: "123" }, false)).toBe(
      "from:jack since_id:123 since_time:1704067200 -filter:replies",
    );
  });
});
