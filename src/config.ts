// 設定の読み込み。
// シークレット (MISSKEY_INSTANCE, MISSKEY_TOKEN, MISSKEY_TARGET_USERS, TWITTER_TARGET_USERS, SUDACHI_BIN) のみ .env から読む。
// それ以外は config.js (プロジェクトルート) から読み、config.custom.js があればそれで上書きする。

import { z } from "zod";

const scheduleEntry = z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(59)]);

// config.js / config.custom.js の形を定義し、同時にバリデーションも兼ねる。
// JSDoc で config.js から参照される FileConfig は、このスキーマから導出する。
const fileConfigSchema = z.strictObject({
  dbPath: z.string().default("data/bot.db"),
  postIntervalMinutes: z.number().default(60),
  postSchedule: z.array(scheduleEntry).nullable().default(null),
  learnNotesLimit: z.number().default(5000),
  includeReplies: z.boolean().default(true),
  maxNoteLength: z.number().default(140),
  targetNoteLength: z.number().default(40),
  maxSentences: z.number().default(2),
  shortNoteProbability: z.number().min(0).max(1).default(0.3),
  excludeWords: z.array(z.string()).default([]),
  misskey: z
    .strictObject({
      learnVisibilities: z
        .array(z.enum(["public", "home", "followers", "specified"]))
        .default(["public", "home", "followers", "specified"]),
      excludeWords: z.array(z.string()).default([]),
    })
    .prefault({}),
  twitter: z
    .strictObject({
      pollIntervalMinutes: z.number().positive().default(30),
      excludeWords: z.array(z.string()).default([]),
    })
    .prefault({}),
  postVisibility: z.enum(["public", "home", "followers"]).default("public"),
  replyEnabled: z.boolean().default(true),
  renoteEmoji: z.string().default(":thinking:"),
  sudachiMode: z.enum(["A", "B", "C"]).default("C"),
  sudachiDictType: z.enum(["small", "core", "full"]).nullable().default(null),
});

export type FileConfig = z.infer<typeof fileConfigSchema>;

/** `sinceMs` があれば、その時刻以降のノートだけを学習する。 */
export type MisskeyTargetUser = { username: string; host?: string; sinceMs?: number };
export type TwitterTargetUser = { screenName: string; sinceMs?: number };

// 下流モジュールが使う Config。FileConfig の変換済み版 + env 由来のフィールドを含む。
export type Config = {
  misskeyInstance: string;
  misskeyToken: string;
  sudachiBin: string;
  dbPath: string;
  /** postIntervalMinutes を ms に変換したもの。 */
  postIntervalMs: number;
  postSchedule: Array<[number, number]> | null;
  learnNotesLimit: number;
  includeReplies: boolean;
  maxNoteLength: number;
  targetNoteLength: number;
  maxSentences: number;
  shortNoteProbability: number;
  postVisibility: "public" | "home" | "followers";
  replyEnabled: boolean;
  renoteEmoji: string;
  sudachiMode: "A" | "B" | "C";
  sudachiDictType: "small" | "core" | "full" | undefined;
  misskey: {
    targetUsers: MisskeyTargetUser[];
    /** string[] から変換済みの Set。 */
    learnVisibilities: ReadonlySet<string>;
    /** 共通の excludeWords とプラットフォーム別の excludeWords を合わせたもの。 */
    excludeWords: string[];
  };
  twitter: {
    targetUsers: TwitterTargetUser[];
    pollIntervalMs: number;
    /** 共通の excludeWords とプラットフォーム別の excludeWords を合わせたもの。 */
    excludeWords: string[];
  };
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`必須の環境変数 ${name} が設定されていません`);
  return value;
};

const misskeyInstanceSchema = z
  .url({ protocol: /^https?$/, error: "http(s):// から始まる URL を指定してください" })
  .transform((v) => v.replace(/\/+$/, ""));

