// 設定の読み込み。
// シークレット (MISSKEY_INSTANCE, MISSKEY_TOKEN, TARGET_USERS, SUDACHI_BIN) のみ .env から読む。
// それ以外は config.js (プロジェクトルート) から読み、config.custom.js があればそれで上書きする。

// config.js / config.custom.js の型定義。JSDoc で config.js から参照される。
export type FileConfig = {
  dbPath: string;
  postIntervalMinutes: number;
  postSchedule: Array<[number, number]> | null;
  learnNotesLimit: number;
  includeReplies: boolean;
  learnVisibilities: string[];
  maxNoteLength: number;
  targetNoteLength: number;
  maxSentences: number;
  shortNoteProbability: number;
  excludeWords: string[];
  postVisibility: "public" | "home" | "followers";
  replyEnabled: boolean;
  renoteEmoji: string;
  sudachiMode: "A" | "B" | "C";
  sudachiDictType: "small" | "core" | "full" | null;
};

export type TargetUser = { username: string; host?: string };

// 下流モジュールが使う Config。FileConfig の変換済み版 + env 由来のフィールドを含む。
export type Config = {
  misskeyInstance: string;
  misskeyToken: string;
  targetUsers: TargetUser[];
  sudachiBin: string;
  dbPath: string;
  /** postIntervalMinutes を ms に変換したもの。 */
  postIntervalMs: number;
  postSchedule: Array<[number, number]> | null;
  learnNotesLimit: number;
  includeReplies: boolean;
  /** string[] から変換済みの Set。 */
  learnVisibilities: ReadonlySet<string>;
  maxNoteLength: number;
  targetNoteLength: number;
  maxSentences: number;
  shortNoteProbability: number;
  excludeWords: string[];
  postVisibility: "public" | "home" | "followers";
  replyEnabled: boolean;
  renoteEmoji: string;
  sudachiMode: "A" | "B" | "C";
  sudachiDictType: "small" | "core" | "full" | undefined;
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`必須の環境変数 ${name} が設定されていません`);
  return value;
};

// "user, user@remote.example" 形式をパースする。
export const parseTargetUsers = (raw: string): TargetUser[] =>
  raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split("@");
      if (parts.length === 1) return { username: entry };
      if (parts.length === 2) return { username: parts[0], host: parts[1] };
      throw new Error(`TARGET_USERS の書式が不正です: ${entry}`);
    });

