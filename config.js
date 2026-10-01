// デフォルト設定。カスタマイズしたい場合は config.custom.js を作成し、変えたいキーだけ上書きしてください (config.custom.js は .gitignore 済み)。

/** @type {import('./src/config.js').FileConfig} */
export default {
  // SQLite のファイルパス
  dbPath: "data/bot.db",

  // ---- 投稿スケジュール ----
  // postSchedule が null のときは postIntervalMinutes ごとに JST XX:00 境界で投稿する。
  // postSchedule を設定すると postIntervalMinutes は無視される。
  // 例: [[0, 0], [6, 0], [12, 0], [18, 0]] → JST 0:00 / 6:00 / 12:00 / 18:00
  postIntervalMinutes: 60,
  postSchedule: null,

  // ---- 学習設定 ----
  // 学習に使う最大ノート数 (新しい方から)
  learnNotesLimit: 5000,
  // 対象ユーザーのリプライも学習するか
  // (リプライは文脈依存の断片が多いので、コーパスが荒れる場合は false にする)
  includeReplies: true,
  // 学習するノートの公開範囲: "public" | "home" | "followers" | "specified"
  learnVisibilities: ["public", "home", "followers", "specified"],

  // ---- 生成設定 ----
  // 生成ノートの最大文字数 (硬い制限。この長さを超える文は採用されない)
  maxNoteLength: 140,
  // 目標文字数。試行の中でこの長さに最も近い文を採用する。
  // 1 文目がこの長さに満たないとき maxSentences の上限まで文を継ぎ足す。
  targetNoteLength: 40,
  // 1 ノートに入れる最大文数
  maxSentences: 2,
  // この確率 (0〜1) で 1 文だけの短いノートを生成する
  shortNoteProbability: 0.3,

  // ---- 除外ワード ----
  // この配列に含まれる語が生成文に含まれていた場合、その文は棄却する。
  // 例: ["foo", "bar"]
  excludeWords: [],

  // ---- 投稿・返信 ----
  // 定期投稿の公開範囲: "public" | "home" | "followers"
  postVisibility: "public",
  // 返信を有効にするか
  replyEnabled: true,
  // リノート時のリアクション絵文字
  renoteEmoji: ":thinking:",

  // ---- SudachiPy (形態素解析) ----
  // 分割単位: "A" (短単位) | "B" (中単位) | "C" (固有表現単位)
  // A: 細かく分割 → 遷移が濃いが再結合が荒れやすい
  // B: 複合語をある程度まとめる → 遷移と品質のバランスが良い
  // C: 最大単位にまとめる → 固有名詞が壊れないが遷移が希薄
  sudachiMode: "C",
  // 辞書の語彙量: "small" | "core" | "full" | null
  // null にすると sudachipy のデフォルト辞書を使う
  // small: 基本語彙のみ / core: 一般固有名詞追加 / full: 雑多な固有名詞まで収録
  sudachiDictType: null,
};
