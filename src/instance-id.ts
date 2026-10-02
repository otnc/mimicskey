import { v7 as uuidv7 } from "uuid";
import type { Store } from "./db.js";

// この Bot の設置ごとに一意な ID。初回に UUIDv7 を生成して state に保存し、以降は同じ値を返す。
// 外部 API への User-Agent に入れて、フォーク先を含む設置ごとの呼び出し元を識別できるようにする。
export const getOrCreateInstanceId = (store: Store) => {
  const stored = store.getState("instanceId");
  if (stored) return stored;
  const id = uuidv7();
  store.setState("instanceId", id);
  return id;
};
