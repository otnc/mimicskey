// pm2 logs で読む前提の整形。構造化ログの仕組みはこの規模では過剰なので、
// 1 行 = 時刻 + レベル + メッセージに絞る。

const format = (level: string, message: string) =>
  `${new Date().toISOString()} [${level}] ${message}`;

export const log = {
  info: (message: string) => {
    console.log(format("INFO", message));
  },
  warn: (message: string) => {
    console.warn(format("WARN", message));
  },
  error: (message: string, error?: unknown) => {
    console.error(format("ERROR", message));
    if (error == null) return;
    if (error instanceof Error) {
      console.error(`${error.message}\n${error.stack ?? ""}`);
    } else {
      console.error(error);
    }
  },
};
