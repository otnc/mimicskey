import type { Config, TargetUser } from "./config.js";
import type { MisskeyClient, Note } from "./misskey.js";
import type { NoteRow, Store } from "./db.js";
import { log } from "./logger.js";

// 学習に値するノート: 本文があり、公開範囲・リプライ設定・除外ワードを満たすもの。
// 型述語で絞り込んだ先では text が string になっている。
export const isLearnable = (note: Note, cfg: Config): note is Note & { text: string } => {
  if (!note.text || note.text.trim().length === 0) return false;
  if (!cfg.learnVisibilities.has(note.visibility)) return false;
  if (!cfg.includeReplies && note.replyId != null) return false;
  if (cfg.excludeWords.length > 0 && cfg.excludeWords.some((w) => note.text!.includes(w))) {
    return false;
  }
  return true;
};

// 学習に影響する設定のフィンガープリントを返す。
// これが変わったとき、学習データをリセットして再取得する。
const learnConfigFingerprint = (cfg: Config): string =>
  JSON.stringify({
    excludeWords: [...cfg.excludeWords].sort(),
    learnVisibilities: [...cfg.learnVisibilities].sort(),
    includeReplies: cfg.includeReplies,
    targetUsers: cfg.targetUsers
      .map((u) => (u.host ? `${u.username}@${u.host}` : u.username))
      .sort(),
  });

// 学習設定が変わっていたら notes と cursor をクリアして再取得を促す。
// 戻り値は true のときリセットが実行されたことを示す。
export const resetIfLearnConfigChanged = (store: Store, cfg: Config): boolean => {
  const current = learnConfigFingerprint(cfg);
  const stored = store.getState("learnConfigFingerprint");
  if (stored === current) return false;
  store.clearLearningData();
  store.setState("learnConfigFingerprint", current);
  log.info("学習設定が変更されたためデータをリセットします (バックフィルを実行)");
  return true;
};

// ノート 1 件を学習として保存する (WebSocket の userList チャンネルから受信したとき)。
// カーソル (cursor:userId) も進める。Misskey のノート ID は時刻順に並ぶので、辞書順の比較で新しい方を残せばよい。
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

// 対象ユーザーの新着ノートを Store に取り込む。
// 初回は LEARN_NOTES_LIMIT まで遡ってバックフィルし、以降はカーソル以降の差分だけ取る。
// 戻り値は新規に保存できたノート数。
export const syncUserNotes = async (
  client: MisskeyClient,
  store: Store,
  user: TargetUser,
  cfg: Config,
) => {
  const userKey = user.host ? `${user.username}@${user.host}` : user.username;

  // ユーザー ID は最初に 1 回だけ解決して state に置く。
  let userId = store.getState(`uid:${userKey}`);
  if (!userId) {
    userId = (await client.resolveUser(user.username, user.host)).id;
    store.setState(`uid:${userKey}`, userId);
  }

  const learnableRows = (page: Note[]): NoteRow[] =>
    page
      .filter((n) => isLearnable(n, cfg))
      .map((n) => ({ id: n.id, userId: n.userId, text: n.text, createdAt: n.createdAt }));

  const cursorKey = `cursor:${userId}`;
  const cursor = store.getState(cursorKey);
  let added = 0;

  if (!cursor) {
    // バックフィル: 新しい方から 100 件ずつ遡る。
    let untilId: string | undefined;
    let newest: string | null = null;
    let fetched = 0;
    while (fetched < cfg.learnNotesLimit) {
      const page = await client.userNotes(userId, { untilId, limit: 100 });
      if (page.length === 0) break;
      if (!newest) newest = page[0].id;
      added += store.upsertNotes(learnableRows(page));
      fetched += page.length;
      if (page.length < 100) break;
      untilId = page[page.length - 1].id;
    }
    if (newest) store.setState(cursorKey, newest);
    log.info(`バックフィル ${userKey}: ${fetched} 件取得、新規 ${added} 件保存`);
  } else {
    // 差分同期: カーソルより新しいノートをすべて取る。
    let untilId: string | undefined;
    let newest: string | null = null;
    for (;;) {
      const page = await client.userNotes(userId, { sinceId: cursor, untilId, limit: 100 });
      if (page.length === 0) break;
      if (!newest) newest = page[0].id;
      added += store.upsertNotes(learnableRows(page));
      if (page.length < 100) break;
      untilId = page[page.length - 1].id;
    }
    if (newest) store.setState(cursorKey, newest);
    if (added > 0) log.info(`同期 ${userKey}: +${added} 件`);
  }
  return added;
};
