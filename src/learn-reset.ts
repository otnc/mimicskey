import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { log } from "./logger.js";

// 学習に影響する設定のフィンガープリントを返す。
// これが変わったとき、学習データをリセットして再取得する。
const learnConfigFingerprint = (cfg: Config) =>
  JSON.stringify({
    includeReplies: cfg.includeReplies,
    misskey: {
      excludeWords: [...cfg.misskey.excludeWords].sort(),
      learnVisibilities: [...cfg.misskey.learnVisibilities].sort(),
      targetUsers: cfg.misskey.targetUsers
        .map((u) => `${u.host ? `${u.username}@${u.host}` : u.username}:${u.sinceMs ?? ""}`)
        .sort(),
    },
    twitter: {
      excludeWords: [...cfg.twitter.excludeWords].sort(),
      targetUsers: cfg.twitter.targetUsers.map((u) => `${u.screenName}:${u.sinceMs ?? ""}`).sort(),
    },
  });

// 学習データ (ノートと同期カーソル) を無条件にクリアし、フィンガープリントを更新する。
// uid:* (ユーザー ID キャッシュ) と lastPostAt は残す。
export const resetLearningData = (store: Store, cfg: Config) => {
  store.clearLearningData();
  store.setState("learnConfigFingerprint", learnConfigFingerprint(cfg));
};

// 学習設定が変わっていたら学習データをクリアする。戻り値はクリアしたかどうか。
export const resetIfLearnConfigChanged = (store: Store, cfg: Config): boolean => {
  if (store.getState("learnConfigFingerprint") === learnConfigFingerprint(cfg)) return false;
  resetLearningData(store, cfg);
  log.info("学習設定が変更されたためデータをリセットします (バックフィルを実行)");
  return true;
};
