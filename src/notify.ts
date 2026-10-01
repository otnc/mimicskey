import type { Config } from "./config.js";
import type { MarkovChain } from "./markov.js";
import type { MisskeyClient, MkNotification, Note } from "./misskey.js";
import type { Store } from "./db.js";
import type { Tokenizer } from "./tokenizer.js";
import { cleanNoteText, splitSentences } from "./text.js";
import { log } from "./logger.js";

// 返信の公開範囲は相手のノートを超えない。specified には直接ノートで返す。
// リテラルが string に拡大されるので、返り値の型だけ明示する。
const visibilityFor = (
  note: Note,
): { visibility: Note["visibility"]; visibleUserIds?: string[] } => {
  if (note.visibility === "specified") {
    return { visibility: "specified", visibleUserIds: [note.userId] };
  }
  if (note.visibility === "followers") {
    return { visibility: "home" };
  }
  return { visibility: note.visibility };
};

// 返信は、相手のノートから取った名詞をシードにして生成する。
// 相手が実際に使った語から文を始めることで、話題に沿った返信になる。
const generateReply = async (chain: MarkovChain, tokenizer: Tokenizer, note: Note, cfg: Config) => {
  const seed = await (async () => {
    const cleaned = cleanNoteText(note.text ?? "");
    if (!cleaned) return undefined;
    const sentences = splitSentences(cleaned);
    if (sentences.length === 0) return undefined;
    const tokens = (await tokenizer.tokenizeBatch(sentences)).flat();
    // チェーンが知っている語の中で、いちばん長い名詞を選ぶ。
    const nouns = tokens
      .filter((t) => t.pos[0] === "名詞" && t.normalized.length >= 2)
      .sort((a, b) => b.normalized.length - a.normalized.length);
    return nouns.find((t) => chain.hasSeed(t.normalized))?.normalized;
  })();

  return chain.generateNote({
    seed,
    maxNoteChars: cfg.maxNoteLength,
    maxSentences: 2,
    targetChars: 30,
  });
};

// 起動時に呼ぶ: 既存の通知を見済みにする。古いメンションに一斉に返信しないためで、以降の通知は WebSocket でリアルタイムに、再接続時には取りこぼし回収で受け取る。
export const markNotificationsSeen = async (client: MisskeyClient, store: Store) => {
  const latest = await client.notifications({ limit: 1 });
  if (latest.length > 0) store.setState("lastNotificationId", latest[0].id);
};

// カーソルより新しい通知をすべて取得し、古い方から並べて返す。
// WebSocket が切れている間に取りこぼした通知の回収に使う。
export const fetchNotificationsSince = async (client: MisskeyClient, sinceId: string) => {
  const all: MkNotification[] = [];
  let untilId: string | undefined;
  for (;;) {
    const page = await client.notifications({ sinceId, untilId, limit: 100 });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < 100) break;
    untilId = page[page.length - 1].id;
  }
  return all.reverse();
};

// 通知 1 件に反応する。mention / reply / quote には生成文で返信し、renote には renote したノートにリアクションを付ける。
// renote 通知の note は renote された側 (自分のノート) なので、notes/renotes で renote した側を引き当ててから反応する。
export const handleNotification = async (
  deps: {
    client: MisskeyClient;
    chain: MarkovChain;
    tokenizer: Tokenizer;
    cfg: Config;
    botUserId: string;
  },
  n: MkNotification,
) => {
  const { client, chain, tokenizer, cfg, botUserId } = deps;

  if (n.type === "mention" || n.type === "reply" || n.type === "quote") {
    if (!n.note || n.note.userId === botUserId) return;
    const text = await generateReply(chain, tokenizer, n.note, cfg);
    if (!text) return;
    await client.createNote({ text, replyId: n.note.id, ...visibilityFor(n.note) });
    log.info(`${n.type} ${n.note.id} に返信: ${text}`);
    return;
  }

  if (n.type === "renote") {
    if (!n.note) return;
    const renote = (await client.renotes(n.note.id)).find((r) => r.userId !== botUserId);
    if (!renote) return;
    try {
      await client.react(renote.id, cfg.renoteEmoji);
      log.info(`renote ${renote.id} にリアクション`);
    } catch (err) {
      // 二重リアクションやインスタンス側の制限は通常の動作範囲なので警告だけ。
      log.warn(`renote ${renote.id} へのリアクションに失敗しました: ${String(err)}`);
    }
  }
};
