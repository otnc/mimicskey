import * as Misskey from "misskey-js";
import type { MkNotification, Note } from "./misskey.js";

// WebSocket (ストリーミング) の管理。misskey-js の Stream は切断時に自動で再接続する。次の 2 つのチャンネルを購読する:
// - main: notification イベントで通知をリアルタイムに受け取る
// - userList: 学習対象ユーザーを入れた非公開リストのノートをリアルタイムに受け取る
// _connected_ イベントで再接続を検知し、切断中に取りこぼしたノート・通知の回収を促す。
export const createBotStream = (deps: {
  origin: string;
  token: string;
  listId: string;
  onNote: (note: Note) => void;
  onNotification: (n: MkNotification) => void;
  onReconnected: () => void;
}) => {
  const stream = new Misskey.Stream(deps.origin, { token: deps.token });
  const main = stream.useChannel("main");
  main.on("notification", (n) => deps.onNotification(n));
  const userList = stream.useChannel("userList", { listId: deps.listId });
  userList.on("note", (note) => deps.onNote(note));
  stream.on("_connected_", () => deps.onReconnected());
  return {
    close: () => {
      main.dispose();
      userList.dispose();
      stream.close();
    },
  };
};
