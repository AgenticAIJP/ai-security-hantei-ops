#!/usr/bin/env node
// Managed Agents の準備（何度実行してもよい）。iQi が自分のターミナルで実行する。
// - 環境 ais-managed（unrestricted）を作る
// - 武将ごとの Agent ais-<key>（claude-sonnet-5-5、起動文は記憶リポジトリの prompts/_bootstrap.md）を作る・更新する
// - vault ais-<key> があるかを確かめる（キーは register.mjs が入れる）
// - --deployments：家康の定時（反省会の開会 21:20、まとめ 23:00）を作る・更新する（BRAIN_REPO_PAT が必要）
// - 作った ID（秘密ではない）を managed-agents/ids.json に書く
//
// 使い方：
//   ANTHROPIC_API_KEY=... node scripts/setup-managed.mjs --keys nobunaga
//   ANTHROPIC_API_KEY=... BRAIN_REPO_PAT=... node scripts/setup-managed.mjs --keys ieyasu --deployments
//   node scripts/setup-managed.mjs --keys nobunaga --dry-run     # 起動文を表示するだけ
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, parseArgs, jstIso } from './lib/util.mjs';
import { loadAgents } from './lib/agents.mjs';
import {
  ensureEnvironment, ensureAgent, findVault, ensureDeployment, describeApiError, AGENT_MODEL,
} from './lib/managed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const brainRoot = path.resolve(opsRoot, typeof args.brain === 'string' ? args.brain : '../ai-security-hantei');
const idsFile = path.join(opsRoot, 'managed-agents', 'ids.json');

const DEPLOYMENTS = [
  { key: 'ieyasu', name: 'AIS 家康（反省会の開会）', job: '反省会の開会', cron: '20 21 * * *' },
  { key: 'ieyasu', name: 'AIS 家康（反省会まとめ）', job: '反省会まとめ', cron: '0 23 * * *' },
];

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
  const routing = readJson(path.join(opsRoot, 'config/routing.json'));
  const agents = loadAgents(path.join(opsRoot, 'config/agents.json'));
  const managedKeys = Object.entries(routing.agents).filter(([, v]) => v.executor === 'managed').map(([k]) => k);
  const keys = typeof args.keys === 'string' ? args.keys.split(',').map((s) => s.trim()) : managedKeys;
  for (const k of keys) if (!managedKeys.includes(k)) throw new Error(`${k} は routing.json で managed ではありません。`);

  const template = bootstrapTemplate(fs.readFileSync(path.join(brainRoot, 'prompts/_bootstrap.md'), 'utf8'));
  const members = keys.map((k) => agents.find((a) => a.key === k));

  if (args['dry-run']) {
    for (const m of members) console.log(`--- ais-${m.key}（${AGENT_MODEL}）の起動文 ---\n${systemPromptFor(template, m)}\n`);
    return;
  }

  const ids = readJson(idsFile, { environment_id: null, agents: {}, vaults: {}, deployments: {} });
  const { env, created } = await ensureEnvironment();
  ids.environment_id = env.id;
  console.log(`環境 ais-managed：${created ? '作りました' : 'あります'}（${env.id}）`);

  for (const m of members) {
    const { agent, action } = await ensureAgent({
      name: `ais-${m.key}`,
      system: systemPromptFor(template, m),
      metadata: { managed_by: 'ai-security-hantei-ops', member: m.key },
    });
    ids.agents[m.key] = { id: agent.id, version: agent.version };
    console.log(`Agent ais-${m.key}：${{ created: '作りました', updated: '更新しました', unchanged: '変更なし' }[action]}（${agent.id} v${agent.version}）`);

    const vault = await findVault(`ais-${m.key}`);
    if (vault) { ids.vaults[m.key] = vault.id; console.log(`  vault ais-${m.key}：あります（${vault.id}）`); }
    else console.log(`  vault ais-${m.key}：ありません。register.mjs で登録してキーを入れてください（それまでこの人は起こせません）。`);
  }

  if (args.deployments) {
    if (!process.env.BRAIN_REPO_PAT) throw new Error('--deployments には BRAIN_REPO_PAT（記憶リポジトリの Contents だけの PAT）が必要です。');
    for (const d of DEPLOYMENTS.filter((x) => keys.includes(x.key))) {
      if (!ids.vaults[d.key]) { console.log(`定時「${d.name}」：vault がないので飛ばします。`); continue; }
      const { deployment, action } = await ensureDeployment({
        name: d.name, agentId: ids.agents[d.key].id, envId: ids.environment_id, vaultId: ids.vaults[d.key],
        repoToken: process.env.BRAIN_REPO_PAT, job: d.job, cron: d.cron,
        budgetCents: Math.round((routing.budget?.managed_session_usd ?? 2) * 100),
      });
      ids.deployments[d.name] = deployment.id;
      const next = deployment.schedule?.upcoming_runs_at?.[0];
      console.log(`定時「${d.name}」：${action === 'created' ? '作りました' : '更新しました'}（${deployment.id}、次は ${next ?? '不明'}）`);
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
