import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { MisskeyClient, MkNotification, Note } from "./misskey.js";
import type { Tokenizer } from "./tokenizer.js";
import type { MarkovChain } from "./markov.js";
import { createMarkovChain } from "./markov.js";
import { cleanNoteText, splitSentences } from "./text.js";
import { learnNote, syncUserNotes, resetIfLearnConfigChanged } from "./sync.js";
import { fetchNotificationsSince, handleNotification, markNotificationsSeen } from "./notify.js";
import { ensureLearningList } from "./list.js";
import { createBotStream } from "./stream.js";
import { log } from "./logger.js";

// setTimeout の上限 (約 24.8 日)。これを超える待ちは分割する。
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// 投稿時刻の計算はすべて JST (UTC+9) 基準。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// POST_SCHEDULE が設定されているとき、次の予定時刻 (UTC ms) を返す。
// schedule の時刻は JST で解釈する。
const getNextScheduleMs = (schedule: Array<[number, number]>): number => {
  const now = Date.now();
  // JST での現在日付を UTC メソッドで扱う (ローカルタイムゾーン非依存)。
  const jstNow = now + JST_OFFSET_MS;
  const jstDate = new Date(jstNow);
  const jstMidnight = Date.UTC(
    jstDate.getUTCFullYear(),
    jstDate.getUTCMonth(),
    jstDate.getUTCDate(),
  );
  const candidates = schedule.map(([h, m]) => {
    let jstTarget = jstMidnight + (h * 60 + m) * 60_000;
    if (jstTarget <= jstNow) jstTarget += 24 * 60 * 60_000;
    return jstTarget - JST_OFFSET_MS; // UTC に戻す
  });
  return Math.min(...candidates);
};

// インターバル投稿のとき、次の JST XX:00 境界 (UTC ms) を返す。
// 例: 60 分間隔なら 00:00, 01:00, 02:00, … JST のどれか次の時刻。
const getNextIntervalMs = (intervalMs: number): number => {
  const jstNow = Date.now() + JST_OFFSET_MS;
  const next = Math.ceil(jstNow / intervalMs) * intervalMs;
  return next - JST_OFFSET_MS;
};

