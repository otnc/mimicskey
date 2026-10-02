import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { MisskeyClient, MkNotification, Note } from "./misskey.js";
import type { Tokenizer } from "./tokenizer.js";
import type { TwitterClient } from "./twitter.js";
import type { MarkovChain } from "./markov.js";
import { createMarkovChain } from "./markov.js";
import QuickLRU from "quick-lru";
import { cleanNoteText, splitSentences } from "./text.js";
import { learnNote, syncUserNotes, catchUpUserNotes } from "./misskey-sync.js";
import { resetIfLearnConfigChanged } from "./learn-reset.js";
import { syncTwitterUser } from "./twitter-sync.js";
import { fetchNotificationsSince, handleNotification, markNotificationsSeen } from "./notify.js";
import { ensureLearningList } from "./list.js";
import { createBotStream } from "./stream.js";
import { log } from "./logger.js";

// X の取得に失敗したユーザーがいたとき、通常のポーリング間隔より早く再試行するまでの待ち時間。
const TWITTER_RETRY_DELAY_MS = 5 * 60_000;

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
// ノートと通知の取りこぼしは、接続時 (_connected_) にカーソルからの差分取得で回収する。
// X (Twitter) にはストリーミングがないため、学習対象のツイートだけは twitter.pollIntervalMinutes ごとのポーリングで取り込む。
// 初回起動時だけノートのバックフィルを行う (npm run learn でも手動で取得できる)。
// チェーンの再構築 (SudachiPy のバッチ呼び出し 1 回) は、新規ノートが保存されたときだけ行う。
export const createBot = (deps: {
  cfg: Config;
  store: Store;
  client: MisskeyClient;
  twitter: TwitterClient;
  tokenizer: Tokenizer;
}) => {
  const { cfg, store, client, twitter, tokenizer } = deps;

  // closure の中に閉じ込めた可変状態。
  let chain: MarkovChain | null = null;
  let chainDirty = true;
  let stream: ReturnType<typeof createBotStream> | null = null;
  let postTimer: ReturnType<typeof setTimeout> | null = null;
  let twitterTimer: ReturnType<typeof setTimeout> | null = null;
  let botUserId = "";

  // stop() で中断を伝える。X の取得は fetch ごと中断し、Misskey の同期はページの区切りで止める。
  const abort = new AbortController();
  const { signal } = abort;

  // 走っている取得・投稿・回収の処理。stop() は DB を閉じる前にこれらが終わるのを待つ。
  // 渡す Promise は reject しないもの (catch 済み) に限る。
  const inFlight = new Set<Promise<void>>();
  const track = (task: Promise<void>) => {
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  // 中断による失敗 (Ctrl+C など) はエラーとして記録しない。
  const logUnlessStopping = (message: string) => (err: unknown) => {
    if (!signal.aborted) log.error(message, err);
  };

  // 処理済み通知 ID の重複排除 (WebSocket と取りこぼし回収の両方から来る)。古いものから上限 500 件で追い出す。
  const seenIds = new QuickLRU<string, true>({ maxSize: 500 });

  const buildChain = async () => {
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
    log.info(
      `チェーン再構築: ${texts.length} ノート -> ${sentences.length} 文 (${Date.now() - startedAt}ms)`,
    );
    return chain;
  };

  // チェーンを構築し直す。構築中に届いたノートで再び dirty になれるよう、読み込む前にフラグを下ろす。
  const rebuildChain = async () => {
    chainDirty = false;
    try {
      return await buildChain();
    } catch (err) {
      chainDirty = true;
      throw err;
    }
  };

  // チェーンを返す (済みで新規ノートがなければ使い回す)。投稿と返信から同時に呼ばれても構築は 1 回だけ走る。
  let building: Promise<MarkovChain | null> | null = null;
  const ensureChain = () => {
    if (chain && !chainDirty) return Promise.resolve(chain);
    building ??= rebuildChain().finally(() => {
      building = null;
    });
    return building;
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
    if (signal.aborted) return;
    if (postTimer) clearTimeout(postTimer);
    const nextAt = (() => {
      if (cfg.postSchedule) return getNextScheduleMs(cfg.postSchedule);
      // インターバルモード: lastPostAt から N 分後ではなく、次の JST XX:00 境界に合わせる (規則正しい時刻で投稿するため)。
      return getNextIntervalMs(cfg.postIntervalMs);
    })();
    const delay = Math.min(Math.max(nextAt - Date.now(), 0), MAX_TIMEOUT_MS);
    postTimer = setTimeout(() => {
      track(postOnce().catch(logUnlessStopping("投稿に失敗しました")).finally(scheduleNextPost));
    }, delay);
  };

  // X の学習対象ユーザーのツイートを取り込む。1 ユーザーの失敗 (FxTwitter の障害など) で他のユーザーや Bot 本体を止めない。
  // 失敗したユーザーは進捗が保存されているので、次の試行で続きから取る。戻り値は全ユーザーの取得に成功したかどうか。
  const syncTwitterUsers = async () => {
    let allSucceeded = true;
    for (const user of cfg.twitter.targetUsers) {
      if (signal.aborted) return false;
      try {
        if ((await syncTwitterUser(twitter, store, user, cfg, signal)) > 0) chainDirty = true;
      } catch (err) {
        if (signal.aborted) return false;
        allSucceeded = false;
        log.error(`@${user.screenName} (X) のツイート取得に失敗しました`, err);
      }
    }
    return allSucceeded;
  };

  // X のツイートを取り込み、次の取り込みをスケジュールする。失敗したユーザーがいれば早めに再試行する。
  const pollTwitter = () => {
    track(
      (async () => {
        const allSucceeded = await syncTwitterUsers();
        if (signal.aborted) return;
        const delay = allSucceeded
          ? cfg.twitter.pollIntervalMs
          : Math.min(TWITTER_RETRY_DELAY_MS, cfg.twitter.pollIntervalMs);
        if (!allSucceeded) {
          log.warn(
            `X の取得に失敗したユーザーがいるため、${delay / 60_000} 分後に続きから再試行します`,
          );
        }
        twitterTimer = setTimeout(pollTwitter, delay);
      })().catch(logUnlessStopping("X のツイート取り込みに失敗しました")),
    );
  };

  // 通知 1 件の処理本体。
  // カーソルは処理の成否や返信の有無にかかわらず進める (失敗した通知も seenIds に入るので、どのみち再処理はしない)。
  // 回収とリアルタイム受信が前後しても巻き戻らないよう、新しい ID のときだけ進める。
  const processOne = async (n: MkNotification) => {
    if (signal.aborted || seenIds.has(n.id)) return;
    seenIds.set(n.id, true);
    const cursor = store.getState("lastNotificationId");
    if (!cursor || n.id > cursor) store.setState("lastNotificationId", n.id);
    if (!cfg.replyEnabled) return;
    const active = await ensureChain();
    if (!active) return;
    await handleNotification({ client, chain: active, tokenizer, cfg, botUserId }, n);
  };

  // 通知の処理は直列に実行する (レート制限の判定をすり抜けさせないため)。
  let queue: Promise<void> = Promise.resolve();
  const processNotification = (n: MkNotification) => {
    queue = queue
      .then(() => processOne(n))
      .catch(logUnlessStopping(`通知 ${n.id} の処理に失敗しました`));
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

  // 接続時 (初回を含む): 切れていた間に取りこぼしたノートと通知をカーソルから回収する。
  const onReconnected = () => {
    track(
      (async () => {
        for (const user of cfg.misskey.targetUsers) {
          if ((await catchUpUserNotes(client, store, user, cfg, signal)) > 0) chainDirty = true;
        }
        await catchUpNotifications();
      })().catch(logUnlessStopping("再接続時の回収に失敗しました")),
    );
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
    for (const user of cfg.misskey.targetUsers) {
      await syncUserNotes(client, store, user, cfg, signal);
    }

    // 学習用リストを用意してから WebSocket に繋ぐ。
    const { listId } = await ensureLearningList({ client, store, cfg });
    await markNotificationsSeen(client, store);
    // 起動中に stop() されていたら、接続もタイマーも作らずに終える (作るとプロセスが終了しなくなる)。
    signal.throwIfAborted();
    stream = createBotStream({
      origin: cfg.misskeyInstance,
      token: cfg.misskeyToken,
      listId,
      onNote,
      onNotification: processNotification,
      onReconnected,
    });

    // X のバックフィルは件数が多いと時間がかかるので、WebSocket に繋いだ後にバックグラウンドで進める。
    if (cfg.twitter.targetUsers.length > 0) pollTwitter();

    scheduleNextPost();
    const scheduleDesc = cfg.postSchedule
      ? `スケジュール ${cfg.postSchedule.map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`).join(", ")}`
      : `JST ${cfg.postIntervalMs / 60_000} 分ごと (XX:00 境界)`;
    log.info(`開始: ノート・通知は WebSocket で受信、投稿は ${scheduleDesc}`);
  };

  // 新しい処理を止め、走っている処理が終わるのを待つ。呼び出し側はこの後で DB を閉じてよい。
  const stop = async () => {
    abort.abort();
    if (postTimer) clearTimeout(postTimer);
    if (twitterTimer) clearTimeout(twitterTimer);
    stream?.close();
    await Promise.all([...inFlight, queue]);
  };

  return { run, stop };
};
