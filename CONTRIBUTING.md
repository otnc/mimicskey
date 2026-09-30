# ローカル開発

## ローカルでテストできるか

できる。Misskey インスタンスへの実接続が必要かどうかによって 2 種類に分かれる。

| テストの種類 | Misskey 接続 | SudachiPy |
| --- | --- | --- |
| 単体テスト (`npm test`) | 不要 | 不要 |
| Bot の実動作確認 (`npm run dev`) | 必要 | 必要 |

単体テストはクローンして `npm ci` の後すぐ実行できる。

## 前提

| | バージョン | 備考 |
| --- | --- | --- |
| Node.js | 24+ | `better-sqlite3` v13 のプリビルドが Windows/macOS/Linux (x64・arm64) 向けに提供されている。Visual Studio や node-gyp は不要 |
| uv | 0.12+ | Python 環境を `.venv` に隔離して管理する。Python 本体も uv が自動で用意するので個別インストールは不要 |

## セットアップ

全プラットフォーム共通:

```sh
git clone <このリポジトリ> && cd <リポジトリ名>
npm ci        # Node 依存を入れる
uv sync       # .venv に SudachiPy が入る
cp .env.example .env
```

`.env` の必須 3 変数を埋める:

```dotenv
MISSKEY_INSTANCE=https://misskey.io
MISSKEY_TOKEN=xxxxxxxxxxxxxxxx
TARGET_USERS=yourname
```

## SUDACHI_BIN の設定

`uv sync` で SudachiPy は `.venv` に入るが、`npm run dev` (tsx) や `npm run start` (Node) からは PATH が引き継がれないため、`.env` にパスを指定する。

**Windows**

```dotenv
SUDACHI_BIN=.venv/Scripts/sudachipy
```

**macOS**

```dotenv
SUDACHI_BIN=.venv/bin/sudachipy
```

**Linux**

```dotenv
SUDACHI_BIN=.venv/bin/sudachipy
```

> 仮想環境を有効化してから npm を実行する方法でも動く (Windows: `.venv\Scripts\Activate.ps1`、macOS/Linux: `source .venv/bin/activate`)。ただし端末を開き直すたびに有効化が必要になるため、`.env` への記載を推奨する。

## テスト

### 単体テスト

```sh
npm test
```

マルコフ連鎖 (`src/markov.ts`) とテキスト処理 (`src/text.ts`) をテストする。Misskey への接続も SudachiPy の起動もなく、クローン直後から実行できる。

### Bot の動作確認

```sh
npm run build     # tsc でコンパイル → dist/
npm run start     # dist/index.js を実行

# または TypeScript を直接実行 (ビルド不要)
npm run dev
```

起動すると実際の Misskey インスタンスに接続する。初回は TARGET_USERS の過去ノートのバックフィルが走るため数分かかる。返信・投稿も実際に行われるため、誤動作を防ぎたい場合は `.env` に次を加えておく:

```dotenv
REPLY_ENABLED=false          # メンションへの返信を止める
POST_INTERVAL_MINUTES=999999 # 投稿タイマーを事実上無効化
```

## 開発スクリプト一覧

| コマンド | 内容 |
| --- | --- |
| `npm run build` | tsc でコンパイル (`dist/` に出力) |
| `npm run start` | `dist/index.js` を実行 |
| `npm run dev` | tsx で TypeScript を直接実行 (ビルド不要) |
| `npm run typecheck` | 型チェックのみ (emit なし) |
| `npm run lint` | ESLint (typescript-eslint) |
| `npm run format` | Prettier |
| `npm test` | Vitest 単体テスト |

## TypeScript のバージョン構成

`tsc` は TypeScript 7 (ネイティブ実装、`@typescript/native`) を使う。`typescript-eslint` は TS7 の JS API を持たないため、`@typescript/typescript6` を `typescript` という名前でエイリアスして併用している。`npx tsc --version` が `Version 7.x` を返せばセットアップは正しい。
