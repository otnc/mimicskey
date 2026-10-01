import spawn from "cross-spawn";
import { log } from "./logger.js";

export type Token = {
  /** 表層形。生成文にはそのまま使う。 */
  surface: string;
  /** 正規化形。打込む/打ち込む のような表記揺れを同じ遷移にまとめるための、チェーンのキー。 */
  normalized: string;
  /** 品詞。助詞始まりの文を弾くなど、生成後の検査に使う。 */
  pos: string[];
};

export type SudachiOptions = {
  /** sudachipy コマンドのパス (uv tool install で入る)。 */
  bin: string;
  /** 分割単位。A (短) / B (中) / C (固有表現)。 */
  mode: string;
  /** 辞書種別 (small / core / full)。未指定なら SudachiPy 側の既定 (core)。 */
  dictType?: string;
};

// SudachiPy (sudachi.rs と同じ Rust コアの pip パッケージ) の CLI を子プロセスで呼ぶトークナイザ。uv tool install で入るので Rust のビルドは要らない。
// 文をまとめて 1 回のバッチ呼び出しに乗せることで、プロセス起動コストをチェーン再構築 1 回あたり 1 回に抑える。
// cross-spawn を使うのは、Windows での .bat/.cmd 解決やパスのスペースの扱いを node:child_process の素の spawn より正しく行うため。
// (execa や nano-spawn のような高レベルラッパーは、存在しないコマンドを Windows では cmd.exe 経由でフォールバック実行してしまい、
//  ENOENT が隠れて分かりにくいエラーになるため見送った。cross-spawn は node:child_process.spawn 同様に ENOENT を正しく報告する)
// 出力は `sudachipy -a` のタブ区切り: 表層形, 品詞, 正規化形, 辞書形, 読み, ...
// 文の区切りは EOS 行。
export const createTokenizer = (opts: SudachiOptions) => {
  const run = (args: string[], input: string) =>
    new Promise<string>((resolve, reject) => {
      // PYTHONUTF8=1 で Python 側の stdin/stdout を UTF-8 に固定する。
      // これがないと Windows やロケールが UTF-8 未設定の Linux で stdin のエンコーディングがロケール依存になり、UTF-8 で書き込んだ入力が化ける。
      const child = spawn(opts.bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1" },
      });
      // cross-spawn の型は stdio の値を見て絞り込まないが、上で "pipe" を 3 つ指定しているので必ず非 null。
      const { stdout, stderr, stdin } = child;
      if (!stdout || !stderr || !stdin) {
        reject(new Error("SudachiPy の子プロセスの標準入出力を取得できませんでした"));
        return;
      }
      let out = "";
      let err = "";
      stdout.setEncoding("utf8");
      stderr.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      stderr.on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("error", (e) => {
        reject(
          new Error(
            `SudachiPy (${opts.bin}) を起動できませんでした: ${e.message}。` +
              "uv tool install sudachipy --with sudachidict_full で入れるか、SUDACHI_BIN を見直してください",
          ),
        );
      });
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else
          reject(new Error(`SudachiPy が終了コード ${code} で失敗しました: ${err.slice(0, 500)}`));
      });
      stdin.on("error", (e) =>
        reject(new Error(`SudachiPy への書き込みに失敗しました: ${e.message}`)),
      );
      stdin.end(input);
    });

  const parse = (stdout: string) => {
    const groups: Token[][] = [];
    let current: Token[] = [];
    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line === "" || line === "EOS") {
        if (current.length > 0) {
          groups.push(current);
          current = [];
        }
        continue;
      }
      const fields = line.split("\t");
      if (fields.length < 3) continue;
      const surface = fields[0];
      const pos = (fields[1] ?? "").split(",");
      if (pos[0] === "空白") continue; // 空白トークンは捨てる
      const normalized = fields[2] !== "" ? fields[2] : surface;
      current.push({ surface, normalized, pos });
    }
    if (current.length > 0) groups.push(current);
    return groups;
  };

  return {
    tokenizeBatch: async (sentences: string[]) => {
      if (sentences.length === 0) return [];
      const args = ["-m", opts.mode, "-a"];
      if (opts.dictType) args.push("-s", opts.dictType);
      const stdout = await run(args, sentences.join("\n"));
      const groups = parse(stdout);
      if (groups.length !== sentences.length) {
        // 1:1 で戻らなくても、チェーンは文らしいトークン列があれば学習できるので続行する。
        log.warn(
          `SudachiPy が ${sentences.length} 文に対して ${groups.length} グループを返しました (続行します)`,
        );
      }
      return groups;
    },
  };
};

export type Tokenizer = ReturnType<typeof createTokenizer>;
