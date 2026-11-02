#!/usr/bin/env node
// Managed Agents の準備（何度実行してもよい）。iQi が自分のターミナルで実行する。
// - 環境 ais-managed（unrestricted）を作る
// - 投稿する人ごとの Agent ais-<key>（モデルは config/agents.json、起動文は指示リポジトリの prompts/_bootstrap.md）を作る・更新する
// - その人の vault を metadata.agent_key で探す（キーは指示リポジトリの scripts/register-agents.mjs が入れた）
// - --deployments：--keys に入っている人の定時（下の DEPLOYMENTS）を作る・更新する
// - 作った ID（秘密ではない）を managed-agents/ids.json に書く
//
// 使い方：
//   ANTHROPIC_API_KEY=... node scripts/setup-managed.mjs --keys nobunaga
//   ANTHROPIC_API_KEY=... BRAIN_REPO_PAT=... node scripts/setup-managed.mjs --keys hyojo --deployments   # 読み取り専用の PAT
//   node scripts/setup-managed.mjs --keys nobunaga --dry-run     # 起動文と定時を表示するだけ
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, parseArgs, jstIso } from './lib/util.mjs';
import { loadAgents } from './lib/agents.mjs';
import {
  ensureEnvironment, ensureAgent, findVaultByAgentKey, ensureDeployment, describeApiError,
} from './lib/managed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const brainRoot = path.resolve(opsRoot, typeof args.brain === 'string' ? args.brain : '../ai-security-hantei');
const idsFile = path.join(opsRoot, 'managed-agents', 'ids.json');

const DEPLOYMENTS = [
  { key: 'nene', name: 'AIS 寧々（一番手柄）', job: '一番手柄', cron: '10 8 * * *' },
  { key: 'nene', name: 'AIS 寧々（日次総括）', job: '日次総括', cron: '5 21 * * *' },
  { key: 'ieyasu', name: 'AIS 家康（反省会の開会）', job: '反省会の開会', cron: '20 21 * * *' },
  { key: 'ieyasu', name: 'AIS 家康（反省会まとめ）', job: '反省会まとめ', cron: '0 23 * * *' },
  { key: 'hyojo', name: 'AIS 評定', job: '評定', cron: '40 23 * * *' },
];

const sessionBudgetCents = (routing, key) => Math.round((routing.agents[key]?.session_usd ?? routing.budget?.managed_session_usd ?? 2) * 100);

/** Pull the 起動文 template (the first fenced block under "## 1. 起動文") out of prompts/_bootstrap.md. */
export function bootstrapTemplate(markdown) {
  const start = markdown.indexOf('## 1. 起動文');
  if (start === -1) throw new Error('prompts/_bootstrap.md に「## 1. 起動文」がありません。');
  const m = /```\n([\s\S]*?)```/.exec(markdown.slice(start));
  if (!m) throw new Error('起動文のコードブロックが見つかりません。');
  return m[1].trim();
}

export function systemPromptFor(template, member) {
  return template
    .replaceAll('{表示名}', member.name)
    .replaceAll('{key}', member.key)
    .replaceAll('{仕事}', '最初のメッセージの job に従う（job がなければ tasks に従う）');
}

async function main() {
  // 途中で止まらないよう、何も作る前に確かめる
  if (args.deployments && !args['dry-run'] && !process.env.BRAIN_REPO_PAT) {
    throw new Error('--deployments には BRAIN_REPO_PAT（指示リポジトリの Contents を読むだけの PAT）が必要です。');
  }
  const routing = readJson(path.join(opsRoot, 'config/routing.json'));
  const agents = loadAgents(path.join(opsRoot, 'config/agents.json'));
  const managedKeys = Object.entries(routing.agents).filter(([, v]) => v.executor === 'managed').map(([k]) => k);
  const keys = typeof args.keys === 'string' ? args.keys.split(',').map((s) => s.trim()) : managedKeys;
  for (const k of keys) if (!managedKeys.includes(k)) throw new Error(`${k} は routing.json で managed ではありません。`);

  const template = bootstrapTemplate(fs.readFileSync(path.join(brainRoot, 'prompts/_bootstrap.md'), 'utf8'));
  const members = keys.map((k) => agents.find((a) => a.key === k));

  if (args['dry-run']) {
    for (const m of members) {
      console.log(`--- ais-${m.key}（${m.model}、1 回の上限 $${sessionBudgetCents(routing, m.key) / 100}）の起動文 ---\n${systemPromptFor(template, m)}\n`);
      for (const d of DEPLOYMENTS.filter((x) => x.key === m.key)) console.log(`定時：${d.name}  cron「${d.cron}」 job「${d.job}」`);
    }
    return;
  }

  const ids = readJson(idsFile, { environment_id: null, agents: {}, vaults: {}, deployments: {} });
  const { env, created } = await ensureEnvironment();
  ids.environment_id = env.id;
  console.log(`環境 ais-managed：${created ? '作りました' : 'あります'}（${env.id}）`);

  for (const m of members) {
    const { agent, action } = await ensureAgent({
      name: `ais-${m.key}`,
      model: m.model,
      system: systemPromptFor(template, m),
      metadata: { managed_by: 'ai-security-hantei-ops', member: m.key },
    });
    ids.agents[m.key] = { id: agent.id, version: agent.version };
    console.log(`Agent ais-${m.key}：${{ created: '作りました', updated: '更新しました', unchanged: '変更なし' }[action]}（${agent.id} v${agent.version}）`);

    const vault = await findVaultByAgentKey(m.key);
    if (vault) { ids.vaults[m.key] = vault.id; console.log(`  vault「${vault.display_name}」：あります（${vault.id}）`); }
    else console.log(`  vault（agent_key: ${m.key}）：ありません。指示リポジトリの scripts/register-agents.mjs で登録してください（それまでこの人は起こせません）。`);
  }

  // 定時の作成で止まっても、作った ID を失わないように先に保存する
  ids.updated_at = jstIso();
  writeJson(idsFile, ids);

  if (args.deployments) {
    for (const d of DEPLOYMENTS.filter((x) => keys.includes(x.key))) {
      if (!ids.vaults[d.key]) { console.log(`定時「${d.name}」：vault がないので飛ばします。`); continue; }
      const { deployment, action } = await ensureDeployment({
        name: d.name, agentId: ids.agents[d.key].id, envId: ids.environment_id, vaultId: ids.vaults[d.key],
        repoToken: process.env.BRAIN_REPO_PAT, job: d.job, cron: d.cron,
        budgetCents: sessionBudgetCents(routing, d.key),
      });
      ids.deployments[d.name] = deployment.id;
      const next = deployment.schedule?.upcoming_runs_at?.[0];
      console.log(`定時「${d.name}」：${action === 'created' ? '作りました' : '更新しました'}（${deployment.id}、次は ${next ? jstIso(new Date(next)) : '不明'}）`);
    }
  }

  ids.updated_at = jstIso();
  writeJson(idsFile, ids);
  console.log(`\nID を ${path.relative(opsRoot, idsFile)} に書きました（秘密ではありません。commit してください）。`);
}

main().catch((err) => {
  console.error(`エラー：${describeApiError(err)}`);
  process.exitCode = 1;
});