const validateFileConfig = (raw: unknown): FileConfig => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config.js の default export がオブジェクトではありません");
  }
  const c = raw as Record<string, unknown>;

  const str = (k: string, fallback: string): string =>
    typeof c[k] === "string" ? (c[k] as string) : fallback;
  const num = (k: string, fallback: number): number =>
    typeof c[k] === "number" ? (c[k] as number) : fallback;
  const bool = (k: string, fallback: boolean): boolean =>
    typeof c[k] === "boolean" ? (c[k] as boolean) : fallback;
  const strArr = (k: string, fallback: string[]): string[] =>
    Array.isArray(c[k]) ? (c[k] as string[]) : fallback;

  const postVisibility = str("postVisibility", "public");
  if (postVisibility !== "public" && postVisibility !== "home" && postVisibility !== "followers") {
    throw new Error(
      `config.js: postVisibility は "public" / "home" / "followers" のどれかです: ${postVisibility}`,
    );
  }

  const sudachiMode = str("sudachiMode", "C");
  if (sudachiMode !== "A" && sudachiMode !== "B" && sudachiMode !== "C") {
    throw new Error(`config.js: sudachiMode は "A" / "B" / "C" のどれかです: ${sudachiMode}`);
  }

  const sudachiDictTypeRaw = c["sudachiDictType"];
  const sudachiDictType: FileConfig["sudachiDictType"] =
    sudachiDictTypeRaw === "small" || sudachiDictTypeRaw === "core" || sudachiDictTypeRaw === "full"
      ? sudachiDictTypeRaw
      : null;

  const shortNoteProbability = num("shortNoteProbability", 0.3);
  if (shortNoteProbability < 0 || shortNoteProbability > 1) {
    throw new Error(`config.js: shortNoteProbability は 0〜1 の値です: ${shortNoteProbability}`);
  }

  let postSchedule: Array<[number, number]> | null = null;
  if (Array.isArray(c["postSchedule"])) {
    postSchedule = (c["postSchedule"] as unknown[]).map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new Error("config.js: postSchedule の要素は [hour, minute] 形式です");
      }
      const h = Number(entry[0]);
      const m = Number(entry[1]);
      if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) {
        throw new Error(`config.js: postSchedule の時刻が不正です: [${h}, ${m}]`);
      }
      return [h, m] as [number, number];
    });
  }

  const learnVisibilities = strArr("learnVisibilities", [
    "public",
    "home",
    "followers",
    "specified",
  ]);
  const validVis = new Set(["public", "home", "followers", "specified"]);
  for (const v of learnVisibilities) {
    if (!validVis.has(v)) throw new Error(`config.js: learnVisibilities に不正な値: ${v}`);
  }

  return {
    dbPath: str("dbPath", "data/bot.db"),
    postIntervalMinutes: num("postIntervalMinutes", 60),
    postSchedule,
    learnNotesLimit: num("learnNotesLimit", 5000),
    includeReplies: bool("includeReplies", true),
    learnVisibilities,
    maxNoteLength: num("maxNoteLength", 140),
    targetNoteLength: num("targetNoteLength", 40),
    maxSentences: num("maxSentences", 2),
    shortNoteProbability,
    excludeWords: strArr("excludeWords", []),
    postVisibility,
    replyEnabled: bool("replyEnabled", true),
    renoteEmoji: str("renoteEmoji", ":thinking:"),
    sudachiMode,
    sudachiDictType,
  };
};

// config.js (ベース) と config.custom.js (上書き) を dynamic import でマージする。
const loadFileConfig = async (): Promise<FileConfig> => {
  const baseUrl = new URL("../config.js", import.meta.url);
  const customUrl = new URL("../config.custom.js", import.meta.url);

  const baseMod = (await import(baseUrl.href)) as { default: unknown };
  const base = validateFileConfig(baseMod.default);

  try {
    const customMod = (await import(customUrl.href)) as { default: unknown };
    // custom のキーで base を上書きしてから再バリデーションする。
    return validateFileConfig({ ...base, ...(customMod.default as object) });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // config.custom.js が存在しない場合は無視する。
    if (code === "ENOENT" || code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return base;
    }
    throw err;
  }
};

export const loadConfig = async (): Promise<Config> => {
  const file = await loadFileConfig();

  return {
    misskeyInstance: requireEnv("MISSKEY_INSTANCE").replace(/\/+$/, ""),
    misskeyToken: requireEnv("MISSKEY_TOKEN"),
    targetUsers: parseTargetUsers(requireEnv("TARGET_USERS")),
    sudachiBin: process.env["SUDACHI_BIN"] ?? "sudachipy",
    dbPath: file.dbPath,
    postIntervalMs: file.postIntervalMinutes * 60_000,
    postSchedule: file.postSchedule,
    learnNotesLimit: file.learnNotesLimit,
    includeReplies: file.includeReplies,
    learnVisibilities: new Set(file.learnVisibilities),
    maxNoteLength: file.maxNoteLength,
    targetNoteLength: file.targetNoteLength,
    maxSentences: file.maxSentences,
    shortNoteProbability: file.shortNoteProbability,
    excludeWords: file.excludeWords,
    postVisibility: file.postVisibility,
    replyEnabled: file.replyEnabled,
    renoteEmoji: file.renoteEmoji,
    sudachiMode: file.sudachiMode,
    sudachiDictType: file.sudachiDictType ?? undefined,
  };
};