const parseEnvField = <T>(schema: z.ZodType<T>, name: string): T => {
  const result = schema.safeParse(requireEnv(name));
  if (!result.success) {
    throw new Error(`環境変数 ${name} が不正です: ${result.error.issues[0]?.message}`);
  }
  return result.data;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// "yyyy/mm/dd" を JST のその日 0:00 の UTC ms に変換する。2024/02/30 のような存在しない日付は弾く。
export const parseSinceDate = (raw: string) => {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(raw);
  if (!match) throw new Error(`日付は yyyy/mm/dd 形式で指定してください: ${raw}`);
  const [year, month, day] = match.slice(1).map(Number);
  const jstMidnight = new Date(Date.UTC(year, month - 1, day));
  if (jstMidnight.getUTCMonth() !== month - 1 || jstMidnight.getUTCDate() !== day) {
    throw new Error(`存在しない日付です: ${raw}`);
  }
  return jstMidnight.getTime() - JST_OFFSET_MS;
};

// "entry:yyyy/mm/dd" の日付部分を切り出す。日付がなければ sinceMs は undefined。
const splitSinceDate = (entry: string) => {
  const colon = entry.indexOf(":");
  if (colon === -1) return { name: entry, sinceMs: undefined };
  return { name: entry.slice(0, colon), sinceMs: parseSinceDate(entry.slice(colon + 1)) };
};

const splitEntries = (raw: string) =>
  raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

// "user, user@remote.example:2024/01/01" 形式をパースする。
export const parseMisskeyTargetUsers = (raw: string): MisskeyTargetUser[] =>
  splitEntries(raw).map((entry) => {
    const { name, sinceMs } = splitSinceDate(entry);
    const parts = name.split("@");
    if (parts.length === 1) return { username: name, sinceMs };
    if (parts.length === 2) return { username: parts[0], host: parts[1], sinceMs };
    throw new Error(`MISSKEY_TARGET_USERS の書式が不正です: ${entry}`);
  });

// "jack, @dorsey:2024/01/01" 形式をパースする。先頭の @ は省略可能で、大文字小文字は区別しない。
export const parseTwitterTargetUsers = (raw: string): TwitterTargetUser[] =>
  splitEntries(raw).map((entry) => {
    const { name, sinceMs } = splitSinceDate(entry);
    const screenName = name.replace(/^@/, "").toLowerCase();
    if (!/^\w{1,15}$/.test(screenName)) {
      throw new Error(`TWITTER_TARGET_USERS の書式が不正です: ${entry}`);
    }
    return { screenName, sinceMs };
  });

const validateFileConfig = (raw: unknown): FileConfig => {
  const result = fileConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`config.js の内容が不正です: ${detail}`);
  }
  return result.data;
};

// config.custom.js で misskey / twitter の一部のキーだけを書いたとき、残りのキーを config.js の値で埋める。
const mergeFileConfig = (base: FileConfig, custom: Partial<FileConfig>) => ({
  ...base,
  ...custom,
  misskey: { ...base.misskey, ...custom.misskey },
  twitter: { ...base.twitter, ...custom.twitter },
});

// config.js (ベース) と config.custom.js (上書き) を dynamic import でマージする。
const loadFileConfig = async (): Promise<FileConfig> => {
  const baseUrl = new URL("../config.js", import.meta.url);
  const customUrl = new URL("../config.custom.js", import.meta.url);

  const baseMod = (await import(baseUrl.href)) as { default: unknown };
  const base = validateFileConfig(baseMod.default);

  try {
    const customMod = (await import(customUrl.href)) as { default: Partial<FileConfig> };
    // custom のキーで base を上書きしてから再バリデーションする。
    return validateFileConfig(mergeFileConfig(base, customMod.default));
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

  const misskeyTargets = process.env["MISSKEY_TARGET_USERS"] ?? "";
  const twitterTargets = process.env["TWITTER_TARGET_USERS"] ?? "";
  if (!misskeyTargets && !twitterTargets) {
    throw new Error(
      "学習対象として MISSKEY_TARGET_USERS と TWITTER_TARGET_USERS の少なくとも一方を設定してください",
    );
  }

  return {
    misskeyInstance: parseEnvField(misskeyInstanceSchema, "MISSKEY_INSTANCE"),
    misskeyToken: requireEnv("MISSKEY_TOKEN"),
    sudachiBin: process.env["SUDACHI_BIN"] ?? "sudachipy",
    dbPath: file.dbPath,
    postIntervalMs: file.postIntervalMinutes * 60_000,
    postSchedule: file.postSchedule,
    learnNotesLimit: file.learnNotesLimit,
    includeReplies: file.includeReplies,
    maxNoteLength: file.maxNoteLength,
    targetNoteLength: file.targetNoteLength,
    maxSentences: file.maxSentences,
    shortNoteProbability: file.shortNoteProbability,
    postVisibility: file.postVisibility,
    replyEnabled: file.replyEnabled,
    renoteEmoji: file.renoteEmoji,
    sudachiMode: file.sudachiMode,
    sudachiDictType: file.sudachiDictType ?? undefined,
    misskey: {
      targetUsers: parseMisskeyTargetUsers(misskeyTargets),
      learnVisibilities: new Set(file.misskey.learnVisibilities),
      excludeWords: [...file.excludeWords, ...file.misskey.excludeWords],
    },
    twitter: {
      targetUsers: parseTwitterTargetUsers(twitterTargets),
      pollIntervalMs: file.twitter.pollIntervalMinutes * 60_000,
      excludeWords: [...file.excludeWords, ...file.twitter.excludeWords],
    },
  };
};
