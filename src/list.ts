import type { Config } from "./config.js";
import type { MisskeyClient } from "./misskey.js";
import type { Store } from "./db.js";
import { log } from "./logger.js";

// 学習対象ユーザーを入れる非公開ユーザーリストを用意する。Misskey には「特定ユーザーのノート」を直接購読するストリーミングチャンネルがないため、非公開リスト + userList チャンネルで受ける。リストは自分にしか見えない (isPublic: false) ので、フォローのような社会的な副作用もない。
// リスト名は "mimicskey-<6文字>" の形式で初回生成時に決め、DB (state: list:name) に保存して以降はそれを使う。同名の既存リストとの衝突を避けるためのランダムサフィックス。
// 前提: 対象ユーザーの ID は state (uid:...) に解決済みであること (起動時に syncUserNotes が行う)。
const getOrCreateListName = (store: Store): string => {
  const stored = store.getState("list:name");
  if (stored) return stored;
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `mimicskey-${suffix}`;
  store.setState("list:name", name);
  return name;
};

export const ensureLearningList = async (deps: {
  client: MisskeyClient;
  store: Store;
  cfg: Config;
}) => {
  const { client, store, cfg } = deps;

  // 対象ユーザーの ID を解決済みの state から集める。
  const targetIds = cfg.targetUsers.map((user) => {
    const userKey = user.host ? `${user.username}@${user.host}` : user.username;
    const userId = store.getState(`uid:${userKey}`);
    if (!userId) {
      throw new Error(`ユーザー ${userKey} の ID が未解決です (同期に失敗しています)`);
    }
    return userId;
  });

  const listName = getOrCreateListName(store);

  // 既存のリストを名前で探し、なければ作る。
  const existing = (await client.userLists()).find((list) => list.name === listName);
  const listId = existing?.id ?? (await client.userListCreate(listName)).id;

  // メンバーを設定に合わせる (追加・削除・リプライ設定)。
  const members = await client.userListMembers(listId);
  const memberIds = new Set(members.map((m) => m.userId));

  for (const userId of targetIds) {
    if (!memberIds.has(userId)) {
      await client.userListPush(listId, userId);
      log.info(`学習リストに ${userId} を追加しました`);
    }
    // リプライも学習する設定なら、メンバーシップの withReplies を立てる
    // (userList チャンネルはリプライをこのフラグで流す)。
    const membership = members.find((m) => m.userId === userId);
    if (cfg.includeReplies && membership && !membership.withReplies) {
      await client.userListSetWithReplies(listId, userId, true);
    }
  }
  for (const m of members) {
    if (!targetIds.includes(m.userId)) {
      await client.userListPull(listId, m.userId);
      log.info(`学習リストから ${m.userId} を削除しました`);
    }
  }

  return { listId };
};
