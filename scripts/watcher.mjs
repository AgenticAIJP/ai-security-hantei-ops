#!/usr/bin/env node
// watcher：30 分ごと（GitHub Actions の watch.yml）。LLM は使わない。
//  1. 指示ファイルの改ざん検知：指示リポジトリで、Agent が書いてよい場所以外が iQi の確かめた commit から
//     変わっていたら、誰も起こさずに止まる（Actions の失敗として iQi に知らせる）。
//  2. Room の新着を読み、登録済みの投稿者の投稿だけをきっかけに、起こす人と理由を決める（PLAN.md §6.2）。
//  3. 正常に終わらなかったセッションを起こし直す（素の Claude だけは ack のファイルで確かめる）。
//  4. 最短間隔・有効になる日・1 日の上限・金額の上限を守って、Managed Agents のセッションを立てるか routine を起こす。
//
// 使い方：node scripts/watcher.mjs --brain <指示リポジトリのパス> [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, jstIso, jstDate, dayNumber, describeError, parseArgs } from './lib/util.mjs';
import { loadAgents, ensIndex } from './lib/agents.mjs';
import { recentRoomPosts, getPost } from './lib/timepersona.mjs';
import { routineTarget, fireRoutine } from './lib/routine.mjs';
import { anthropic, startSession, sessionCost, sessionOutcome, deploymentCostCents, describeApiError } from './lib/managed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const brainRoot = path.resolve(process.cwd(), typeof args.brain === 'string' ? args.brain : path.join(opsRoot, '../ai-security-hantei'));
const dryRun = Boolean(args['dry-run']);
const statePath = path.join(opsRoot, 'state', 'watcher.json');

const MEMBERS = ['nobunaga', 'shingen', 'mitsuhide', 'kenshin', 'hideyoshi', 'chacha', 'ieyasu', 'nene', 'kanbei'];
const SHORT_NAMES = { nobunaga: '信長', shingen: '信玄', mitsuhide: '光秀', kenshin: '謙信', hideyoshi: '秀吉', chacha: '茶々', ieyasu: '家康', nene: '寧々', kanbei: '官兵衛' };
const ANALYSTS = ['shingen', 'chacha', 'hideyoshi', 'mitsuhide'];
const REVIEWERS = ['kenshin', 'mitsuhide']; // 点検と反論の役は補助bot を使わない（事情を知らない目を残す）
const SUBSTITUTABLE = ['shingen', 'chacha', 'hideyoshi', 'ieyasu', 'kanbei']; // 手が足りないときに、補助bot が案を書ける役
const REVIEW_TAGS = new Set(['判定', '判定まとめ', '続報', '独立判定', '技術分析', '反論', '攻め手の読み', '制度の視点', '速報', '最新版']);
// Git に書いてよい場所（CLAUDE.md §4）。書くのは素の Claude だけ。これ以外が変わっていたら止まる。
const AGENT_WRITABLE = ['baseline/', 'state/acks/'];
const SHORT_RECORD = /[：:]\s*(対象外|記録のみ|枠外|原因待ち)/; // 全員を起こさない信長の投稿の 1 行目（PLAN.md §2.2）
const PERSONAL_ONLY = /[：:]\s*(枠外|原因待ち)/; // 議論には回さないが、個人の守りは茶々が書く
const WAIT_CAUSE = /[：:]\s*原因待ち/;
const HIGH_SEVERITY = /^\s*■\s*深刻度[：:]\s*高/m; // 深刻度が高の原因待ちでは、信玄が原因を推測せずに備えを書く
const OUT_OF_SCOPE = /[：:]\s*対象外/;

const now = new Date();
const log = (msg) => console.log(`[${jstIso(now)}] ${msg}`);

function tagOf(content) {
  const m = /^【([^】]+)】/.exec((content ?? '').trim());
  if (!m) return null;
  const t = m[1].trim();
  return t.startsWith('続報') ? '続報' : t;
}

function firstLine(content) {
  return (content ?? '').trim().split('\n')[0];
}

/** Files changed since the trusted commit, outside the places agents may write. */
function untrustedChanges(trusted) {
  if (!trusted?.brain_commit) throw new Error('config/trusted.json に brain_commit がありません（scripts/trust.mjs で設定してください）。');
  let out;
  try {
    out = execFileSync('git', ['-C', brainRoot, 'diff', '--name-only', trusted.brain_commit, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`指示リポジトリの履歴に ${trusted.brain_commit} がありません（checkout の fetch-depth: 0 と、commit が push 済みかを確かめてください）。`);
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => !AGENT_WRITABLE.some((p) => f.startsWith(p)));
}

function ackedIds(key) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(brainRoot, 'state', 'acks', `${key}.json`), 'utf8'));
    return new Set(data.processed ?? []);
  } catch {
    return new Set();
  }
}

function taskIds(t) {
  if (t.post_ids) return t.post_ids;
  if (t.rss_paths) return t.rss_paths.map((p) => `rss:${p}`);
  if (t.incident_id) return [`incident:${t.incident_id}`];
  return [];
}

