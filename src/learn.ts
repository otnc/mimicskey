// 学習データを明示的に取得・クリアするコマンド。
// Bot の起動時 (npm run dev / start) でも同じ同期が走るが、Bot を止めずに
// 再取得やクリアからのやり直しをしたいときにこちらを使う。
//
// 使い方:
//   npm run learn             # 未取得のユーザーはバックフィル、取得済みは差分取得
//   npm run learn -- --clear  # 学習データをクリアしてバックフィルし直す
//
// 学習設定 (MISSKEY_TARGET_USERS / TWITTER_TARGET_USERS / 学習・除外ワードの設定) が前回から変わっているときは
// 自動でクリアして取得し直す。Misskey への投稿は行わない。
// Bot を起動したまま実行しても DB への書き込みは問題ないが、Bot がメモリに持つ
// チェーンは新しいデータを反映しないため、取得後は Bot を再起動する。

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { createStore } from "./db.js";
import { createMisskeyClient } from "./misskey.js";
import { resetIfLearnConfigChanged, resetLearningData } from "./learn-reset.js";
import { syncUserNotes } from "./misskey-sync.js";
import { createTwitterClient } from "./twitter.js";
import { getOrCreateInstanceId } from "./instance-id.js";
import { syncTwitterUser } from "./twitter-sync.js";
import { log } from "./logger.js";

const clear = process.argv.slice(2).includes("--clear");

const cfg = await loadConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const store = createStore(cfg.dbPath);
const client = createMisskeyClient(cfg.misskeyInstance, cfg.misskeyToken);
const twitter = createTwitterClient(getOrCreateInstanceId(store));
// learn コマンドは Ctrl+C でそのまま終了する (X のバックフィルの進捗はページごとに保存済みで、次回は続きから取る)。
const { signal } = new AbortController();

try {
  if (clear) {
    resetLearningData(store, cfg);
    log.info("学習データをクリアしました");
  } else {
    resetIfLearnConfigChanged(store, cfg);
  }
  for (const user of cfg.misskey.targetUsers) {
    await syncUserNotes(client, store, user, cfg, signal);
  }
  for (const user of cfg.twitter.targetUsers) {
    await syncTwitterUser(twitter, store, user, cfg, signal);
  }
  log.info(`学習データ: ${store.countNotes()} ノート`);
} catch (err) {
  log.error("学習データの取得に失敗しました", err);
  process.exitCode = 1;
} finally {
  store.close();
}
