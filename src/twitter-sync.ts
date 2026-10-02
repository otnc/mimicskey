import { z } from "zod";
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
// sinceId は差分同期のカーソル、maxId は中断したバックフィルの再開位置 (この ID 以前を取る。境界の 1 件は重複するが保存時に無視される)。
export const buildSearchQuery = (
  user: TwitterTargetUser,
  range: { sinceId?: string; maxId?: string },
  includeReplies: boolean,
) =>
  [
    `from:${user.screenName}`,
    range.sinceId ? `since_id:${range.sinceId}` : null,
    range.maxId ? `max_id:${range.maxId}` : null,
    user.sinceMs === undefined ? null : `since_time:${Math.floor(user.sinceMs / 1000)}`,
    includeReplies ? null : "-filter:replies",
  ]
    .filter((term) => term !== null)
    .join(" ");

// ツイート ID は桁数が変わりうる数字列なので、文字列ではなく BigInt で比べる。
const newerId = (a: string | null, b: string) => (!a || BigInt(b) > BigInt(a) ? b : a);
const olderId = (a: string | null, b: string) => (!a || BigInt(b) < BigInt(a) ? b : a);

const tweetDate = (tweet: Tweet) =>
  new Date(tweet.created_timestamp * 1000).toISOString().slice(0, 10);

// 途中までのバックフィルの進捗。ページごとに state に保存し、失敗しても次の試行で続きから取れるようにする。
const backfillProgressSchema = z.strictObject({
  newest: z.string().nullable(),
  oldest: z.string().nullable(),
  fetched: z.number(),
  added: z.number(),
});
type BackfillProgress = z.infer<typeof backfillProgressSchema>;

const PROGRESS_LOG_EVERY_PAGES = 5;

// バックフィル: 新しい方から LEARN_NOTES_LIMIT か開始日 (sinceMs) に届くまで遡り、終わったら差分同期のカーソルを置く。
const backfillTwitterUser = async (
  client: TwitterClient,
  store: Store,
  user: TwitterTargetUser,
  cfg: Config,
  signal: AbortSignal,
) => {
  const progressKey = `backfill:twitter:${user.screenName}`;
  const saved = store.getState(progressKey);
  const progress: BackfillProgress = saved
    ? backfillProgressSchema.parse(JSON.parse(saved))
    : { newest: null, oldest: null, fetched: 0, added: 0 };
  if (saved) {
    log.info(`バックフィル再開 @${user.screenName} (X): ${progress.fetched} 件取得済みの続きから`);
  } else {
    log.info(`バックフィル開始 @${user.screenName} (X)`);
  }

  const query = buildSearchQuery(user, { maxId: progress.oldest ?? undefined }, cfg.includeReplies);
  let pageCursor: string | undefined;
  let pages = 0;
  let addedThisRun = 0;
  while (progress.fetched < cfg.learnNotesLimit) {
    const page = await client.searchLatest(query, { cursor: pageCursor, signal });
    if (page.results.length === 0) break;
    const added = store.upsertNotes(
      page.results.filter((t) => isLearnableTweet(t, cfg)).map(toNoteRow),
    );
    addedThisRun += added;
    progress.added += added;
    progress.fetched += page.results.length;
    for (const tweet of page.results) {
      progress.newest = newerId(progress.newest, tweet.id);
      progress.oldest = olderId(progress.oldest, tweet.id);
    }
    store.setState(progressKey, JSON.stringify(progress));

    pages++;
    if (pages % PROGRESS_LOG_EVERY_PAGES === 0) {
      log.info(
        `バックフィル中 @${user.screenName} (X): ${progress.fetched} 件取得、新規 ${progress.added} 件保存 (${tweetDate(page.results[page.results.length - 1])} まで遡り済み)`,
      );
    }
    pageCursor = page.cursor.bottom ?? undefined;
    if (!pageCursor) break;
  }

  if (progress.newest) store.setState(`cursor:twitter:${user.screenName}`, progress.newest);
  store.deleteState(progressKey);
  log.info(
    `バックフィル完了 @${user.screenName} (X): ${progress.fetched} 件取得、新規 ${progress.added} 件保存`,
  );
  return addedThisRun;
};

// 差分同期: カーソルより新しいツイートをすべて取る。
// 途中で失敗したらカーソルを進めず、次の試行で同じ範囲を取り直す (重複は保存時に無視される)。
const diffTwitterUser = async (
  client: TwitterClient,
  store: Store,
  user: TwitterTargetUser,
  cursor: string,
  cfg: Config,
  signal: AbortSignal,
) => {
  log.debug(`差分取得 @${user.screenName} (X): ${cursor} より新しいツイート`);
  const query = buildSearchQuery(user, { sinceId: cursor }, cfg.includeReplies);
  let pageCursor: string | undefined;
  let newest = cursor;
  let added = 0;
  for (;;) {
    const page = await client.searchLatest(query, { cursor: pageCursor, signal });
    if (page.results.length === 0) break;
    added += store.upsertNotes(page.results.filter((t) => isLearnableTweet(t, cfg)).map(toNoteRow));
    for (const tweet of page.results) newest = newerId(newest, tweet.id);
    pageCursor = page.cursor.bottom ?? undefined;
    if (!pageCursor) break;
  }
  store.setState(`cursor:twitter:${user.screenName}`, newest);
  if (added > 0) log.info(`同期 @${user.screenName} (X): +${added} 件`);
  return added;
};

// 対象ユーザーのツイートを Store に取り込む。
// 未取得のユーザーはバックフィル (中断していれば続きから)、取得済みはカーソル以降の差分だけ取る。
// 戻り値は新規に保存できたツイート数。
export const syncTwitterUser = async (
  client: TwitterClient,
  store: Store,
  user: TwitterTargetUser,
  cfg: Config,
  signal: AbortSignal,
) => {
  const cursor = store.getState(`cursor:twitter:${user.screenName}`);
  if (!cursor) return backfillTwitterUser(client, store, user, cfg, signal);
  return diffTwitterUser(client, store, user, cursor, cfg, signal);
};
