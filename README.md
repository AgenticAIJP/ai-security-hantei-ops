# ai-security-hantei-ops

「AIセキュリティ判定」の運用の設定を置くリポジトリです。記憶リポジトリ `ai-security-hantei` の `PLAN.md` §6・§12・§13 に対応します。

- watcher（15 分ごと、LLM なし）が TimePersona の Room を確認し、登録済みの投稿者の投稿だけをきっかけに、Claude の Agent を起こします。
- 速報に反応する仕事は Claude Managed Agents のセッションを立て、寧々と素の Claude は Claude Code の routines を API で起こします。
- 秘密は GitHub Secrets にだけ置きます。**このリポジトリのファイルにキーは一つも入れません。**

## なぜ記憶リポジトリと分けるのか

Agent は記憶リポジトリに push できます。もし同じリポジトリに watcher と Secrets があると、外の文章で乗っ取られた Agent が watcher を書き換え、次の実行で Secrets を外に出せてしまいます。このリポジトリは Agent からは書けません。

- Claude Code の routines の GitHub 連携は、記憶リポジトリだけにつなぐ（このリポジトリはつながない）。
- Managed Agents に渡す GitHub の PAT は、記憶リポジトリの Contents の読み書きだけに絞る。
- 書き手は iQi だけ。

## 構成

| パス | 中身 |
|---|---|
| `config/routing.json` | 誰をいつ起こすか、実行先（managed / routine）、最短間隔、1 回の件数、金額の上限 |
| `config/agents.json` | 登録データと ENS。watcher が投稿者を確かめる正本（記憶リポジトリにも同じものを置く） |
| `config/trusted.json` | 改ざん検知の基準（iQi が確かめた記憶リポジトリの commit） |
| `managed-agents/` | Managed Agents の定義の説明と、作った ID の控え（`ids.json`。キーは含まない） |
| `scripts/register.mjs` | 10 件の登録。キーを画面・ファイル・ログに出さず、vault と network secrets に渡す |
| `scripts/setup-managed.mjs` | 環境・Agent・家康の定時を作る（何度実行してもよい） |
| `scripts/watcher.mjs` | 改ざん検知 → Room の新着確認 → 投稿者の確認 → 起動、ack の確認と起こし直し |
| `scripts/trust.mjs` | 改ざん検知の基準を、変化を確かめてから進める |
| `scripts/rss.mjs` | RSS 収集 → 記憶リポジトリの `data/rss/`（Day 2 に作る） |
| `scripts/blind.mjs` | 盲検の素材づくりと採点 → 記憶リポジトリの `reports/blind/`（Day 2 に作る） |
| `state/watcher.json` | 最後に見た投稿 ID、起動と ack の記録（watcher が書く） |
| `.github/workflows/` | `watch.yml`（cron: `7,22,37,52 * * * *`）。`blind.yml`（23:20 JST）は Day 2 |

## 使い方（Day 1）

```bash
npm ci
# 1. 登録（信長と評定から）。キーは vault と、クリップボード経由で network secrets へ
ANTHROPIC_API_KEY=... node scripts/register.mjs --keys nobunaga,hyojo
# 2. Managed Agents の環境と信長の Agent
ANTHROPIC_API_KEY=... node scripts/setup-managed.mjs --keys nobunaga
# 3. 起動の試し（誰も起こさず、何をするかだけ表示）
node scripts/watcher.mjs --brain ../ai-security-hantei --dry-run
# 4. 指示ファイルを変えたら、確かめてから基準を進める
node scripts/trust.mjs
```

`ANTHROPIC_API_KEY` はコマンドの前に一時的に付けるか、パスワード管理ツールから渡す。ファイルや履歴に残さない。

## GitHub Secrets（名前だけ。値はここに書かない）

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Managed Agents のセッションを立てる、盲検の採点 |
| `BRAIN_REPO_PAT` | 記憶リポジトリの Contents の読み書きだけを持つ fine-grained PAT（Managed Agents のセッションに渡す。rss・blind の書き込みにも使う） |
| `FIRE_TOKEN_<KEY>`・`FIRE_URL_<KEY>` | routines の API トリガー（寧々・素の Claude。武将を routine に移したときはその人の分も） |

TimePersona の API キーは、ここにも置きません（Managed Agents の vault と、Claude Code のクラウド環境の network secrets にだけ置く）。
