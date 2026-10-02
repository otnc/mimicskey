import { FxTwitterV2, type TwitterStatus } from "fxtwitter/v2";

export type Tweet = TwitterStatus;

// FxTwitter の公開 API (https://api.fxtwitter.com) を fxtwitter パッケージ経由で呼ぶ。X の認証情報は要らない。
// User-Agent には設置ごとの instanceId を入れ、リポジトリの URL は入れない (フォーク先が元リポジトリを名乗らないように)。
export const createTwitterClient = (instanceId: string) => {
  const fx = new FxTwitterV2({
    headers: { "User-Agent": `mimicskey (+${instanceId})` },
    timeout: 30_000,
    retry: 2,
    retryDelay: 1_000,
  });

  return {
    // 新しい順の検索結果。1 ページは 20 件前後で、count を指定しても増えない。
    // 結果が尽きても cursor.bottom は null にならないので、終端は空の results で判断する。
    searchLatest: (query: string, options: { cursor?: string; signal?: AbortSignal } = {}) =>
      fx.search(query, { feed: "latest", ...options }),
  };
};

export type TwitterClient = ReturnType<typeof createTwitterClient>;