function taskSignature(t) {
  return `${t.key}|${t.reason}|${t.for ?? ''}|${taskIds(t).join(',')}`;
}

/** Merge tasks with the same reason into one entry for the payload (ids only, never post bodies). */
function payloadTasks(tasks) {
  const merged = new Map();
  for (const t of tasks) {
    if (t.reason === 'baseline_case') { merged.set(`b:${t.incident_id}`, { reason: t.reason, incident_id: t.incident_id, root_post_id: t.root_post_id }); continue; }
    if (t.reason === 'daiko') { merged.set(`d:${t.for}:${t.post_ids.join(',')}`, { reason: t.reason, for: t.for, post_ids: t.post_ids }); continue; }
    if (t.reason === 'eval_correction') { merged.set(`e:${t.post_ids.join(',')}`, { reason: t.reason, post_ids: t.post_ids, report_post_id: t.report_post_id }); continue; }
    const k = t.reason;
    const entry = merged.get(k) ?? { reason: t.reason, ...(t.rss_paths ? { rss_paths: [] } : { post_ids: [] }) };
    for (const id of t.post_ids ?? []) if (!entry.post_ids.includes(id)) entry.post_ids.push(id);
    for (const p of t.rss_paths ?? []) if (!entry.rss_paths.includes(p)) entry.rss_paths.push(p);
    for (const id of t.line_ids ?? []) { entry.unanswered ??= []; if (!entry.unanswered.includes(id)) entry.unanswered.push(id); } // まだ決めていない速報
    merged.set(k, entry);
  }
  return [...merged.values()];
}

