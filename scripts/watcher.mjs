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
import { startSession, sessionCost, sessionOutcome, deploymentCostCents, describeApiError } from './lib/managed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const brainRoot = path.resolve(process.cwd(), typeof args.brain === 'string' ? args.brain : path.join(opsRoot, '../ai-security-hantei'));
const dryRun = Boolean(args['dry-run']);
const statePath = path.join(opsRoot, 'state', 'watcher.json');

const MEMBERS = ['nobunaga', 'shingen', 'mitsuhide', 'kenshin', 'hideyoshi', 'chacha', 'ieyasu', 'nene', 'kanbei'];
const SHORT_NAMES = { nobunaga: '信長', shingen: '信玄', mitsuhide: '光秀', kenshin: '謙信', hideyoshi: '秀吉', chacha: '茶々', ieyasu: '家康', nene: '寧々', kanbei: '官兵衛' };
const ANALYSTS = ['shingen', 'chacha', 'hideyoshi', 'mitsuhide'];
const REVIEW_TAGS = new Set(['判定', '判定まとめ', '続報', '独立判定', '技術分析', '反論', '攻め手の読み', '制度の視点', '速報']);
// Git に書いてよい場所（CLAUDE.md §4）。書くのは素の Claude だけ。これ以外が変わっていたら止まる。
const AGENT_WRITABLE = ['baseline/', 'state/acks/'];
const SHORT_RECORD = /[：:]\s*(対象外|記録のみ|枠外)/; // 信長の短い投稿の 1 行目（PLAN.md §2.2）
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
  return `${t.key}|${t.reason}|${taskIds(t).join(',')}`;
}

