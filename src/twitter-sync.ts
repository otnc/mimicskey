import type { Config, TwitterTargetUser } from "./config.js";
import type { NoteRow, Store } from "./db.js";
import type { Tweet, TwitterClient } from "./twitter.js";
import { log } from "./logger.js";

// 学習に値するツイート: リツイートではなく、本文があり、リプライ設定・除外ワードを満たすもの。
export const isLearnableTweet = (tweet: Tweet, cfg: Config) => {
  if (tweet.reposted_by) return false;
  if (tweet.text.trim().length === 0) return false;
  if (!cfg.includeReplies && tweet.replying_to) return false;
  if (cfg.twitter.excludeWords.some((w) => tweet.text.includes(w))) return false;
  return true;
};

// Misskey のノートと ID が衝突しないよう、ID には "twitter:" を前置して保存する。
// createdAt は Misskey と同じ ISO 8601 にそろえる (loadRecentTexts が文字列順で並べるため)。
const toNoteRow = (tweet: Tweet): NoteRow => ({
  id: `twitter:${tweet.id}`,
  userId: `twitter:${tweet.author.id}`,
  text: tweet.text,
  createdAt: new Date(tweet.created_timestamp * 1000).toISOString(),
});

// タイムライン API は直近 120 件程度しか遡れないため、from: 検索で取得する。
// 検索はリツイートを含まず、リプライを含めて全期間を遡れる。
export const buildSearchQuery = (
  user: TwitterTargetUser,
  cursor: string | null,
  includeReplies: boolean,
) =>
  [
    `from:${user.screenName}`,
    cursor ? `since_id:${cursor}` : null,
    user.sinceMs === undefined ? null : `since_time:${Math.floor(user.sinceMs / 1000)}`,
    includeReplies ? null : "-filter:replies",
  ]
    .filter((term) => term !== null)
    .join(" ");

// 対象ユーザーのツイートを Store に取り込む。
// 未取得のユーザーは LEARN_NOTES_LIMIT か開始日 (sinceMs) に届くまで遡ってバックフィルし、取得済みはカーソル以降の差分だけ取る。
// 戻り値は新規に保存できたツイート数。
export const syncTwitterUser = async (
  client: TwitterClient,
  store: Store,
  user: TwitterTargetUser,
  cfg: Config,
) => {
  const cursorKey = `cursor:twitter:${user.screenName}`;
  const cursor = store.getState(cursorKey);
  const query = buildSearchQuery(user, cursor, cfg.includeReplies);

  let pageCursor: string | undefined;
  let newest = cursor;
  let fetched = 0;
  let added = 0;
  // 差分は since_id で区切られるので、件数の上限を見るのはバックフィルのときだけ。
  while (cursor || fetched < cfg.learnNotesLimit) {
    const page = await client.searchLatest(query, pageCursor);
    if (page.results.length === 0) break;
    added += store.upsertNotes(page.results.filter((t) => isLearnableTweet(t, cfg)).map(toNoteRow));
    fetched += page.results.length;
    // ツイート ID は桁数が変わりうる数字列なので、文字列ではなく BigInt で比べる。
    for (const tweet of page.results) {
      if (!newest || BigInt(tweet.id) > BigInt(newest)) newest = tweet.id;
    }
    pageCursor = page.cursor.bottom ?? undefined;
    if (!pageCursor) break;
  }
  if (newest && newest !== cursor) store.setState(cursorKey, newest);

  if (!cursor) {
    log.info(`バックフィル @${user.screenName} (X): ${fetched} 件取得、新規 ${added} 件保存`);
  } else if (added > 0) {
    log.info(`同期 @${user.screenName} (X): +${added} 件`);
  }
  return added;
};
