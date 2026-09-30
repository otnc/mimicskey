# mimicskey

指定したユーザーのノートを学習してマルコフ連鎖で文を生成し、指定した時刻または間隔で投稿する Misskey Bot。メンション・リプライ・引用には返信し、renote にはリアクションを返す。

VPS 上で Node.js 24+ と pm2 で動かす。Rust のビルドも Python のグローバル環境も不要で、`npm install` と `uv sync` の 2 コマンドでセットアップが完了する。

## できること

- 指定ユーザー (複数可) のノートを全件取得して学習し、その後もリアルタイムに学習を続ける
- 指定した時刻 (`POST_SCHEDULE`) または間隔 (`POST_INTERVAL_MINUTES`) で、学習内容を再結合した文を投稿する
- 設定した確率で 1 文だけの短いノートを生成する (`SHORT_NOTE_PROBABILITY`)
- 学習するノートの公開範囲を絞り込める (`LEARN_VISIBILITIES`)
- メンション・リプライ・引用には生成文で返信する (相手のノートの名詞から始めるので話題に沿う)
- renote にはリアクションを付ける

## 必要なもの

| ソフトウェア | バージョン | 用途              | 備考                                                                     |
| ------------ | ---------- | ----------------- | ------------------------------------------------------------------------ |
| Node.js      | 24+        | 実行環境          | better-sqlite3 のプリビルドがあるためビルド不要                          |
| uv           | 0.12+      | Python 依存の管理 | SudachiPy を `.venv` に隔離して入れる。Python 本体も uv が自動で用意する |
| pm2          | 任意       | 常駐起動          | `npm i -g pm2`。systemd でも可                                           |

Misskey 側には Bot 用アカウントのアクセストークンが必要 (後述)。

## セットアップ (VPS)

### 1. 前提を入れる

```sh
# Node.js 24 (nodesource 経由の例。nvm でも可)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# uv (Python 本体もこれで入る。Python を個別に入れる必要はない)
curl -LsSf https://astral.sh/uv/install.sh | sh

# pm2 (任意)
sudo npm i -g pm2
```

### 2. Bot アカウントとアクセストークン

Misskey で Bot 用アカウントを作り、設定 > API > アクセストークンの発行 で次の権限のトークンを作る:

- read:account / write:account (学習用ユーザーリストの作成・維持に使用)
- read:notes / write:notes
- read:notifications / write:reactions

### 3. デプロイと設定

```sh
git clone <このリポジトリ> ~/bot && cd ~/bot

# 依存を入れる (Node と Python の両方。lock ファイルからバージョン固定で入る)
npm ci
uv sync       # .venv に SudachiPy が入る

# 設定を書く
cp .env.example .env
nano .env
```

`.env` の必須項目は 3 つ:

```dotenv
MISSKEY_INSTANCE=https://misskey.io
MISSKEY_TOKEN=xxxxxxxxxxxxxxxx
TARGET_USERS=user1,user2@example.instance
```

pm2 から起動する場合のみ、`SUDACHI_BIN` に `.venv` 内の絶対パスを指定する (pm2 からは PATH が見えないため):

```dotenv
SUDACHI_BIN=/home/youruser/bot/.venv/bin/sudachipy
```

### 4. 動作確認してから常駐起動

```sh
# ビルドとテスト (Misskey に接続しない)
npm run build
npm test

# 1 回だけ動かしてログを見る
npm run start

# 問題なければ pm2 で常駐化
pm2 start ecosystem.config.cjs
pm2 logs mimicskey
pm2 save        # 再起動後に pm2 resurrect で復帰させる場合
```

## 設定

`.env.example` に全変数と既定値がある。主要なもの:

| 変数                     | 必須 | 既定               | 説明                                                                                                             |
| ------------------------ | ---- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `MISSKEY_INSTANCE`       | はい | -                  | Bot アカウントがいるインスタンスの URL                                                                           |
| `MISSKEY_TOKEN`          | はい | -                  | アクセストークン                                                                                                 |
| `TARGET_USERS`           | はい | -                  | 学習対象。カンマ区切りで `username` または `username@host`                                                       |
| `POST_SCHEDULE`          |      | (未設定)           | 投稿する時刻。`00:00,12:00` のように HH:MM のカンマ区切りで指定。設定すると `POST_INTERVAL_MINUTES` は無視される |
| `POST_INTERVAL_MINUTES`  |      | 60                 | 定期投稿の間隔 (分)。`POST_SCHEDULE` が未設定のときのみ有効                                                      |
| `LEARN_NOTES_LIMIT`      |      | 5000               | 学習に使う最大ノート数                                                                                           |
| `LEARN_INCLUDE_REPLIES`  |      | true               | 対象ユーザーのリプライも学習するか                                                                               |
| `LEARN_VISIBILITIES`     |      | すべて             | 学習するノートの公開範囲。`public,home,followers,specified` をカンマ区切りで指定                                 |
| `MAX_NOTE_LENGTH`        |      | 140                | 生成ノートの最大文字数 (硬い制限)                                                                                |
| `TARGET_NOTE_LENGTH`     |      | 60                 | 生成文の採点基準にする目標文字数。満たない間は文を足していく                                                     |
| `MAX_SENTENCES`          |      | 3                  | 1 ノートの最大文数                                                                                               |
| `SHORT_NOTE_PROBABILITY` |      | 0.3                | この確率で 1 文だけの短いノートを生成する (0〜1)                                                                 |
| `SUDACHI_BIN`            |      | `sudachipy`        | SudachiPy CLI のパス (pm2 からは `.venv` 内の絶対パス推奨)                                                       |
| `SUDACHI_MODE`           |      | C                  | 分割単位 (A / B / C)。いつでも切り替え可能                                                                       |
| `SUDACHI_DICT_TYPE`      |      | (SudachiPy の既定) | 辞書種別 (small / core / full)                                                                                   |
| `REPLY_ENABLED`          |      | true               | メンション等への返信を行うか                                                                                     |
| `RENOTE_EMOJI`           |      | `:thinking:`       | renote に付けるリアクション                                                                                      |

