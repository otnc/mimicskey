import * as Misskey from "misskey-js";

export type Note = Misskey.entities.Note;
export type MkNotification = Misskey.entities.Notification;

// Misskey 公式 SDK (misskey-js) の APIClient で API を呼ぶ。
// エンドポイントごとに引数と戻り値が型付きなので、手書きの fetch より安全。
export const createMisskeyClient = (origin: string, credential: string) => {
  const cli = new Misskey.api.APIClient({ origin, credential });

  return {
    me: () => cli.request("i", {}),
    resolveUser: (username: string, host?: string) =>
      cli.request("users/show", host ? { username, host } : { username }),
    userNotes: (
      userId: string,
      opts: { sinceId?: string; untilId?: string; limit?: number } = {},
    ) =>
      cli.request("users/notes", {
        userId,
        limit: opts.limit ?? 100,
        sinceId: opts.sinceId,
        untilId: opts.untilId,
      }),
    createNote: (params: {
      text: string;
      replyId?: string;
      visibility?: Note["visibility"];
      visibleUserIds?: string[];
    }) => cli.request("notes/create", params),
    notifications: (opts: { limit?: number; sinceId?: string; untilId?: string } = {}) =>
      cli.request("i/notifications", {
        limit: opts.limit ?? 100,
        sinceId: opts.sinceId,
        untilId: opts.untilId,
      }),
    react: (noteId: string, reaction: string) =>
      cli.request("notes/reactions/create", { noteId, reaction }),
    // renote 通知の note は renote された側 (自分のノート) なので、renote した側を引き当てるために一覧を引く。
    renotes: (noteId: string) => cli.request("notes/renotes", { noteId, limit: 20 }),
    // ---- 学習用ユーザーリスト (WebSocket の userList チャンネルの購読先) ----
    userLists: () => cli.request("users/lists/list", {}),
    userListCreate: (name: string) => cli.request("users/lists/create", { name }),
    userListMembers: (listId: string) =>
      cli.request("users/lists/get-memberships", { listId, limit: 100 }),
    userListPush: (listId: string, userId: string) =>
      cli.request("users/lists/push", { listId, userId }),
    userListPull: (listId: string, userId: string) =>
      cli.request("users/lists/pull", { listId, userId }),
    userListSetWithReplies: (listId: string, userId: string, withReplies: boolean) =>
      cli.request("users/lists/update-membership", { listId, userId, withReplies }),
  };
};

export type MisskeyClient = ReturnType<typeof createMisskeyClient>;
