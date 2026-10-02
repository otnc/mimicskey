import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { createStore } from "./db.js";
import { createMisskeyClient } from "./misskey.js";
import { createTwitterClient } from "./twitter.js";
import { getOrCreateInstanceId } from "./instance-id.js";
import { createTokenizer } from "./tokenizer.js";
import { createBot } from "./bot.js";
import { log } from "./logger.js";

const cfg = await loadConfig();

mkdirSync(dirname(cfg.dbPath), { recursive: true });
const store = createStore(cfg.dbPath);
const client = createMisskeyClient(cfg.misskeyInstance, cfg.misskeyToken);
const tokenizer = createTokenizer({
  bin: cfg.sudachiBin,
  mode: cfg.sudachiMode,
  dictType: cfg.sudachiDictType,
});
const bot = createBot({
  cfg,
  store,
  client,
  twitter: createTwitterClient(getOrCreateInstanceId(store)),
  tokenizer,
});

let stopping = false;

// 起動中に止められた場合の中断は失敗として扱わない。
const running = bot.run().catch((err: unknown) => {
  if (stopping) return;
  log.error("起動に失敗しました", err);
  process.exitCode = 1;
});

// 走っている処理 (起動処理を含む) が終わってから DB を閉じる。閉じた DB に書き込んで失敗ログが出るのを防ぐ。
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  log.info("シャットダウンします");
  void bot
    .stop()
    .then(() => running)
    .finally(() => store.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
