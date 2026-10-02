# mimicskey

指定したユーザーの Misskey のノートと X (Twitter) のツイートを学習してマルコフ連鎖で文を生成し、指定した時刻または間隔で投稿する Misskey Bot。メンション・リプライ・引用には返信し、renote にはリアクションを返す。

VPS 上で Node.js 24+ と pm2 で動かす。Rust のビルドも Python のグローバル環境も不要で、`npm install` と `uv sync` の 2 コマンドでセットアップが完了する。

## できること

- 指定ユーザー (複数可) のノートを全件取得して学習し、その後もリアルタイムに学習を続ける
- X (Twitter) のユーザー (複数可) のツイートも学習元にできる。リツイートを除く本人のツイートを遡って取得し、その後も定期的に取り込む
- ユーザーごとに、指定した日付以降の投稿だけを学習できる
- 除外ワードは共通の設定に加えて、Misskey と X で別々にも設定できる
- 指定した時刻 (`POST_SCHEDULE`) または間隔 (`POST_INTERVAL_MINUTES`) で、学習内容を再結合した文を投稿する
- 設定した確率で 1 文だけの短いノートを生成する (`SHORT_NOTE_PROBABILITY`)
- 学習するノートの公開範囲を絞り込める (`misskey.learnVisibilities`)
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

`.env` には Bot アカウントの 2 項目と、学習対象を書く。学習対象は `MISSKEY_TARGET_USERS` と `TWITTER_TARGET_USERS` の少なくとも一方が必須:

```dotenv
MISSKEY_INSTANCE=https://misskey.io
MISSKEY_TOKEN=xxxxxxxxxxxxxxxx
MISSKEY_TARGET_USERS=user1,user2@example.instance:2024/01/01
TWITTER_TARGET_USERS=x_user1,x_user2:2025/04/01
```

末尾の `:yyyy/mm/dd` は任意で、付けたユーザーは JST のその日 0:00 以降の投稿だけを学習する。

