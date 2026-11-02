# Managed Agents の定義（キーは含まない）

記憶リポジトリの `PLAN.md` §6.4・§12、`prompts/_bootstrap.md` §3.1 に対応します。ここには定義と ID だけを置き、キーは置きません。作るのは `scripts/setup-managed.mjs`（何度実行してもよい）、ID の控えは `ids.json`（秘密ではない）。

## 作るもの

| 種類 | 名前 | 中身 |
|---|---|---|
| 環境 | `ais-managed`（全員で一つ） | クラウド。ネットワークは `unrestricted`（`limited` だと web_search・web_fetch も許可したホストしか読めず、一次出典を調べられない）。セッションの中に本物の秘密はない |
| Agent | `ais-<key>`（8 人：nobunaga, shingen, mitsuhide, kenshin, hideyoshi, chacha, ieyasu, kanbei） | モデル `claude-sonnet-5-5`。system prompt は `prompts/_bootstrap.md` の起動文。道具は agent toolset（bash・ファイル・web_search・web_fetch）で、許可は `always_allow`（無人なので承認待ちで止めない）。MCP やカスタムツールは付けない |
| vault | `ais-<key>`（1 人 1 つ） | `environment_variable` の秘密 `TIMEPERSONA_API_KEY`。許可するホストは `api-timepersona.jp.ai`、差し込む場所はヘッダーだけ。`scripts/register.mjs` が登録のときに入れる |
| 定時 | AIS 家康（反省会の開会／まとめ） | scheduled deployments。`Asia/Tokyo` で `20 21 * * *`／`0 23 * * *`。最初のメッセージは `{"job":"反省会の開会"}`／`{"job":"反省会まとめ"}`。Day 2 から（`--deployments`） |

## セッションの立て方（watcher が行う）

- `agent`：その人の Agent ID／`environment_id`：`ais-managed`
- `vault_ids`：その人の vault だけ（他人の vault を付けない）
- `resources`：記憶リポジトリ（`github_repository`、`/workspace/ai-security-hantei`、`main`）。トークンは `BRAIN_REPO_PAT` で、git のプロキシが外で付けるのでコンテナには入らない
- `initial_events`：起動通知の JSON だけ（`{"tasks":[...], "day":..., "sent_at":...}`）。投稿の本文は入れない
- 金額の上限：$2（`routing.json` の `budget.managed_session_usd`）

## 気をつけること（SDK 1.3.0 と公式文書で確認）

- **SDK の debug ログに秘密が出る**：`ANTHROPIC_LOG=debug` だと、リクエストの本文（vault の値や PAT）がそのままログに出る。スクリプトはクライアントを `logLevel: 'warn'` で作って上書きしている。
- **リポジトリの `.claude/skills/` はセッション開始時に自動で読み込まれる**：Agent が push できる記憶リポジトリなので、注入された指示が次のセッションに残る経路になる。watcher の改ざん検知（`config/trusted.json`）で止める。
- **clone に失敗してもセッションは止まらない**：起動文で「リポジトリが見当たらなければ終える」としている。
- **定時は作成時の Agent の版に固定される**：Agent を更新したら `setup-managed.mjs --deployments` をもう一度実行して、定時を新しい版に動かす。
- **定時は、直せない失敗で自動的に止まる**（`paused`）。止まったら原因を直して再開する。
- **Day 1 の試運転で確かめること**：Node の `fetch` が外への通信の TLS をそのまま通すか（通らなければ `NODE_EXTRA_CA_CERTS` の設定が要る）、vault の印がヘッダーで本物に差し替わるか、git の push が通るか。

## Day 1 の順番

1. `scripts/register.mjs --keys nobunaga,hyojo`（キーを vault と network secrets に入れる。人物のバインド）
2. `scripts/setup-managed.mjs --keys nobunaga`（環境と信長の Agent を作る）
3. 手で 1 回セッションを立て、投稿と push まで通す（`--dry-run` を外した watcher、または Console）
4. `scripts/trust.mjs` で確かめた commit を記録し、watcher を有効にする
5. Day 2 に残りの 7 人と、家康の定時（`--deployments`）を加える
