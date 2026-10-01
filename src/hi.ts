// Misskey への投稿なしにマルコフ連鎖で文を生成するコマンド。
// 必要な環境変数: SUDACHI_BIN (任意)
// config.js / config.custom.js の設定を使う。

import "dotenv/config";
import { loadConfig } from "./config.js";
import { createStore } from "./db.js";
import { createTokenizer } from "./tokenizer.js";
import { createMarkovChain } from "./markov.js";
import { cleanNoteText, splitSentences } from "./text.js";

// hi コマンド専用のオプション (HI_* 環境変数で上書き可能)
const intEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

// MISSKEY_INSTANCE / MISSKEY_TOKEN / TARGET_USERS がなくても動くよう、ダミー値をセットしてから loadConfig する。
process.env["MISSKEY_INSTANCE"] ??= "https://example.com";
process.env["MISSKEY_TOKEN"] ??= "dummy";
process.env["TARGET_USERS"] ??= "dummy";

const cfg = await loadConfig();

const targetNoteLength = intEnv("HI_TARGET_CHARS", 30);
const maxNoteLength = intEnv("HI_MAX_CHARS", 60);
const maxSentences = intEnv("HI_MAX_SENTENCES", 1);
const count = intEnv("HI_COUNT", 1);

const store = createStore(cfg.dbPath);
const tokenizer = createTokenizer({
  bin: cfg.sudachiBin,
  mode: cfg.sudachiMode,
  dictType: cfg.sudachiDictType,
});

const texts = store.loadRecentTexts(cfg.learnNotesLimit);
if (texts.length === 0) {
  console.error("学習データがありません。先に npm run learn を実行してください。");
  process.exitCode = 1;
  store.close();
  process.exit();
}

const sentences: string[] = [];
for (const text of texts) {
  for (const s of splitSentences(cleanNoteText(text))) sentences.push(s);
}
if (sentences.length === 0) {
  console.error("有効な文が見つかりませんでした。");
  process.exitCode = 1;
  store.close();
  process.exit();
}

const tokenized = await tokenizer.tokenizeBatch(sentences);
const chain = createMarkovChain();
chain.build(tokenized);

if (chain.isEmpty) {
  console.error("チェーンが空です。学習データを確認してください。");
  process.exitCode = 1;
  store.close();
  process.exit();
}

for (let i = 0; i < count; i++) {
  const text = chain.generateNote({
    maxNoteChars: maxNoteLength,
    targetChars: targetNoteLength,
    maxSentences,
  });
  if (text) {
    console.log(text);
  } else {
    console.error("文の生成に失敗しました。");
    process.exitCode = 1;
  }
}

store.close();
