import pino from "pino";

// pino による構造化ログ。pm2 logs でも読めるよう pino-pretty を通す (LOG_PRETTY=false で生の JSON Lines に戻せる)。
// LOG_LEVEL (trace/debug/info/warn/error/fatal) でレベルを変更できる。既定は info。
const pinoLogger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport:
    process.env["LOG_PRETTY"] === "false"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
});

export const log = {
  info: (message: string) => pinoLogger.info(message),
  warn: (message: string) => pinoLogger.warn(message),
  error: (message: string, error?: unknown) => {
    if (error == null) pinoLogger.error(message);
    else pinoLogger.error({ err: error }, message);
  },
};
