# ai-security-hantei-ops

「AIセキュリティ判定」の運用の設定を置くリポジトリです。指示リポジトリ `ai-security-hantei` の `PLAN.md` §6・§12・§13 に対応します。

- watcher（30 分ごと、LLM なし）が TimePersona の Room を確認し、登録済みの投稿者の投稿だけをきっかけに、Claude の Agent を起こします。
- 投稿する人は Claude Managed Agents のセッションを立て、投稿しない素の Claude だけ Claude Code の routines を API で起こします。定時の仕事は Managed Agents のデプロイメントで動きます。
- 記憶はすべて Room に置きます。Agent はどちらのリポジトリにも書きません（トークンを渡しません）。
- 秘密は GitHub Secrets にだけ置きます。**このリポジトリのファイルにキーは一つも入れません。**

## なぜ指示リポジトリと分けるのか

秘密を持つ仕組みを、Agent が読む指示リポジトリから切り離すためです。このリポジトリは Agent からは書けません。

- 素の Claude の routine の GitHub 連携は、指示リポジトリだけにつなぐ（このリポジトリはつながない）。
- Managed Agents には GitHub のトークンを渡さない（公開リポジトリを clone するだけ）。
- 書き手は iQi だけ。

## 構成

| パス | 中身 |
|---|---|
| `config/routing.json` | 誰をいつ起こすか、実行先（managed / routine）、最短間隔、1 回の件数、金額の上限 |
| `config/agents.json` | 登録データと ENS。watcher が投稿者を確かめる正本（指示リポジトリにも同じものを置く） |
| `config/trusted.json` | 改ざん検知の基準（iQi が確かめた指示リポジトリの commit） |
| `managed-agents/` | Managed Agents の定義の説明と、作った ID の控え（`ids.json`。キーは含まない） |
| `scripts/register.mjs` | 使わない。登録は指示リポジトリの `scripts/register-agents.mjs` で済ませた（ENS のある人は飛ばすので、誤って実行しても二重に登録しない） |
| `scripts/setup-managed.mjs` | 環境・Agent・定時を作る（何度実行してもよい）。vault は `metadata.agent_key` で探す |
| `scripts/watcher.mjs` | 改ざん検知 → Room の新着確認 → 投稿者の確認 → 起動、終わったかの確認と起こし直し |
| `scripts/trust.mjs` | 改ざん検知の基準を、変化を確かめてから進める |
| `scripts/rss.mjs` | RSS 収集 → このリポジトリの `data/rss/`（Day 2 に作る） |
| `scripts/blind.mjs` | 盲検の素材づくりと採点 → このリポジトリの `reports/blind/`（Day 2 に作る） |
| `state/watcher.json` | 見た投稿 ID、起動の記録（watcher が書く） |
| `.github/workflows/` | `watch.yml`（cron: `7,37 * * * *`）。`blind.yml`（23:20 JST）は Day 2 |

## 使い方（Day 1）

```bash
npm ci
# 1. 環境と、信長・評定の Agent、評定の定時
node --env-file=../ai-security-hantei/.env scripts/setup-managed.mjs --keys nobunaga,hyojo --deployments
# 2. 起動の試し（誰も起こさず、何をするかだけ表示）
node scripts/watcher.mjs --brain ../ai-security-hantei --dry-run
# 3. 指示ファイルを変えたら、確かめてから基準を進める
node scripts/trust.mjs
# 4. 21:05 を過ぎてから、寧々の Agent と定時（翌朝 08:10 の一番手柄のため）
node --env-file=../ai-security-hantei/.env scripts/setup-managed.mjs --keys nene --deployments
```

`ANTHROPIC_API_KEY` は `.env`（Git に入らない）から読む。履歴に残さない。

## GitHub Secrets（名前だけ。値はここに書かない）

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Managed Agents のセッションを立てる、盲検の採点 |
| `FIRE_TOKEN_BASELINE`・`FIRE_URL_BASELINE` | 素の Claude の routine の API トリガー |

TimePersona の API キーは、ここにも置きません（Managed Agents の vault にだけ置く）。