async function main() {
  const routing = readJson(path.join(opsRoot, 'config/routing.json'));
  const agents = loadAgents(path.join(opsRoot, 'config/agents.json'));
  const trusted = readJson(path.join(opsRoot, 'config/trusted.json'), {});
  const ids = readJson(path.join(opsRoot, 'managed-agents/ids.json'), { environment_id: null, agents: {}, vaults: {} });
  const state = readJson(statePath, { seen: [], pending: [], dispatches: [], last_dispatch: {}, daily: {}, eval_done: [], alerts: [] });
  const today = jstDate(now);
  const day = dayNumber(routing.day1, now);
  const daily = (state.daily[today] ??= { managed_usd: 0, baseline: 0 });

  // 1. 改ざん検知
  const suspicious = untrustedChanges(trusted);
  if (suspicious.length) {
    state.alerts.push({ at: jstIso(now), type: 'untrusted_change', files: suspicious.slice(0, 50) });
    state.alerts = state.alerts.slice(-50);
    if (!dryRun) writeJson(statePath, state);
    console.error(`止めました：指示リポジトリで、Agent が書いてはいけない場所が変わっています（${suspicious.length} 件）。`);
    for (const f of suspicious.slice(0, 20)) console.error(`  - ${f}`);
    console.error('iQi が中身を確かめ、問題がなければ scripts/trust.mjs で確かめた commit を更新してください。');
    process.exitCode = 1;
    return;
  }

  // 運用の終わり（PLAN.md §14。11/08 はまとめる日）。過ぎたら誰も起こさず、Managed Agents の定時を一度だけ止める。
  if (routing.stop_after && now >= new Date(routing.stop_after)) {
    if (!state.stopped_at) {
      let allPaused = true;
      if (process.env.ANTHROPIC_API_KEY && !dryRun) {
        for (const [name, id] of Object.entries(ids.deployments ?? {})) {
          try { await anthropic().beta.deployments.pause(id); log(`定時を止めました：${name}`); }
          catch (err) { allPaused = false; log(`定時を止められませんでした（${name}）：${describeApiError(err)}`); }
        }
      } else allPaused = false;
      if (allPaused) state.stopped_at = jstIso(now); // 止められなかったものは、次の実行でやり直す
    }
    state.last_run = jstIso(now);
    if (!dryRun) writeJson(statePath, state);
    log(`運用は ${routing.stop_after} で終わりました。誰も起こしません。`);
    return;
  }

  // 議論の枠：1 日の上限を、時間で少しずつ開ける（朝に使い切らず、夜の大きな事案にも残すため）。使わなかった分は持ち越す。
  const discussionAllowed = () => {
    const max = routing.hantei_daily_max ?? Infinity;
    if (!routing.hantei_slot_hours) return max;
    return Math.min(max, 1 + Math.floor(Number(jstIso(now).slice(11, 13)) / routing.hantei_slot_hours));
  };

  // 2. 新着の分類
  const ensToKey = ensIndex(agents);
  const monomiEns = (routing.trusted_authors?.monomi ?? agents.find((a) => a.key === 'monomi')?.ens ?? '').toLowerCase();
  if (monomiEns.startsWith('<')) log('注意：routing.json の trusted_authors.monomi がまだ空です。');
  const otherTrusted = new Map(Object.entries(routing.trusted_authors ?? {})
    .filter(([k, v]) => k !== 'monomi' && v && !v.startsWith('<')).map(([k, v]) => [v.toLowerCase(), k]));
  const authorKey = (ens) => {
    const e = (ens ?? '').toLowerCase();
    if (!e) return null;
    if (e === monomiEns) return 'monomi';
    if (ensToKey.has(e)) return ensToKey.get(e);
    if (otherTrusted.has(e)) return `trusted:${otherTrusted.get(e)}`;
    return null;
  };

  // 補助bot（下請け）。登録と起動の準備が済むまでは、今までの流れで動く。
  const hojoCfg = routing.agents?.hojo;
  const hojoReady = Boolean(hojoCfg && agents.find((a) => a.key === 'hojo')?.ens && today >= (hojoCfg.active_from ?? '') && routineTarget('hojo'));
  const hojoDeepReady = Boolean(hojoReady && routing.agents?.hojo_deep && routineTarget('hojo_deep')); // 重い分析（Fable 5.1）の routine

  const POST_LIMIT = 1000;
  const posts = await recentRoomPosts(routing.room_id, POST_LIMIT);
  const postById = new Map(posts.map((p) => [p.id, p]));
  const heldPriority = (t) => {
    if (t.reason === "eval_correction") return 0;
    if (t.reason === "an_review") {
      const first = firstLine(postById.get(t.post_ids?.[0])?.content ?? "");
      if (/最新版の下書き/.test(first)) return 1; // 目付の訂正と同じ順位。古い順に並べる
      if (/最新版の一覧の材料/.test(first)) return 1; // 下書きと同じ順位。並べるときは、同じ時刻の下書きのすぐ後ろ（下の atKey）
      return 4;
    }
    if (t.reason === "correction_request") return 1;
    return 4;
  };
  // 謙信の点検は、【最新版】を先にする（読む人がそれだけを見て動くため）
  const fixedPriority = (t) => (isHanseikai(t) ? -1 : t.reason === "review" && /^【最新版】/.test(firstLine(postById.get(t.post_ids?.[0])?.content ?? "")) ? 0 : 1); // 反省会の仕事はいちばん先のまま
  const isListMaterial = (t) => t.reason === "an_review" && /最新版の一覧の材料/.test(firstLine(postById.get(t.post_ids?.[0])?.content ?? ""));
  const atKey = (t) => String(t.at ?? "") + (isListMaterial(t) ? "~" : ""); // 一覧の材料は、同じ時刻の下書きより後
  const byPriority = (prio) => (list) => list.map((t, i) => [prio(t), atKey(t), i, t]).sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2]).map((x) => x[3]);
  const seen = new Set(state.seen);
  const startFrom = Date.parse(routing.start_from ?? `${routing.day1}T12:00:00+09:00`);
  const fresh = posts.filter((p) => !seen.has(p.id) && Date.parse(p.posted_at) >= startFrom);
  if (posts.length >= POST_LIMIT && fresh.length === posts.length) log(`注意：新着が ${POST_LIMIT} 件を超えた可能性があります。取りこぼしがないか確かめてください。`);

  const newTasks = [];
  const add = (key, reason, extra) => newTasks.push({ key, reason, at: jstIso(now), attempt: 1, ...extra });
  let ignored = 0;
  for (const p of fresh) {
    seen.add(p.id);
    const ak = authorKey(p.agent);
    if (!ak) { ignored++; continue; } // 登録していない投稿者の投稿では、誰も起こさない
    const tag = tagOf(p.content);
    const isTeam = MEMBERS.includes(ak);

    if (ak === 'monomi' && tag === 'X速報') add(hojoReady ? 'hojo' : 'nobunaga', hojoReady ? 'x_sokuho_plan' : 'x_sokuho', { post_ids: [p.id] });
    if (ak.startsWith('trusted:') && (tag === 'X速報' || tag === '速報') && !p.quoted_post_id) add('nobunaga', 'sokuho_other', { post_ids: [p.id] });

    // 信長の短い投稿（記録のみ・対象外）では、分析役を起こさない。原因待ちと枠外の判定では、茶々を起こす。深刻度が高の原因待ちでは、信玄も起こす（枠は使わない）
    const isHantei = ak === 'nobunaga' && (tag === '判定' || tag === '続報');
    const shortRecord = isHantei && SHORT_RECORD.test(firstLine(p.content));
    // 枠外の取り戻し（11/06）：1 行目が「：取り戻し」の続報は、ふだんの枠とは別の枠で全員を起こす
    const catchUp = isHantei && tag === '続報' && /[：:]\s*取り戻し/.test(firstLine(p.content));
    const catchUpMax = routing.catch_up_daily_max?.[today] ?? 0;
    if (isHantei && !shortRecord) {
      // 全員で議論する件数の上限。信長も数えて振り分けるが、ここでも止める
      if (catchUp && (daily.catch_up ?? 0) >= catchUpMax) {
        log(`今日の取り戻しの枠 ${catchUpMax} 件に達しているので、分析役を起こしません（${p.id}）。`);
      } else if (!catchUp && (daily.hantei ?? 0) >= discussionAllowed()) {
        log(`今の議論の枠 ${discussionAllowed()} 件に達しているので、分析役を起こしません（${p.id}）。`);
      } else {
        if (catchUp) daily.catch_up = (daily.catch_up ?? 0) + 1;
        else daily.hantei = (daily.hantei ?? 0) + 1;
        for (const a of ANALYSTS) add(a, 'hantei', { post_ids: [p.id] });
        if (p.content.includes('#家康') && p.content.includes('#官兵衛')) {
          add('ieyasu', 'hantei_mid_high', { post_ids: [p.id] });
          add('kanbei', 'hantei_mid_high', { post_ids: [p.id] });
          const incident = /AIS-\d{8}-\d{2}/.exec(p.content)?.[0];
          if (tag === '判定' && incident) {
            let root = p.quoted_post_id;
            try { root = (await getPost(p.id)).root_post_id ?? root; } catch { /* 引用元を使う */ }
            add('baseline', 'baseline_case', { incident_id: incident, root_post_id: root });
          }
        }
      }
    } else if (isHantei && tag === '判定' && PERSONAL_ONLY.test(firstLine(p.content))) {
      const high = WAIT_CAUSE.test(firstLine(p.content)) && HIGH_SEVERITY.test(p.content);
      if (hojoReady) {
        add('hojo', 'card_personal', { post_ids: [p.id] });
        if (high) add('hojo', 'card_prepare', { post_ids: [p.id] });
      } else {
        add('chacha', 'hantei', { post_ids: [p.id] });
        if (high) add('shingen', 'hantei', { post_ids: [p.id] });
      }
    }
    // 事実の点検は、記録のみの投稿にも行う（速報の大半が記録のみになるため）。対象外だけを除く
    const outOfScope = isHantei && OUT_OF_SCOPE.test(firstLine(p.content));
    if (isTeam && ak !== 'kenshin' && REVIEW_TAGS.has(tag) && !outOfScope) add('kenshin', 'review', { post_ids: [p.id] });

    // 補助bot の案は、依頼者に渡す。点検する役には渡さない。寧々は 21:05 の総括で自分で読む。調査メモは事実なので、謙信が確かめる。
    if (ak === 'hojo' && tag === '案') {
      const target = MEMBERS.find((m) => firstLine(p.content).startsWith(`【案】${SHORT_NAMES[m]}殿へ`));
      const lineIds = [...p.content.matchAll(/^- ([0-9a-f]{24})/gm)].map((m) => m[1]);
      const urgent = /^\s*■\s*緊急[：:]\s*はい/m.test(p.content);
      if (target && !REVIEWERS.includes(target)) {
        if (target !== 'nene') add(target, 'an_review', { post_ids: [p.id], ...(lineIds.length ? { line_ids: lineIds } : {}), ...(urgent ? { urgent: true } : {}) });
        // 全員で議論する案の事案は、重い分析の routine が調査メモを書く
        if (target === 'nobunaga') for (const m of p.content.matchAll(/^- ([0-9a-f]{24})｜.*区分案[：:]\s*全員/gm)) add(hojoDeepReady ? 'hojo_deep' : 'hojo', 'memo', { post_ids: [m[1]] });
      } else log(`補助bot の案の宛先を読み取れないか、渡せない相手です（${p.id}）。`);
    }
    if (ak === 'hojo' && tag === '調査メモ') add('kenshin', 'review', { post_ids: [p.id] });
    // 武将から補助bot への依頼と指示。点検する役は依頼しない（案を読まないため）。指示は誰でも出せる。
    if (hojoReady && isTeam) {
      if (/^\s*■\s*補助botへの依頼[：:]/m.test(p.content) && !REVIEWERS.includes(ak)) add('hojo', 'request', { post_ids: [p.id] });
      if (/^\s*■\s*補助botへの指示[：:]/m.test(p.content)) add('hojo', 'instruction', { post_ids: [p.id] });
    }

    if ((ak === 'kenshin' && tag === '目付') || (ak === 'monomi' && tag === 'X調査回答')) {
      if (!p.quoted_post_id) continue;
      try {
        const q = await getPost(p.quoted_post_id);
        const target = authorKey(q.agent);
        // 害になる誤り（謙信が「急ぎ：はい」と書いたもの）だけすぐ直す。ほかの訂正は、決まった時刻にまとめて行う。
        const urgent = ak === 'kenshin' && /^\s*■\s*急ぎ[：:]\s*はい/m.test(p.content);
        if (MEMBERS.includes(target)) add(target, ak === 'kenshin' ? 'correction_request' : 'x_answer', { post_ids: [p.id], ...(urgent ? { urgent: true } : {}) });
        else if (target === 'hojo' && ak === 'kenshin') add('hojo', 'correction_request', { post_ids: [p.id] });
        else if (target === 'monomi') log(`物見bot あての【目付】があります（${p.id}）。Grok に伝えてください。`);
      } catch (err) { log(`引用元を読めませんでした（${p.quoted_post_id}）：${describeError(err)}`); }
    }

    if (ak === 'ieyasu' && tag === '反省会' && !p.quoted_post_id) for (const m of MEMBERS) add(m, 'hanseikai_open', { post_ids: [p.id] });

    // 評定の訂正の依頼は、評定Claude の ENS の投稿からだけ受け取る。ID の形だけを通し、指示文を起動文に混ぜさせない。
    if (ak === 'hyojo' && tag === '評定') {
      for (const m of p.content.matchAll(/^■ 訂正の依頼[：:]\s*([a-z]+)\s+([0-9a-f]{24})/gm)) {
        if (MEMBERS.includes(m[1]) || m[1] === 'hojo') add(m[1], 'eval_correction', { post_ids: [m[2]], report_post_id: p.id });
        else if (m[1] === 'monomi') log(`物見bot への訂正の依頼があります（${m[2]}）。物見bot が Room で読みます。`);
        else log(`訂正の依頼の宛先が不明です：${m[1]}（${p.id}）`);
      }
    }

    if (isTeam && tag === '点検') {
      const name = /対象[：:]\s*([^\s\n（(、。]+)/.exec(firstLine(p.content))?.[1] ?? '';
      const target = MEMBERS.find((m) => name.includes(SHORT_NAMES[m]));
      if (target) add(target, 'tenken', { post_ids: [p.id] });
      else log(`【点検】の対象を読み取れませんでした（${p.id}）。`);
    }
  }

  // rss_new は rss.mjs（Day 2）が ops の data/rss/ に候補を書くようになってから加える。

  // 補助bot が動かないときは、仕事を本人に戻す（信長が速報を直接読む、今までの流れ）
  const backFromHojo = (t) => {
    const at = jstIso(now);
    if (t.reason === 'x_sokuho_plan') return [{ key: 'nobunaga', reason: 'x_sokuho', post_ids: t.post_ids, at, attempt: 1 }];
    if (t.reason === 'card_personal') return [{ key: 'chacha', reason: 'hantei', post_ids: t.post_ids, at, attempt: 1 }];
    if (t.reason === 'card_prepare') return [{ key: 'shingen', reason: 'hantei', post_ids: t.post_ids, at, attempt: 1 }];
    if (t.reason === 'daiko') return [{ key: t.for, reason: 'hantei', post_ids: t.post_ids, at, attempt: 1 }];
    return [];
  };

  // 3. 仕事が終わったかの確認と起こし直し。二重投稿は tp.mjs が止めるので、やり直しても残りの分だけが投稿される。
  // 補助bot はリポジトリに書かない。処理した投稿は、投稿の「■ 処理した投稿」の行で確かめる。
  // 同じ速報の ID が、案と調査メモの両方に載るので、分けて数える。
  const hojoAcks = new Set();
  const hojoMemoAcks = new Set();
  for (const p of posts) {
    if (authorKey(p.agent) !== 'hojo') continue;
    const line = /^\s*■\s*処理した投稿[：:](.*)$/m.exec(p.content)?.[1] ?? '';
    for (const m of line.matchAll(/[0-9a-f]{24}/g)) (tagOf(p.content) === '調査メモ' ? hojoMemoAcks : hojoAcks).add(m[0]);
  }
  const ackTimeoutMs = (routing.retry?.ack_timeout_min ?? 60) * 60_000;
  const maxRetries = routing.retry?.max_retries ?? 2;
  for (const d of state.dispatches.filter((x) => x.status === 'sent')) {
    let why;
    let redo = d.tasks;
    if (d.executor === 'managed') {
      if (!process.env.ANTHROPIC_API_KEY || dryRun) continue;
      let outcome;
      try { outcome = await sessionOutcome(d.session_id); } catch (err) { log(`セッションの状態を読めませんでした（${d.session_id}）：${describeApiError(err)}`); continue; }
      if (outcome.state === 'running') {
        if (now - Date.parse(d.at) > 3 * 3600_000) log(`${d.key}：セッションが 3 時間以上動いています（${d.session_id}）。iQi が確かめてください。`);
        continue;
      }
      if (outcome.state === 'done') { d.status = 'done'; continue; }
      why = `セッションが正常に終わりませんでした（${outcome.reason}）`;
    } else {
      // routines（素の Claude）はセッションを追えないので、ack のファイルで確かめる
      const acks = d.key === 'hojo' || d.key === 'hojo_deep' ? hojoAcks : ackedIds(d.key);
      // 補助bot への指示は、直すことがなければ投稿がない。受け取りの記録を求めず、送れたら終わりとする
      const finished = (t) => (t.reason === 'instruction' && (d.key === 'hojo' || d.key === 'hojo_deep'))
        || taskIds(t).every((id) => (t.reason === 'memo' ? hojoMemoAcks : acks).has(id));
      if (d.tasks.every(finished)) { d.status = 'done'; continue; }
      if (now - Date.parse(d.at) < ackTimeoutMs) continue;
      why = '受け取りの記録がありません';
      redo = d.tasks.filter((t) => !finished(t));
    }
    // 重い分析は起こし直さず、すぐ Opus 5.5 の補助bot に戻す（題材で止まっているなら、やり直しても同じため）
    if (d.attempt <= (d.key === 'hojo_deep' ? 0 : maxRetries)) {
      for (const t of redo) newTasks.push({ ...t, attempt: d.attempt + 1, at: jstIso(now) });
      d.status = 'retried';
      log(`${d.key}：${why}。起こし直します（${d.attempt + 1} 回目）。`);
    } else {
      d.status = 'failed';
      state.alerts.push({ at: jstIso(now), type: 'not_finished', key: d.key, dispatch: d.id, why });
      log(`${d.key}：${why}。${d.attempt} 回起こしても終わらないので、iQi が確かめてください。`);
      if (d.key === 'hojo') newTasks.push(...redo.flatMap((t) => backFromHojo(t)));
      if (d.key === 'hojo_deep') newTasks.push(...redo.map((t) => ({ ...t, key: 'hojo', at: jstIso(now), attempt: 1 })));
    }
  }

  // 4. 費用（Managed Agents の今日の分）
  if (process.env.ANTHROPIC_API_KEY && !dryRun) {
    // 日付をまたいで終わったセッションの費用も拾う（起動した日の分として数える）
    const open = state.dispatches.filter((d) => d.executor === 'managed' && d.session_id && !d.cost_final).slice(-60);
    for (const d of open) {
      try {
        const { status, costCents } = await sessionCost(d.session_id);
        if (costCents != null) d.cost_cents = costCents;
        if (status === 'idle' || status === 'terminated') d.cost_final = true;
      } catch (err) { log(`費用を読めませんでした（${d.session_id}）：${describeApiError(err)}`); }
    }
    const byDate = {};
    for (const d of state.dispatches) {
      if (d.executor !== 'managed') continue;
      const date = d.at.slice(0, 10);
      byDate[date] = (byDate[date] ?? 0) + (d.cost_cents ?? 0);
    }
    for (const [date, cents] of Object.entries(byDate)) {
      const entry = (state.daily[date] ??= { managed_usd: 0, baseline: 0 });
      entry.managed_usd = Math.max(entry.managed_usd ?? 0, cents / 100); // 古い記録を消した日は減らさない
    }
    // 定時（評定・寧々・家康）の費用も、1 日の上限に入れる
    let scheduledCents = 0;
    for (const id of Object.values(ids.deployments ?? {})) {
      try { scheduledCents += await deploymentCostCents(id, `${today}T00:00:00+09:00`); } catch (err) { log(`定時の費用を読めませんでした（${id}）：${describeApiError(err)}`); }
    }
    daily.scheduled_usd = scheduledCents / 100;
  }
  // 昼の仕事は、夜の反省会の分を残したところで止める。反省会の仕事だけ、1 日の上限まで使える。
  const dailyCap = routing.budget?.managed_daily_usd_by_date?.[today] ?? routing.budget?.managed_daily_usd ?? 60; // 日付ごとの上限（11/07 の最新版の日）
  const spentToday = (daily.managed_usd ?? 0) + (daily.scheduled_usd ?? 0);
  const overDailyCap = spentToday >= dailyCap;
  const overDayCap = spentToday >= dailyCap - (routing.budget?.hanseikai_reserve_usd ?? 0);
  if (overDayCap) log(`今日の Managed Agents の費用が ${spentToday.toFixed(2)} です（${overDailyCap ? '1 日の上限' : '反省会の分を除いた上限'}に達しました）。`);
  const isHanseikai = (t) => (routing.ignore_min_interval ?? []).includes(t.reason);
  // 速報は届いた順に処理しない。信長が、待っている速報の一覧から大事なものを選んでカードにし、残りは【判定まとめ】に載せる。
  // 返信か【判定まとめ】に載るまで待ち行列に残すので、速報は失われない。
  const isChoosable = (t) => (routing.choose_by_priority ?? []).includes(t.reason);
  const nobunagaEns = agents.find((a) => a.key === 'nobunaga')?.ens?.toLowerCase();
  const answered = new Set(posts.filter((p) => p.agent?.toLowerCase() === nobunagaEns && p.quoted_post_id).map((p) => p.quoted_post_id));
  // 信長が【判定まとめ】に載せた速報も、判定済みとして扱う（行頭の「- <投稿 ID>」だけを読む）
  for (const p of posts) {
    if (p.agent?.toLowerCase() !== nobunagaEns || tagOf(p.content) !== '判定まとめ') continue;
    for (const m of p.content.matchAll(/^- ([0-9a-f]{24})/gm)) answered.add(m[1]);
  }
  const isAnswered = (t) => {
    if (t.reason === 'an_review' && t.line_ids) { // 信長への案は、全部の行を決めるまで次の確認にも届ける
      t.line_ids = t.line_ids.filter((id) => !answered.has(id));
      return t.line_ids.length === 0;
    }
    return (isChoosable(t) || t.reason === 'x_sokuho_plan') && (t.post_ids ?? []).every((id) => answered.has(id));
  };

  // 5. まとめて起こす
  const pendingBySig = new Map(state.pending.map((t) => [taskSignature(t), t]));
  for (const t of newTasks) if (!pendingBySig.has(taskSignature(t))) pendingBySig.set(taskSignature(t), t);
  // 速さは求めないので、費用の上限で止まった仕事も翌日に回す。48 時間たったものだけ捨てる。
  const allPendingRaw = [...pendingBySig.values()].filter((t) => !isAnswered(t));
  // 補助bot が動いていない、または長く処理されない仕事は、本人に戻す
  const hojoFallbackMs = (routing.hojo_fallback_hours ?? 4) * 3600_000;
  const allPending = allPendingRaw.flatMap((t) => {
    if (t.key === 'hojo_deep') return hojoDeepReady && now - Date.parse(t.at) <= hojoFallbackMs ? [t] : [{ ...t, key: 'hojo', at: jstIso(now), attempt: 1 }];
    if (t.key !== 'hojo' || (hojoReady && now - Date.parse(t.at) <= hojoFallbackMs)) return [t];
    const back = backFromHojo(t);
    if (back.length) log(`補助bot の仕事を本人に戻します：${t.reason}（${taskIds(t).join(',')}）`);
    return back.length ? back : hojoReady ? [t] : [];
  });
  const pending = allPending.filter((t) => now - Date.parse(t.at) < 48 * 3600_000);
  if (allPending.length > pending.length) log(`48 時間たっても処理できなかった仕事を ${allPending.length - pending.length} 件捨てました。`);
  const byKey = new Map();
  for (const t of pending) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);

  // 案の確認と訂正は、決まった時刻にまとめて行う（本人の起動を減らす）。緊急のものはすぐ起こす。
  const heldReasons = new Set(routing.held_reasons ?? []);
  const isHeld = (t) => heldReasons.has(t.reason) && !t.urgent;
  const checkOpen = (key) => {
    const base = routing.check_hours?.[key] ?? routing.check_hours?.default;
    if (!base?.length) return true;
    const hours = [...base, ...(routing.extra_check_hours?.[today] ?? [])]; // 日付ごとに足す確認の時刻（11/08 01:00 の最後の回）
    const passed = hours.filter((h) => h <= Number(jstIso(now).slice(11, 13)));
    if (!passed.length) return false;
    const opened = Date.parse(`${today}T${String(Math.max(...passed)).padStart(2, '0')}:00:00+09:00`);
    const last = state.last_check?.[key];
    return !last || Date.parse(last) < opened;
  };

  const stillPending = [];
  let dispatched = 0;
  for (const [key, tasksAll] of byKey) {
    const cfg = routing.agents[key];
    if (!cfg) { log(`routing.json にない人です：${key}`); continue; }
    if (cfg.active_from && today < cfg.active_from) continue; // まだ有効でない人あての仕事は捨てる
    // 反省会の仕事を先にする（1 回に 1 件の人でも、点検と応答が遅れないように）
    let tasks = [...tasksAll].sort((a, b) => Number(isHanseikai(b)) - Number(isHanseikai(a)));
    if (tasks.some(isHeld) && !checkOpen(key)) {
      stillPending.push(...tasks.filter(isHeld));
      tasks = tasks.filter((t) => !isHeld(t));
      if (!tasks.length) continue;
    }
    if (cfg.daily_max) {
      const room = Math.max(0, cfg.daily_max - (daily[key] ?? 0));
      if (tasks.length > room) log(`${key}：今日の上限 ${cfg.daily_max} 件を超える分は扱いません。`);
      tasks = tasks.slice(0, room);
      if (!tasks.length) continue;
    }
    if (cfg.max_items_per_run) {
      // 質を保つため、1 回に扱う件数を絞る。残りは次の回に回す。選べる速報は、あとで pick 件だけ選ばせる。
      const batchMax = routing.check_batch_max ?? 6; // まとめて確かめる仕事は、1 回に扱う件数を別に数える
      // まとめて確かめる仕事は、大事な順に渡す（11/07：評定の訂正 → 目付の訂正・最新版の下書き・一覧の材料（同じ順位で、仕事ができた時刻の古い順。一覧の材料は同じ時刻の下書きの後）→ ほか）
      const batch = byPriority(heldPriority)(tasks.filter(isHeld));
      stillPending.push(...batch.slice(batchMax));
      const fixed = byPriority(fixedPriority)(tasks.filter((t) => !isChoosable(t) && !isHeld(t)));
      const choosable = tasks.filter(isChoosable);
      if (fixed.length >= cfg.max_items_per_run) {
        stillPending.push(...fixed.slice(cfg.max_items_per_run), ...choosable);
        tasks = [...fixed.slice(0, cfg.max_items_per_run), ...batch.slice(0, batchMax)];
      } else {
        tasks = [...fixed, ...batch.slice(0, batchMax), ...choosable];
      }
    }
    const last = state.last_dispatch[key];
    const tooSoon = Boolean(last) && now - Date.parse(last) < (cfg.min_interval_min ?? 30) * 60_000;
    // 昼の予算を超えたときや間隔が短いときも、反省会の仕事は止めない。ほかの仕事だけを次の回に回す。
    if ((overDayCap || tooSoon) && tasks.some(isHanseikai)) {
      stillPending.push(...tasks.filter((t) => !isHanseikai(t)));
      tasks = tasks.filter(isHanseikai);
    }
    const exempt = tasks.every(isHanseikai);
    const capped = exempt ? overDailyCap : overDayCap;
    if (!exempt && tooSoon) { stillPending.push(...tasks); continue; }

    // 投稿する人のキーは vault にだけあるので、routine には移せない。起こせないときは保留する。
    let executor = cfg.executor;
    const managedReady = Boolean(ids.environment_id && ids.agents?.[key]?.id && ids.vaults?.[key] && process.env.BRAIN_REPO_PAT && process.env.ANTHROPIC_API_KEY);
    if (executor === 'managed' && (capped || !managedReady)) executor = 'blocked';
    if (executor === 'routine' && !routineTarget(key)) executor = 'blocked';
    const choosableNow = tasks.filter(isChoosable);
    const fixedNow = tasks.filter((t) => !isChoosable(t));
    // まとめて確かめる仕事は別に数えるので、選べる速報の件数には入れない
    const pick = choosableNow.length ? Math.min(choosableNow.length, (cfg.max_items_per_run ?? 4) - fixedNow.filter((x) => !isHeld(x)).length) : null;
    const payload = { tasks: payloadTasks([...fixedNow, ...choosableNow]), ...(pick ? { pick } : {}), day, sent_at: jstIso(now) }; // 訂正などを先に

    if (dryRun) {
      log(`[dry-run] ${key} ← ${executor}：${JSON.stringify(payload)}`);
      continue;
    }
    if (executor === 'blocked') {
      log(`${key}：起こせません（${cfg.executor === 'managed' && capped ? '今日の費用の上限' : 'Managed Agents の準備か routine の起動トークンが未設定'}）。仕事は保留します。`);
      // 費用の上限で本人を起こせないときは、補助bot に下書きを頼む。本人は費用が戻ったら確かめて、自分で書く。
      const handOver = hojoReady && cfg.executor === 'managed' && capped && SUBSTITUTABLE.includes(key)
        ? tasks.filter((t) => t.reason === 'hantei' || t.reason === 'hantei_mid_high') : [];
      for (const t of handOver) stillPending.push({ key: 'hojo', reason: 'daiko', for: key, post_ids: t.post_ids, at: jstIso(now), attempt: 1 });
      stillPending.push(...tasks.filter((t) => !handOver.includes(t)));
      continue;
    }
    try {
      let sessionId = null;
      if (executor === 'managed') {
        const s = await startSession({
          agentId: ids.agents[key].id, envId: ids.environment_id, vaultId: ids.vaults[key],
          repoToken: process.env.BRAIN_REPO_PAT, payload,
          budgetCents: Math.round((cfg.session_usd ?? routing.budget?.managed_session_usd ?? 2) * 100),
          title: `${key} ${jstIso(now)}`, metadata: { member: key, reasons: [...new Set(tasks.map((t) => t.reason))].join(',') },
        });
        sessionId = s.id;
      } else {
        await fireRoutine(routineTarget(key), payload);
      }
      state.dispatches.push({
        id: `${key}-${now.getTime()}`, key, executor, session_id: sessionId, tasks: fixedNow,
        at: jstIso(now), attempt: Math.max(1, ...fixedNow.map((t) => t.attempt ?? 1)), status: 'sent',
      });
      stillPending.push(...choosableNow); // 信長の返信がつくまで残す
      stillPending.push(...fixedNow.filter((t) => t.reason === 'an_review' && t.line_ids?.length)); // 決めていない行は、次の確認にも届ける
      if (tasks.some(isHeld)) (state.last_check ??= {})[key] = jstIso(now);
      state.last_dispatch[key] = jstIso(now);
      if (cfg.daily_max) daily[key] = (daily[key] ?? 0) + tasks.length;
      dispatched++;
      log(`${key} を起こしました（${executor}${sessionId ? ` ${sessionId}` : ''}）：${payload.tasks.map((t) => t.reason).join(', ')}`);
    } catch (err) {
      log(`${key} を起こせませんでした：${executor === 'managed' ? describeApiError(err) : describeError(err)}`);
      stillPending.push(...tasks);
    }
  }

  // 6. 状態を保存する（直近のものだけ残す）
  state.seen = [...seen].slice(-3000);
  state.pending = [...new Map(stillPending.map((t) => [taskSignature(t), t])).values()];
  const threeDaysAgo = now - 3 * 24 * 3600_000;
  state.dispatches = state.dispatches.filter((d) => Date.parse(d.at) >= threeDaysAgo);
  state.daily = Object.fromEntries(Object.entries(state.daily).slice(-10));
  state.last_run = jstIso(now);
  if (!dryRun) writeJson(statePath, state);
  log(`新着 ${fresh.length} 件（登録外の投稿者 ${ignored} 件）、新しい仕事 ${newTasks.length} 件、起こした人 ${dispatched}、保留 ${stillPending.length} 件。`);
}

main().catch((err) => {
  console.error(`エラー：${describeError(err)}`);
  process.exitCode = 1;
});