X のツイートは [FxTwitter](https://github.com/FxEmbed/FxEmbed) の公開 API から [fxtwitter](https://www.npmjs.com/package/fxtwitter) パッケージで取得するため、X のアカウントやトークンは要らない。鍵アカウントのツイートは取得できない。

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

| 変数                                            | 必須 | 既定               | 説明                                                                                                                          |
| ----------------------------------------------- | ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `MISSKEY_INSTANCE`                              | はい | -                  | Bot アカウントがいるインスタンスの URL                                                                                        |
| `MISSKEY_TOKEN`                                 | はい | -                  | アクセストークン                                                                                                              |
| `MISSKEY_TARGET_USERS`                          | ※    | -                  | Misskey の学習対象。カンマ区切りで `username` または `username@host`。末尾に `:yyyy/mm/dd` を付けるとその日以降だけを学習する |
| `TWITTER_TARGET_USERS`                          | ※    | -                  | X の学習対象。カンマ区切りのユーザー名 (先頭の `@` は省略可)。末尾に `:yyyy/mm/dd` を付けるとその日以降だけを学習する         |
| `POST_SCHEDULE`                                 |      | (未設定)           | 投稿する時刻。`00:00,12:00` のように HH:MM のカンマ区切りで指定。設定すると `POST_INTERVAL_MINUTES` は無視される              |
| `POST_INTERVAL_MINUTES`                         |      | 60                 | 定期投稿の間隔 (分)。`POST_SCHEDULE` が未設定のときのみ有効                                                                   |
| `learnNotesLimit`                               |      | 5000               | 学習に使う最大ノート数。バックフィルではユーザーごとにこの件数まで遡る                                                        |
| `includeReplies`                                |      | true               | 対象ユーザーのリプライも学習するか (Misskey と X で共通)                                                                      |
| `excludeWords`                                  |      | `[]`               | この語を含むノート・ツイートを学習しない (Misskey と X で共通)                                                                |
| `misskey.excludeWords` / `twitter.excludeWords` |      | `[]`               | Misskey / X だけに適用する除外ワード。共通の `excludeWords` と合わせて使われる                                                |
| `misskey.learnVisibilities`                     |      | すべて             | 学習するノートの公開範囲。`["public", "home", "followers", "specified"]` から選ぶ                                             |
| `twitter.pollIntervalMinutes`                   |      | 30                 | X の新しいツイートを取り込む間隔 (分)                                                                                         |
| `MAX_NOTE_LENGTH`                               |      | 140                | 生成ノートの最大文字数 (硬い制限)                                                                                             |
| `TARGET_NOTE_LENGTH`                            |      | 60                 | 生成文の採点基準にする目標文字数。満たない間は文を足していく                                                                  |
| `MAX_SENTENCES`                                 |      | 3                  | 1 ノートの最大文数                                                                                                            |
| `SHORT_NOTE_PROBABILITY`                        |      | 0.3                | この確率で 1 文だけの短いノートを生成する (0〜1)                                                                              |
| `SUDACHI_BIN`                                   |      | `sudachipy`        | SudachiPy CLI のパス (pm2 からは `.venv` 内の絶対パス推奨)                                                                    |
| `SUDACHI_MODE`                                  |      | C                  | 分割単位 (A / B / C)。いつでも切り替え可能                                                                                    |
| `SUDACHI_DICT_TYPE`                             |      | (SudachiPy の既定) | 辞書種別 (small / core / full)                                                                                                |
| `REPLY_ENABLED`                                 |      | true               | メンション等への返信を行うか                                                                                                  |
| `RENOTE_EMOJI`                                  |      | `:thinking:`       | renote に付けるリアクション                                                                                                   |
| `LOG_LEVEL`                                     |      | info               | ログレベル (trace / debug / info / warn / error / fatal)                                                                      |
| `LOG_PRETTY`                                    |      | true               | false で pino-pretty を通さず生の JSON Lines を出力する (ログ収集基盤に流す場合など)                                          |

## 日常の操作

| やりたいこと              | コマンド                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ログを見る                | `pm2 logs mimicskey`                                                                                                 |
| 再起動 (設定変更後に必要) | `pm2 restart mimicskey`                                                                                              |
| 停止                      | `pm2 stop mimicskey`                                                                                                 |
| 学習対象ユーザーの変更    | `.env` の `MISSKEY_TARGET_USERS` / `TWITTER_TARGET_USERS` を編集して再起動。学習リストは次回起動時に自動で同期される |
| 投稿スケジュールの変更    | `.env` の `POST_SCHEDULE` または `POST_INTERVAL_MINUTES` を編集して再起動                                            |
| 分割単位の変更 (C→B など) | `.env` の `SUDACHI_MODE` を編集して再起動。DB の再作成は不要 (次のチェーン再構築から反映)                            |
| 学習データのリセット      | `npm run learn -- --clear` (クリアしてバックフィルし直す)。Bot を再起動すると新しいデータで動く                      |
| 学習データの再取得        | `npm run learn` (未取得ユーザーはバックフィル、取得済みは差分取得)                                                   |
| アップデート              | `git pull && npm ci && uv sync && npm run build && pm2 restart mimicskey`                                            |

## 動作の流れ

定期ポーリングなしで、すべて WebSocket 駆動で動く。

**ノートの学習 (userList チャンネル)**: 学習対象ユーザーを入れた非公開ユーザーリストを Bot が自動で作成・維持し (設定の MISSKEY_TARGET_USERS に合わせて追加・削除)、そのリストの userList チャンネルでノートをリアルタイムに受信して SQLite に保存する。リストは自分にしか見えないので、フォローのような社会的な副作用もない。初回起動時だけ `LEARN_NOTES_LIMIT` 件まで遡ってバックフィルする。

**ツイートの学習 (ポーリング)**: X にはストリーミングがないため、`twitter.pollIntervalMinutes` ごとに FxTwitter の検索 API で `from:ユーザー名` を引き、前回取得した最新ツイート以降 (`since_id`) を取り込む。タイムライン API は直近 120 件程度しか遡れないが、検索ならリツイートを含まない本人のツイートを全期間遡れる。初回だけ `learnNotesLimit` 件 (開始日を指定したユーザーはその日) まで遡ってバックフィルする。件数が多いと時間がかかるので、WebSocket に接続した後にバックグラウンドで進める。バックフィルの進み具合は 100 件ごとにログに出る。取得に失敗しても Bot は止まらず、バックフィルは保存済みの進捗から、差分は前回のカーソルから、5 分後 (`twitter.pollIntervalMinutes` がそれより短ければその間隔) に再試行する。

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
- 学習用ユーザーリストは `mimicskey-<6文字>` の形式で初回起動時に自動生成される。名前は DB に保存され、以降の起動でも同じリストを使い続ける。手動で中身を変えても、次回起動時に MISSKEY_TARGET_USERS に合わせて元に戻る
- 分割単位 (SUDACHI_MODE) と辞書 (SUDACHI_DICT_TYPE) はいつでも切り替えられる。ノートは生のテキストとして DB に保存され、チェーンの再構築のたびに再トークナイズされるため、設定変更は次の再構築から反映される (再起動だけでよく、データの入れ直しは不要)

## 開発

ローカルでのセットアップ手順とプラットフォーム別の設定は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。

- `npm run dev`: tsx で直接実行
- `npm run learn`: 学習データを明示的に取得 (`-- --clear` でクリアしてバックフィルし直す)。起動時のバックフィルを待たずに取得したいときや、Bot を止めずに再取得したいときに使う
- `npm run hi`: 投稿せずに生成文を確認
- `npm run typecheck`: 型チェック。`tsc` は TypeScript 7 (ネイティブ実装) を使う
- `npm run lint` / `npm run format`: eslint (typescript-eslint) / prettier

TypeScript 7 は JS API を持たないため、JS API が必要な typescript-eslint には `@typescript/typescript6` を `typescript` という名前でエイリアスして併用している (TypeScript 公式の 6.0 との併用手順)。

## 参考

文章生成の自然さを改善する上で参考にした文献・実装:

- [A Bit of Progress in Language Modeling](https://arxiv.org/abs/cs/0108005) (Goodman, 2001) — n-gram のスムージング手法を比較した代表的な研究
- [A Bayesian Interpretation of Interpolated Kneser-Ney](https://www.stats.ox.ac.uk/~teh/research/compling/hpylm.pdf) (Teh, 2006, Technical Report TRA2/06, School of Computing, NUS) — interpolated Kneser-Ney を階層 Pitman-Yor 過程として導出した技術レポート
- [A Hierarchical Bayesian Language Model based on Pitman-Yor Processes](https://aclanthology.org/P06-1124.pdf) (Teh, ACL 2006) — 上記の階層 Pitman-Yor 言語モデル (HPYLM) 自体を提案した査読付き論文
- [On Prediction Using Variable Order Markov Models](https://arxiv.org/pdf/1107.0051) (Begleiter, El-Yaniv & Yona, JAIR 22, 2004) — PPM など可変長マルコフモデルのサーベイ
- [Bayesian Variable Order n-gram Language Model Based on Hierarchical Pitman-Yor Processes](https://cir.nii.ac.jp/crid/1050282812859105920) — HPYLM による可変長 n-gram モデルの日本語文献
- [Kneser–Ney smoothing - Wikipedia](https://en.wikipedia.org/wiki/Kneser%E2%80%93Ney_smoothing)
- [Factored language model - Wikipedia](https://en.wikipedia.org/wiki/Factored_language_model) — 品詞などの factor を使った backoff
- [KenLM: Faster and Smaller Language Model Queries](https://www.kheafield.com/papers/avenue/kenlm.pdf) (Heafield, 2011) — modified Kneser-Ney smoothing を使う高速な n-gram 言語モデル実装。Node 向けバインディングはなく C++ ビルドが要るため、このプロジェクトでは実装の参考に留める
- [jsvine/markovify](https://github.com/jsvine/markovify) — Python のマルコフ連鎖文章生成ライブラリ。候補を複数試行してスコアで選ぶ設計がこの Bot に近い
- [TobiasNickel/js-markov](https://github.com/TobiasNickel/js-markov) (npm: `js-markov`) — 階数 (order) を指定できる Node.js のマルコフ連鎖ライブラリ
- [kn (npm)](https://www.npmjs.com/package/kn) — Kneser-Ney smoothing の Node.js 実装 (10 年前に公開、保守なし。参考用)
- [Bilmes & Kirchhoff, "Factored Language Models and Generalized Parallel Backoff"](https://aclanthology.org/N03-2002.pdf) (NAACL 2003) — 品詞などの factor へ backoff する手法。`posContext` の実装で採用
- [Li & Bertsekas, "Most Likely Sequence Generation for n-Grams, Transformers, HMMs, and Markov Chains, by Using Rollout Algorithms"](https://arxiv.org/abs/2403.15465) (2024) — 純粋なランダムサンプリングではなく、複数候補を生成してモデル尤度でより良いものを選ぶ (rollout) ことで生成系列の尤もらしさを上げる手法。目標長への近さに加えて文全体の平均対数確率もスコアに含める形で採用
- [秋山陸・寺岡丈博「事象の連想と共起性に基づいたマルコフ連鎖による文生成」](https://www.jsise.org/wp-content/uploads/2022/08/2021_hokkaido_a06.pdf) (情報システム学会 2021年度全国大会, 拓殖大学) — 連想概念辞書による重み付けで、直前の語だけでなく話題の連想・共起性も考慮して文を生成する試み。ノート内の 2 文目以降を直前の文の名詞でシードする形で採用

## ライセンス

SudachiPy / sudachi.rs と SudachiDict は Apache License 2.0。

- https://github.com/WorksApplications/sudachi.rs
- https://github.com/WorksApplications/SudachiDict
