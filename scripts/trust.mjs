#!/usr/bin/env node
// 記憶リポジトリの「iQi が確かめた commit」を更新する（watcher の改ざん検知の基準）。
// 前回の基準から、Agent が書いてはいけない場所で何が変わったかを見せ、確かめてから基準を進める。
//
// 使い方：node scripts/trust.mjs [--brain ../ai-security-hantei] [--commit <sha>]
// 基準にする commit は GitHub に push 済みであること（watcher は GitHub の main を見るため）。
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, jstIso, parseArgs, confirm, describeError } from './lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const brainRoot = path.resolve(opsRoot, typeof args.brain === 'string' ? args.brain : '../ai-security-hantei');
const trustedFile = path.join(opsRoot, 'config', 'trusted.json');
const AGENT_WRITABLE = ['memory/', 'state/', 'data/', 'reports/', 'baseline/', 'eval/', 'playbook/'];

const git = (...a) => execFileSync('git', ['-C', brainRoot, ...a], { encoding: 'utf8' }).trim();

async function main() {
  const target = typeof args.commit === 'string' ? git('rev-parse', args.commit) : git('rev-parse', 'HEAD');
  const trusted = readJson(trustedFile, {});
  try {
    git('fetch', '-q', 'origin');
    const onRemote = git('branch', '-r', '--contains', target);
    if (!onRemote.includes('origin/main')) console.log('注意：この commit はまだ GitHub の main にありません。push してから基準にしてください。');
  } catch { console.log('注意：GitHub と照らし合わせられませんでした。'); }

  if (trusted.brain_commit) {
    const changed = git('diff', '--name-only', trusted.brain_commit, target).split('\n').filter(Boolean)
      .filter((f) => !AGENT_WRITABLE.some((p) => f.startsWith(p)));
    console.log(`前回の基準 ${trusted.brain_commit.slice(0, 7)} から、Agent が書いてはいけない場所で変わったファイル：${changed.length} 件`);
    for (const f of changed) console.log(`  - ${f}`);
    if (changed.length) console.log(`\n中身は次で確かめられます：git -C ${path.relative(process.cwd(), brainRoot) || '.'} diff ${trusted.brain_commit.slice(0, 7)} ${target.slice(0, 7)} -- ${changed.slice(0, 5).join(' ')}${changed.length > 5 ? ' …' : ''}\n`);
  }
  console.log(`新しい基準：${target}（${git('log', '-1', '--format=%s', target)}）`);
  if (!(await confirm('自分で変えたものだけだと確かめました。この commit を基準にしますか？'))) { console.log('やめました。'); return; }
  writeJson(trustedFile, {
    description: 'watcher の改ざん検知の基準。記憶リポジトリで、Agent が書いてよい場所以外が、この commit から変わっていたら watcher は止まる。scripts/trust.mjs で更新する。',
    brain_commit: target,
    agent_writable: AGENT_WRITABLE,
    trusted_at: jstIso(),
  });
  console.log('config/trusted.json を更新しました。ops リポジトリで commit・push してください。');
}

main().catch((err) => { console.error(`エラー：${describeError(err)}`); process.exitCode = 1; });
