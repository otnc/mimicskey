import type { Config, MisskeyTargetUser } from "./config.js";
import type { MisskeyClient, Note } from "./misskey.js";
import type { NoteRow, Store } from "./db.js";
import { log } from "./logger.js";

// 学習に値するノート: 本文があり、公開範囲・リプライ設定・除外ワードを満たすもの。
// 型述語で絞り込んだ先では text が string になっている。
export const isLearnable = (note: Note, cfg: Config): note is Note & { text: string } => {
  if (!note.text || note.text.trim().length === 0) return false;
  if (!cfg.misskey.learnVisibilities.has(note.visibility)) return false;
  if (!cfg.includeReplies && note.replyId != null) return false;
  if (cfg.misskey.excludeWords.some((w) => note.text!.includes(w))) return false;
  return true;
};

// ノート 1 件を学習として保存する (WebSocket の userList チャンネルから受信したとき)。
// カーソル (cursor:userId) も進める。Misskey のノート ID は時刻順に並ぶので、辞書順の比較で新しい方を残せばよい。
// リアルタイムに届くノートは常に開始日 (sinceMs) より新しいので、ここでは開始日を見ない。
// 戻り値は新規に保存できたかどうか。
export const learnNote = (store: Store, note: Note, cfg: Config) => {
  if (!isLearnable(note, cfg)) return false;
  const added =
    store.upsertNotes([
      { id: note.id, userId: note.userId, text: note.text, createdAt: note.createdAt },
    ]) > 0;
  const cursorKey = `cursor:${note.userId}`;
  const cursor = store.getState(cursorKey);
  if (!cursor || note.id > cursor) store.setState(cursorKey, note.id);
  return added;
};

export const misskeyUserKey = (user: MisskeyTargetUser) =>
  user.host ? `${user.username}@${user.host}` : user.username;

// ユーザー ID を解決して state に置く (API を叩くのは最初の 1 回だけ)。
const resolveUserId = async (client: MisskeyClient, store: Store, user: MisskeyTargetUser) => {
  const userKey = misskeyUserKey(user);
  let userId = store.getState(`uid:${userKey}`);
  if (!userId) {
    userId = (await client.resolveUser(user.username, user.host)).id;
    store.setState(`uid:${userKey}`, userId);
  }
  return { userKey, userId };
};

const isBeforeSince = (note: Note, sinceMs: number | undefined) =>
  sinceMs !== undefined && Date.parse(note.createdAt) < sinceMs;

const learnableRows = (page: Note[], cfg: Config, sinceMs: number | undefined): NoteRow[] =>
  page
    .filter((n) => isLearnable(n, cfg))
    .filter((n) => !isBeforeSince(n, sinceMs))
    .map((n) => ({ id: n.id, userId: n.userId, text: n.text, createdAt: n.createdAt }));

// バックフィル: 新しい方から 100 件ずつ、LEARN_NOTES_LIMIT か開始日 (sinceMs) に届くまで遡る。
const backfillUserNotes = async (
  client: MisskeyClient,
  store: Store,
  user: MisskeyTargetUser,
  userId: string,
  cfg: Config,
) => {
  let untilId: string | undefined;
  let newest: string | null = null;
  let added = 0;
  let fetched = 0;
  while (fetched < cfg.learnNotesLimit) {
    const page = await client.userNotes(userId, { untilId, limit: 100 });
    if (page.length === 0) break;
    if (!newest) newest = page[0].id;
    added += store.upsertNotes(learnableRows(page, cfg, user.sinceMs));
    fetched += page.length;
    if (page.length < 100 || isBeforeSince(page[page.length - 1], user.sinceMs)) break;
    untilId = page[page.length - 1].id;
  }
  if (newest) store.setState(`cursor:${userId}`, newest);
  log.info(`バックフィル ${misskeyUserKey(user)}: ${fetched} 件取得、新規 ${added} 件保存`);
  return added;
};

// 差分同期: カーソルより新しいノートをすべて取る。
const diffUserNotes = async (
  client: MisskeyClient,
  store: Store,
  user: MisskeyTargetUser,
  userId: string,
  cursor: string,
  cfg: Config,
) => {
  let untilId: string | undefined;
  let newest: string | null = null;
  let added = 0;
  for (;;) {
    const page = await client.userNotes(userId, { sinceId: cursor, untilId, limit: 100 });
    if (page.length === 0) break;
    if (!newest) newest = page[0].id;
    added += store.upsertNotes(learnableRows(page, cfg, user.sinceMs));
    if (page.length < 100) break;
    untilId = page[page.length - 1].id;
  }
  if (newest) store.setState(`cursor:${userId}`, newest);
  if (added > 0) log.info(`同期 ${misskeyUserKey(user)}: +${added} 件`);
  return added;
};

// 対象ユーザーのノートを Store に取り込む (learn コマンド用)。
// 未取得のユーザーは LEARN_NOTES_LIMIT まで遡ってバックフィルし、取得済みはカーソル以降の差分だけ取る。
// 戻り値は新規に保存できたノート数。
export const syncUserNotes = async (
  client: MisskeyClient,
  store: Store,
  user: MisskeyTargetUser,
  cfg: Config,
) => {
  const { userId } = await resolveUserId(client, store, user);
  const cursor = store.getState(`cursor:${userId}`);
  if (!cursor) return backfillUserNotes(client, store, user, userId, cfg);
  return diffUserNotes(client, store, user, userId, cursor, cfg);
};

// Bot の接続・再接続時の回収用: カーソル以降の差分だけ取る。
// 未取得 (バックフィル前) のユーザーは何もしない (バックフィルは learn コマンドで行う)。
export const catchUpUserNotes = async (
  client: MisskeyClient,
  store: Store,
  user: MisskeyTargetUser,
  cfg: Config,
) => {
  const { userId } = await resolveUserId(client, store, user);
  const cursor = store.getState(`cursor:${userId}`);
  if (!cursor) return 0;
  return diffUserNotes(client, store, user, userId, cursor, cfg);
};
