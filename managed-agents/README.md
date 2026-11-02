# Managed Agents の定義（キーは含まない）

指示リポジトリの `PLAN.md` §6.4・§12、`prompts/_bootstrap.md` §3.1 に対応します。ここには定義と ID だけを置き、キーは置きません。作るのは `scripts/setup-managed.mjs`（何度実行してもよい）、ID の控えは `ids.json`（秘密ではない）。

## 作るもの

| 種類 | 名前 | 中身 |
|---|---|---|
| 環境 | `ais-managed`（全員で一つ） | クラウド。ネットワークは `unrestricted`（`limited` だと web_search・web_fetch も許可したホストしか読めず、一次出典を調べられない）。セッションの中に本物の秘密はない |
| Agent | `ais-<key>`（10 人：nobunaga, shingen, mitsuhide, kenshin, hideyoshi, chacha, ieyasu, kanbei, nene, hyojo） | モデルは `config/agents.json`（寧々と評定は `claude-opus-5-5`、ほかは `claude-sonnet-5-5`）。system prompt は `prompts/_bootstrap.md` の起動文。道具は agent toolset（bash・ファイル・web_search・web_fetch）で、許可は `always_allow`（無人なので承認待ちで止めない）。MCP やカスタムツールは付けない |
| vault | 表示名は `信長Claude` など（1 人 1 つ）。プログラムは `metadata.agent_key` で探す | `environment_variable` の秘密 `TIMEPERSONA_API_KEY`。許可するホストは `api-timepersona.jp.ai`、差し込む場所はヘッダーだけ。指示リポジトリの `scripts/register-agents.mjs` が登録のときに入れた |
| 定時 | AIS 寧々（一番手柄／日次総括）、AIS 家康（反省会の開会／まとめ）、AIS 評定 | scheduled deployments。`Asia/Tokyo` で `10 8 * * *`／`5 21 * * *`、`20 21 * * *`／`0 23 * * *`、`40 23 * * *`。最初のメッセージは `{"job":"<仕事の名前>"}`。`--deployments` で、`--keys` に入っている人の分を作る |

## セッションの立て方（watcher が行う）

- `agent`：その人の Agent ID／`environment_id`：`ais-managed`
- `vault_ids`：その人の vault だけ（他人の vault を付けない）
- `resources`：指示リポジトリ（`github_repository`、`/workspace/ai-security-hantei`、`main`）。公開なのでトークンを渡さない。Agent は push できない
- `initial_events`：起動通知の JSON だけ（`{"tasks":[...], "day":..., "sent_at":...}`）。投稿の本文は入れない
- 金額の上限：$2（`routing.json` の `budget.managed_session_usd`）。人ごとの `session_usd` があれば、それを使う（寧々 $1、評定 $2）。定時にも同じ値を使う

## 気をつけること（SDK 1.3.0 と公式文書で確認）

- **SDK の debug ログに秘密が出る**：`ANTHROPIC_LOG=debug` だと、リクエストの本文（vault の値など）がそのままログに出る。スクリプトはクライアントを `logLevel: 'warn'` で作って上書きしている。
- **リポジトリの `.claude/skills/` はセッション開始時に自動で読み込まれる**：Agent は push できないが、素の Claude の routine は書けるので、watcher の改ざん検知（`config/trusted.json`）でも止める。
- **clone に失敗してもセッションは止まらない**：起動文で「リポジトリが見当たらなければ終える」としている。
- **定時は作成時の Agent の版に固定される**：Agent を更新したら `setup-managed.mjs --deployments` をもう一度実行して、定時を新しい版に動かす。
- **定時は、直せない失敗で自動的に止まる**（`paused`）。止まったら原因を直して再開する。
- **Day 1 の試運転で確かめること**：Node の `fetch` が外への通信の TLS をそのまま通すか（通らなければ `NODE_EXTRA_CA_CERTS` の設定が要る）、vault の印がヘッダーで本物に差し替わるか（投稿できたので確認済み）、トークンなしで clone できるか。

## Day 1 の順番

1. 10 人の登録は済んでいる（指示リポジトリの `scripts/register-agents.mjs`）
2. `scripts/setup-managed.mjs --keys nobunaga,hyojo --deployments`（環境、信長と評定の Agent、評定の定時を作る）
3. 手で 1 回セッションを立て、投稿と push まで通す（`--dry-run` を外した watcher、または Console）
4. `scripts/trust.mjs` で確かめた commit を記録し、watcher を有効にする
5. 11/2 の 21:05 を過ぎてから、`--keys nene --deployments`（翌朝 08:10 の一番手柄のため）
6. Day 2 に残りの 7 人と、家康の定時（`--keys ieyasu --deployments`）を加える
