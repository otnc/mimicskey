// 設定の読み込み。
// シークレット (MISSKEY_INSTANCE, MISSKEY_TOKEN, TARGET_USERS, SUDACHI_BIN) のみ .env から読む。
// それ以外は config.js (プロジェクトルート) から読み、config.custom.js があればそれで上書きする。

import { z } from "zod";

const scheduleEntry = z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(59)]);

// config.js / config.custom.js の形を定義し、同時にバリデーションも兼ねる。
// JSDoc で config.js から参照される FileConfig は、このスキーマから導出する。
const fileConfigSchema = z.object({
  dbPath: z.string().default("data/bot.db"),
  postIntervalMinutes: z.number().default(60),
  postSchedule: z.array(scheduleEntry).nullable().default(null),
  learnNotesLimit: z.number().default(5000),
  includeReplies: z.boolean().default(true),
  learnVisibilities: z
    .array(z.enum(["public", "home", "followers", "specified"]))
    .default(["public", "home", "followers", "specified"]),
  maxNoteLength: z.number().default(140),
  targetNoteLength: z.number().default(40),
  maxSentences: z.number().default(2),
  shortNoteProbability: z.number().min(0).max(1).default(0.3),
  excludeWords: z.array(z.string()).default([]),
  postVisibility: z.enum(["public", "home", "followers"]).default("public"),
  replyEnabled: z.boolean().default(true),
  renoteEmoji: z.string().default(":thinking:"),
  sudachiMode: z.enum(["A", "B", "C"]).default("C"),
  sudachiDictType: z.enum(["small", "core", "full"]).nullable().default(null),
});

export type FileConfig = z.infer<typeof fileConfigSchema>;

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
  const result = fileConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`config.js の内容が不正です: ${detail}`);
  }
  return result.data;
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
    misskeyInstance: parseEnvField(misskeyInstanceSchema, "MISSKEY_INSTANCE"),
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
