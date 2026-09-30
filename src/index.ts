import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { createStore } from "./db.js";
import { createMisskeyClient } from "./misskey.js";
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
const bot = createBot({ cfg, store, client, tokenizer });

const shutdown = () => {
  log.info("シャットダウンします");
  bot.stop();
  store.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bot.run().catch((err) => {
  log.error("起動に失敗しました", err);
  process.exitCode = 1;
});
