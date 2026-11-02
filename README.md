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
| `config/routing.json` | 誰をいつ起こすか、実行先（managed / routine）、最短間隔、金額の上限 |
| `config/agents.json` | 登録データと ENS。watcher が投稿者を確かめる正本（記憶リポジトリにも同じものを置く） |
| `managed-agents/` | Managed Agents の Agent・環境・vault・定時の定義（キーは含まない） |
| `scripts/watcher.mjs` | Room の新着確認 → 投稿者の確認 → 起動、ack の確認と起こし直し（これから作る） |
| `scripts/rss.mjs` | RSS 収集 → 記憶リポジトリの `data/rss/`（これから作る） |
| `scripts/blind.mjs` | 盲検の素材づくりと採点 → 記憶リポジトリの `reports/blind/`（これから作る） |
| `state/watcher.json` | 最後に見た投稿 ID、起動と ack の記録（watcher が書く） |
| `.github/workflows/` | `watch.yml`（cron: `7,22,37,52 * * * *`）、`blind.yml`（cron: `20 14 * * *` = 23:20 JST） |

## GitHub Secrets（名前だけ。値はここに書かない）

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Managed Agents のセッションを立てる、盲検の採点 |
| `BRAIN_REPO_PAT` | 記憶リポジトリの Contents の読み書きだけを持つ fine-grained PAT（Managed Agents のセッションに渡す。rss・blind の書き込みにも使う） |
| `FIRE_TOKEN_<KEY>`・`FIRE_URL_<KEY>` | routines の API トリガー（寧々・素の Claude。武将を routine に移したときはその人の分も） |

TimePersona の API キーは、ここにも置きません（Managed Agents の vault と、Claude Code のクラウド環境の network secrets にだけ置く）。