/** Merge tasks with the same reason into one entry for the payload (ids only, never post bodies). */
function payloadTasks(tasks) {
  const merged = new Map();
  for (const t of tasks) {
    if (t.reason === 'baseline_case') { merged.set(`b:${t.incident_id}`, { reason: t.reason, incident_id: t.incident_id, root_post_id: t.root_post_id }); continue; }
    if (t.reason === 'eval_correction') { merged.set(`e:${t.post_ids.join(',')}`, { reason: t.reason, post_ids: t.post_ids, report_post_id: t.report_post_id }); continue; }
    const k = t.reason;
    const entry = merged.get(k) ?? { reason: t.reason, ...(t.rss_paths ? { rss_paths: [] } : { post_ids: [] }) };
    for (const id of t.post_ids ?? []) if (!entry.post_ids.includes(id)) entry.post_ids.push(id);
    for (const p of t.rss_paths ?? []) if (!entry.rss_paths.includes(p)) entry.rss_paths.push(p);
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

  const POST_LIMIT = 1000;
  const posts = await recentRoomPosts(routing.room_id, POST_LIMIT);
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

    if (ak === 'monomi' && tag === 'X速報') add('nobunaga', 'x_sokuho', { post_ids: [p.id] });
    if (ak.startsWith('trusted:') && (tag === 'X速報' || tag === '速報') && !p.quoted_post_id) add('nobunaga', 'sokuho_other', { post_ids: [p.id] });

    // 信長の短い投稿（記録のみ・対象外）では、分析役を起こさない
    const isHantei = ak === 'nobunaga' && (tag === '判定' || tag === '続報');
    const shortRecord = isHantei && SHORT_RECORD.test(firstLine(p.content));
    if (isHantei && !shortRecord) {
      // 全員で議論する件数の上限。信長も数えて振り分けるが、ここでも止める
      if ((daily.hantei ?? 0) >= discussionAllowed()) {
        log(`今の議論の枠 ${discussionAllowed()} 件に達しているので、分析役を起こしません（${p.id}）。`);
      } else {
        daily.hantei = (daily.hantei ?? 0) + 1;
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
    }
    // 事実の点検は、記録のみの投稿にも行う（速報の大半が記録のみになるため）。対象外だけを除く
    const outOfScope = isHantei && OUT_OF_SCOPE.test(firstLine(p.content));
    if (isTeam && ak !== 'kenshin' && REVIEW_TAGS.has(tag) && !outOfScope) add('kenshin', 'review', { post_ids: [p.id] });

    if ((ak === 'kenshin' && tag === '目付') || (ak === 'monomi' && tag === 'X調査回答')) {
      if (!p.quoted_post_id) continue;
      try {
        const q = await getPost(p.quoted_post_id);
        const target = authorKey(q.agent);
        if (MEMBERS.includes(target)) add(target, ak === 'kenshin' ? 'correction_request' : 'x_answer', { post_ids: [p.id] });
        else if (target === 'monomi') log(`物見bot あての【目付】があります（${p.id}）。Grok に伝えてください。`);
      } catch (err) { log(`引用元を読めませんでした（${p.quoted_post_id}）：${describeError(err)}`); }
    }

    if (ak === 'ieyasu' && tag === '反省会' && !p.quoted_post_id) for (const m of MEMBERS) add(m, 'hanseikai_open', { post_ids: [p.id] });

    // 評定の訂正の依頼は、評定Claude の ENS の投稿からだけ受け取る。ID の形だけを通し、指示文を起動文に混ぜさせない。
    if (ak === 'hyojo' && tag === '評定') {
      for (const m of p.content.matchAll(/^■ 訂正の依頼[：:]\s*([a-z]+)\s+([0-9a-f]{24})/gm)) {
        if (MEMBERS.includes(m[1])) add(m[1], 'eval_correction', { post_ids: [m[2]], report_post_id: p.id });
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

  // 3. 仕事が終わったかの確認と起こし直し。二重投稿は tp.mjs が止めるので、やり直しても残りの分だけが投稿される。
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
      const acks = ackedIds(d.key);
      if (d.tasks.flatMap(taskIds).every((id) => acks.has(id))) { d.status = 'done'; continue; }
      if (now - Date.parse(d.at) < ackTimeoutMs) continue;
      why = '受け取りの記録がありません';
      redo = d.tasks.filter((t) => !taskIds(t).every((id) => acks.has(id)));
    }
    if (d.attempt <= maxRetries) {
      for (const t of redo) newTasks.push({ ...t, attempt: d.attempt + 1, at: jstIso(now) });
      d.status = 'retried';
      log(`${d.key}：${why}。起こし直します（${d.attempt + 1} 回目）。`);
    } else {
      d.status = 'failed';
      state.alerts.push({ at: jstIso(now), type: 'not_finished', key: d.key, dispatch: d.id, why });
      log(`${d.key}：${why}。${d.attempt} 回起こしても終わらないので、iQi が確かめてください。`);
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
  const dailyCap = routing.budget?.managed_daily_usd ?? 60;
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
  const isAnswered = (t) => isChoosable(t) && (t.post_ids ?? []).every((id) => answered.has(id));

  // 5. まとめて起こす
  const pendingBySig = new Map(state.pending.map((t) => [taskSignature(t), t]));
  for (const t of newTasks) if (!pendingBySig.has(taskSignature(t))) pendingBySig.set(taskSignature(t), t);
  // 速さは求めないので、費用の上限で止まった仕事も翌日に回す。48 時間たったものだけ捨てる。
  const allPending = [...pendingBySig.values()].filter((t) => !isAnswered(t));
  const pending = allPending.filter((t) => now - Date.parse(t.at) < 48 * 3600_000);
  if (allPending.length > pending.length) log(`48 時間たっても処理できなかった仕事を ${allPending.length - pending.length} 件捨てました。`);
  const byKey = new Map();
  for (const t of pending) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);

  const stillPending = [];
  let dispatched = 0;
  for (const [key, tasksAll] of byKey) {
    const cfg = routing.agents[key];
    if (!cfg) { log(`routing.json にない人です：${key}`); continue; }
    if (cfg.active_from && today < cfg.active_from) continue; // まだ有効でない人あての仕事は捨てる
    // 反省会の仕事を先にする（1 回に 1 件の人でも、点検と応答が遅れないように）
    let tasks = [...tasksAll].sort((a, b) => Number(isHanseikai(b)) - Number(isHanseikai(a)));
    if (cfg.daily_max) {
      const room = Math.max(0, cfg.daily_max - (daily[key] ?? 0));
      if (tasks.length > room) log(`${key}：今日の上限 ${cfg.daily_max} 件を超える分は扱いません。`);
      tasks = tasks.slice(0, room);
      if (!tasks.length) continue;
    }
    if (cfg.max_items_per_run) {
      // 質を保つため、1 回に扱う件数を絞る。残りは次の回に回す。選べる速報は、あとで pick 件だけ選ばせる。
      const fixed = tasks.filter((t) => !isChoosable(t));
      const choosable = tasks.filter(isChoosable);
      if (fixed.length >= cfg.max_items_per_run) {
        stillPending.push(...fixed.slice(cfg.max_items_per_run), ...choosable);
        tasks = fixed.slice(0, cfg.max_items_per_run);
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
    const pick = choosableNow.length ? Math.min(choosableNow.length, (cfg.max_items_per_run ?? 4) - fixedNow.length) : null;
    const payload = { tasks: payloadTasks([...fixedNow, ...choosableNow]), ...(pick ? { pick } : {}), day, sent_at: jstIso(now) }; // 訂正などを先に

    if (dryRun) {
      log(`[dry-run] ${key} ← ${executor}：${JSON.stringify(payload)}`);
      continue;
    }
    if (executor === 'blocked') {
      log(`${key}：起こせません（${cfg.executor === 'managed' && capped ? '今日の費用の上限' : 'Managed Agents の準備か routine の起動トークンが未設定'}）。仕事は保留します。`);
      stillPending.push(...tasks);
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