// Bot 本体。定期ポーリングは行わず、すべて WebSocket 駆動で動く:
// - userList チャンネル: 学習対象ユーザーを入れた非公開リストのノートをリアルタイムに受信して保存する
// - main チャンネル: 通知をリアルタイムに受信し、返信・リアクションする
// - 投稿: POST_SCHEDULE が設定されているときは JST 固定時刻、未設定のときは JST XX:00 境界のインターバルで投稿する
// ノートと通知の取りこぼしは、再接続時 (_connected_) にカーソルからの差分取得で回収する。
// 初回起動時だけノートのバックフィルを行う。
// チェーンの再構築 (SudachiPy のバッチ呼び出し 1 回) は、新規ノートが保存されたときだけ行う。
export const createBot = (deps: {
  cfg: Config;
  store: Store;
  client: MisskeyClient;
  tokenizer: Tokenizer;
}) => {
  const { cfg, store, client, tokenizer } = deps;

  // closure の中に閉じ込めた可変状態。
  let chain: MarkovChain | null = null;
  let chainDirty = true;
  let stream: ReturnType<typeof createBotStream> | null = null;
  let postTimer: ReturnType<typeof setTimeout> | null = null;
  let botUserId = "";

  // 処理済み通知 ID の重複排除 (WebSocket と取りこぼし回収の両方から来る)。
  const seenIds = new Set<string>();
  const rememberSeen = (id: string) => {
    seenIds.add(id);
    if (seenIds.size > 500) {
      const oldest = seenIds.values().next().value;
      if (oldest !== undefined) seenIds.delete(oldest);
    }
  };

  // チェーンを構築する (済みで新規ノートがなければ使い回す)。
  const ensureChain = async () => {
    if (chain && !chainDirty) return chain;

    const texts = store.loadRecentTexts(cfg.learnNotesLimit);
    if (texts.length === 0) {
      log.warn("まだ学習するノートがありません");
      return null;
    }
    const sentences: string[] = [];
    for (const text of texts) {
      for (const s of splitSentences(cleanNoteText(text))) sentences.push(s);
    }
    if (sentences.length === 0) return null;

    const startedAt = Date.now();
    const tokenized = await tokenizer.tokenizeBatch(sentences);
    const next = createMarkovChain();
    next.build(tokenized);
    chain = next;
    chainDirty = false;
    log.info(
      `チェーン再構築: ${texts.length} ノート -> ${sentences.length} 文 (${Date.now() - startedAt}ms)`,
    );
    return chain;
  };

  // 1 回投稿する。生成に失敗しても lastPostAt は更新する
  // (更新しないと次のスケジュールが即時になり、投稿試行が連発する)。
  const postOnce = async () => {
    const markPosted = () => store.setState("lastPostAt", String(Date.now()));

    const active = await ensureChain();
    if (!active || active.isEmpty) {
      log.warn("チェーンが空のため投稿をスキップします");
      markPosted();
      return;
    }

    // SHORT_NOTE_PROBABILITY の確率で 1 文だけの短いノートを生成する。
    const isShortNote = Math.random() < cfg.shortNoteProbability;
    const text = active.generateNote({
      maxNoteChars: cfg.maxNoteLength,
      targetChars: isShortNote ? 0 : cfg.targetNoteLength,
      maxSentences: isShortNote ? 1 : cfg.maxSentences,
    });
    if (!text) {
      log.warn("文の生成に失敗したため投稿をスキップします");
      markPosted();
      return;
    }

    await client.createNote({ text, visibility: cfg.postVisibility });
    markPosted();
    log.info(`投稿しました: ${text}`);
  };

  // 次の投稿時刻まで待って投稿し、その次をスケジュールする。
  // POST_SCHEDULE が設定されているときは固定時刻で、未設定のときはインターバルで動く。
  const scheduleNextPost = () => {
    if (postTimer) clearTimeout(postTimer);
    const nextAt = (() => {
      if (cfg.postSchedule) return getNextScheduleMs(cfg.postSchedule);
      // インターバルモード: lastPostAt から N 分後ではなく、
      // 次の JST XX:00 境界に合わせる (規則正しい時刻で投稿するため)。
      return getNextIntervalMs(cfg.postIntervalMs);
    })();
    const delay = Math.min(Math.max(nextAt - Date.now(), 0), MAX_TIMEOUT_MS);
    postTimer = setTimeout(() => {
      void postOnce()
        .catch((err) => log.error("投稿に失敗しました", err))
        .finally(scheduleNextPost);
    }, delay);
  };

  // 通知 1 件の処理本体。処理したらカーソルを進める。
  const processOne = async (n: MkNotification) => {
    if (seenIds.has(n.id)) return;
    rememberSeen(n.id);
    if (!cfg.replyEnabled) return;
    const active = await ensureChain();
    if (!active) return;
    await handleNotification({ client, chain: active, tokenizer, cfg, botUserId }, n);
    store.setState("lastNotificationId", n.id);
  };

  // 通知の処理は直列に実行する (レート制限の判定をすり抜けさせないため)。
  let queue: Promise<void> = Promise.resolve();
  const processNotification = (n: MkNotification) => {
    queue = queue
      .then(() => processOne(n))
      .catch((err) => log.error(`通知 ${n.id} の処理に失敗しました`, err));
  };

  // WebSocket が切れている間に取りこぼした通知を回収する。
  const catchUpNotifications = async () => {
    const since = store.getState("lastNotificationId");
    if (!since) return;
    const missed = await fetchNotificationsSince(client, since);
    for (const n of missed) processNotification(n);
    if (missed.length > 0) log.info(`取りこぼした通知を ${missed.length} 件回収しました`);
  };

  // WebSocket で受信した学習対象ユーザーのノートを保存する。
  const onNote = (note: Note) => {
    if (learnNote(store, note, cfg)) chainDirty = true;
  };

  // 再接続時: 切断中に取りこぼしたノートと通知をカーソルから回収する。
  const onReconnected = () => {
    void (async () => {
      for (const user of cfg.targetUsers) {
        await syncUserNotes(client, store, user, cfg);
      }
      await catchUpNotifications();
    })().catch((err) => log.error("再接続時の回収に失敗しました", err));
  };

  const run = async () => {
    // 起動時に SudachiPy が動くことを確認しておく (fail-fast)。
    const probe = await tokenizer.tokenizeBatch(["動作確認です。"]);
    log.info(
      `トークナイザ動作確認: ${probe
        .flat()
        .map((t) => t.surface)
        .join(" ")}`,
    );

    const me = await client.me();
    botUserId = me.id;
    log.info(`Bot アカウント: @${me.username} (${cfg.misskeyInstance})`);

    // 学習設定が変わっていたら既存データをリセットする (バックフィルは直後の syncUserNotes で行う)。
    resetIfLearnConfigChanged(store, cfg);

    // 初回はバックフィル、2 回目以降は前回からの差分。
    // この中で対象ユーザーの ID も解決して state に置く。
    for (const user of cfg.targetUsers) {
      await syncUserNotes(client, store, user, cfg);
    }

    // 学習用リストを用意してから WebSocket に繋ぐ。
    const { listId } = await ensureLearningList({ client, store, cfg });
    await markNotificationsSeen(client, store);
    stream = createBotStream({
      origin: cfg.misskeyInstance,
      token: cfg.misskeyToken,
      listId,
      onNote,
      onNotification: processNotification,
      onReconnected,
    });

    scheduleNextPost();
    const scheduleDesc = cfg.postSchedule
      ? `スケジュール ${cfg.postSchedule.map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`).join(", ")}`
      : `JST ${cfg.postIntervalMs / 60_000} 分ごと (XX:00 境界)`;
    log.info(`開始: ノート・通知は WebSocket で受信、投稿は ${scheduleDesc}`);
  };

  const stop = () => {
    if (postTimer) clearTimeout(postTimer);
    stream?.close();
  };

  return { run, stop };
};