## 日常の操作

| やりたいこと              | コマンド                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| ログを見る                | `pm2 logs mimicskey`                                                                      |
| 再起動 (設定変更後に必要) | `pm2 restart mimicskey`                                                                   |
| 停止                      | `pm2 stop mimicskey`                                                                      |
| 学習対象ユーザーの変更    | `.env` の `TARGET_USERS` を編集して再起動。学習リストは次回起動時に自動で同期される       |
| 投稿スケジュールの変更    | `.env` の `POST_SCHEDULE` または `POST_INTERVAL_MINUTES` を編集して再起動                 |
| 分割単位の変更 (C→B など) | `.env` の `SUDACHI_MODE` を編集して再起動。DB の再作成は不要 (次のチェーン再構築から反映) |
| 学習データのリセット      | `pm2 stop` して `data/bot.db` を削除、再起動 (初回バックフィルからやり直し)               |
| アップデート              | `git pull && npm ci && uv sync && npm run build && pm2 restart mimicskey`                 |

## 動作の流れ

定期ポーリングなしで、すべて WebSocket 駆動で動く。

**ノートの学習 (userList チャンネル)**: 学習対象ユーザーを入れた非公開ユーザーリストを Bot が自動で作成・維持し (設定の TARGET_USERS に合わせて追加・削除)、そのリストの userList チャンネルでノートをリアルタイムに受信して SQLite に保存する。リストは自分にしか見えないので、フォローのような社会的な副作用もない。初回起動時だけ `LEARN_NOTES_LIMIT` 件まで遡ってバックフィルする。

**通知への反応 (main チャンネル)**: 通知をリアルタイムに受信する。mention / reply / quote には生成文で返信し、renote にはリアクションを付ける。起動時は既存の通知を見済みにするだけで反応しない (何日も前のメンションに一斉に返信しないため)。

**定期投稿**: `POST_SCHEDULE` が設定されているときは指定した時刻 (例: 00:00 と 12:00) まで待って投稿し、次の予定時刻をスケジュールする。未設定のときは前回の投稿時刻 + `POST_INTERVAL_MINUTES` 分で動く。

**切断への対応**: misskey-js の Stream が自動で再接続する。再接続時には切れていた間のノートと通知をカーソルからの差分取得で回収してから処理を続ける。

マルコフ連鎖の再構築 (SudachiPy のバッチ呼び出し 1 回) は、新規ノートが保存されたときだけ行う。

## 自然な文を出すための工夫

素のマルコフ連鎖は単語の並びっぽい何かを出すだけで、文として破綻しがち。この Bot は二階マルコフ連鎖を土台に、次を組み合わせている。

- 文単位で BOS / EOS 付きで学習する。文の形をしていない断片は生成されない
- Sudachi の C モード (固有表現単位) で分割する。選挙管理委員会 のような固有名詞が 1 トークンとして残り、生成文でも壊れない (SUDACHI_MODE=B で中単位に切り替え可能)
- チェーンのキーは正規化形、出力は表層形。打込む/打ち込む のような表記揺れが同じ遷移にまとまり、チェーンが濃くなる
- 観測されていない三階状態では一階にバックオフし、歩みが止まらない
- 文頭と遷移は出現頻度で重み付きサンプリング
- 助詞・接続詞で始まる文、助詞で終わる文は棄却
- 同じ bigram が 2 回出るループ文、学習文の逐語コピーは棄却
- 候補は目標長への近さでスコア化し、試行の中で最良のものを採用
- 返信は相手のノートから名詞を 1 つ選んでシードにする。話題に沿った返信になる

## 補足

- specified (ダイレクト) ノートへの返信は、送り主だけに見える直接ノートで行う
- 返信の公開範囲は相手のノートを超えない
- renote 通知が持っているのは renote された側 (自分) のノートなので、`notes/renotes` で renote した側を引き当ててからリアクションを付ける
- 学習用ユーザーリストは `mimicskey-<6文字>` の形式で初回起動時に自動生成される。名前は DB に保存され、以降の起動でも同じリストを使い続ける。手動で中身を変えても、次回起動時に TARGET_USERS に合わせて元に戻る
- 分割単位 (SUDACHI_MODE) と辞書 (SUDACHI_DICT_TYPE) はいつでも切り替えられる。ノートは生のテキストとして DB に保存され、チェーンの再構築のたびに再トークナイズされるため、設定変更は次の再構築から反映される (再起動だけでよく、データの入れ直しは不要)

## 開発

ローカルでのセットアップ手順とプラットフォーム別の設定は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。

- `npm run dev`: tsx で直接実行
- `npm run typecheck`: 型チェック。`tsc` は TypeScript 7 (ネイティブ実装) を使う
- `npm run lint` / `npm run format`: eslint (typescript-eslint) / prettier

TypeScript 7 は JS API を持たないため、JS API が必要な typescript-eslint には `@typescript/typescript6` を `typescript` という名前でエイリアスして併用している (TypeScript 公式の 6.0 との併用手順)。

## ライセンス

SudachiPy / sudachi.rs と SudachiDict は Apache License 2.0。

- https://github.com/WorksApplications/sudachi.rs
- https://github.com/WorksApplications/SudachiDict
