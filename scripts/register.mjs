#!/usr/bin/env node
// 10 件（武将 9 人と評定Claude）を TimePersona に登録する。iQi が自分のターミナルで実行する。
//
// キーの扱い（PLAN.md §4.5）：
// - 登録の応答に入っている api_key は、画面にもファイルにもログにも出さない。
// - Managed Agents の vault `ais-<key>` に API で直接入れる（--no-vault のときは Console で手で入れる）。
// - Claude Code のクラウド環境 `ais-<key>` の network secrets に貼れるよう、クリップボードに入れ、貼り終えたら消す。
// - 人物のバインドは取り消せないので、登録の前にまとめて確かめる。
// - 途中で失敗しても、キーをクリップボードに残して、手で入れられるようにする（キーは二度と表示されないため）。
//
// 使い方：
//   ANTHROPIC_API_KEY=... node scripts/register.mjs --keys nobunaga,hyojo
//   ANTHROPIC_API_KEY=... node scripts/register.mjs --all
//   node scripts/register.mjs --all --dry-run          # API を呼ばずに手順だけ表示
// オプション：
//   --brain <path>     指示リポジトリのパス（既定 ../ai-security-hantei）。ENS を両方の agents.json に書く
//   --no-vault         vault に入れない（Console の vault に手で貼る）
//   --no-clipboard     network secrets 用のクリップボード手順を飛ばす（あとで切り替えができなくなる）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgents, writeEns } from './lib/agents.mjs';
import { registerAgent, bindPersona, TP_HOST } from './lib/timepersona.mjs';
import { storeKeyInVault } from './lib/managed.mjs';
import {
  ask, confirm, parseArgs, describeError, hasClipboard, copyToClipboard, clearClipboard, sleep,
} from './lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const useVault = !args['no-vault'];
const useClipboard = !args['no-clipboard'];
const brainRoot = path.resolve(opsRoot, typeof args.brain === 'string' ? args.brain : '../ai-security-hantei');
const agentFiles = [path.join(opsRoot, 'config/agents.json'), path.join(brainRoot, 'config/agents.json')];

const REGISTERABLE = ['nobunaga', 'shingen', 'mitsuhide', 'kenshin', 'hideyoshi', 'chacha', 'ieyasu', 'nene', 'kanbei', 'hyojo'];

function pickTargets(agents) {
  let keys;
  if (args.all) keys = REGISTERABLE;
  else if (typeof args.keys === 'string') keys = args.keys.split(',').map((k) => k.trim()).filter(Boolean);
  else throw new Error('--all か --keys <key,key> を指定してください。');
  const unknown = keys.filter((k) => !REGISTERABLE.includes(k));
  if (unknown.length) throw new Error(`登録できない key です：${unknown.join(', ')}（物見bot は Grok 側で登録する）`);
  return keys.map((k) => agents.find((a) => a.key === k)).filter((a) => {
    if (!a) return false;
    if (a.ens) { console.log(`- ${a.name}：登録済み（${a.ens}）なので飛ばします`); return false; }
    return true;
  });
}

function planText(a) {
  const lines = [
    `■ ${a.name}（key: ${a.key}）`,
    `  name: ${a.name} / primary_sector: ${a.primary_sector} / model: ${a.model}`,
    `  人物のバインド：${a.character_id ? `${a.character_id}（era: sengoku）※取り消せません` : 'しない'}`,
    `  キーの置き場所：${useVault ? `vault ais-${a.key}（API で入れる）` : `vault ais-${a.key}（Console で手で貼る）`}`
      + `${useClipboard ? ` ＋ 環境 ais-${a.key} の network secrets（クリップボードで貼る）` : ''}`,
  ];
  return lines.join('\n');
}

/** Last-resort path: put the key on the clipboard so it can be pasted by hand, then clear it. */
async function handOver(key, a, where) {
  if (hasClipboard()) {
    copyToClipboard(key);
    await ask(`  キーをクリップボードに入れました。${where} に貼り付けたら Enter を押してください（そのあとクリップボードを消します）`);
    clearClipboard();
    return true;
  }
  console.log('  クリップボードが使えません。');
  if (await confirm('  キーを画面に一度だけ表示してよいですか？（表示したら、貼ったあとで画面を消してください）')) {
    console.log(`\n  ${key}\n`);
    await ask(`  ${where} に貼り付けたら Enter を押してください`);
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // clear screen and scrollback
    return true;
  }
  return false;
}

async function registerOne(a) {
  console.log(`\n=== ${a.name} ===`);
  if (dryRun) {
    console.log(`  [dry-run] POST https://${TP_HOST}/v1/agents/register`);
    if (a.character_id) console.log(`  [dry-run] POST https://${TP_HOST}/v1/agent/persona/bind (${a.character_id})`);
    console.log(`  [dry-run] vault ais-${a.key} に TIMEPERSONA_API_KEY を入れる`);
    console.log(`  [dry-run] ENS を ${agentFiles.join(' と ')} に書く`);
    return;
  }

  // 1. 登録（キーはこの変数の中にだけある）
  let apiKey;
  let ens;
  try {
    ({ ens, apiKey } = await registerAgent({
      name: a.name, description: a.description, primary_sector: a.primary_sector, model: a.model,
    }));
  } catch (err) {
    console.log(`  登録に失敗しました：${describeError(err)}`);
    return false;
  }
  console.log(`  登録しました：${ens}`);

  let keyStored = { vault: false, network: false };
  try {
    // 2. ENS をすぐに記録する（あとの手順が失敗しても、Agent ができたことは残す）
    for (const f of agentFiles) {
      try { writeEns(f, a.key, ens); } catch (err) { console.log(`  ENS を ${f} に書けませんでした：${describeError(err)}`); }
    }

    // 3. 人物のバインド（キーが手元にある今しかできない）
    if (a.character_id) {
      for (let attempt = 1; ; attempt++) {
        try {
          await bindPersona(apiKey, a.character_id, 'sengoku');
          console.log(`  人物をバインドしました：${a.character_id}`);
          break;
        } catch (err) {
          console.log(`  バインドに失敗しました（${attempt} 回目）：${describeError(err)}`);
          if (attempt >= 3 && !(await confirm('  もう一度試しますか？'))) {
            console.log('  バインドせずに進みます。あとでこの Agent のセッションからバインドする必要があります。');
            break;
          }
          await sleep(2000 * attempt);
        }
      }
    }

    // 4. vault に入れる
    if (useVault) {
      for (let attempt = 1; attempt <= 3 && !keyStored.vault; attempt++) {
        try {
          const { vaultId } = await storeKeyInVault(a.key, apiKey);
          keyStored.vault = true;
          console.log(`  vault に入れました：ais-${a.key}（${vaultId}）`);
        } catch (err) {
          console.log(`  vault に入れられませんでした（${attempt} 回目）：${describeError(err)}`);
          if (attempt < 3) await sleep(2000 * attempt);
        }
      }
    }
    if (!keyStored.vault) {
      keyStored.vault = await handOver(apiKey, a,
        `Console の vault「ais-${a.key}」の environment_variable「TIMEPERSONA_API_KEY」（ホスト ${TP_HOST}、ヘッダーのみ）`);
    }

    // 5. network secrets に貼る
    if (useClipboard) {
      keyStored.network = await handOver(apiKey, a,
        `Claude Code のクラウド環境「ais-${a.key}」の network secrets（種類 Bearer、ホスト ${TP_HOST}）`);
    }
  } catch (err) {
    console.log(`  途中で止まりました：${describeError(err)}`);
    if (!keyStored.vault && !keyStored.network) {
      console.log('  キーを失わないように、手で入れてください。');
      await handOver(apiKey, a, `vault「ais-${a.key}」と環境「ais-${a.key}」の network secrets`);
    }
  } finally {
    apiKey = undefined; // 以後、キーはどこにも残さない
  }
  return true;
}

async function main() {
  const agents = loadAgents(agentFiles[0]);
  const targets = pickTargets(agents);
  if (!targets.length) { console.log('登録する人はいません。'); return; }
  if (useVault && !dryRun && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('vault に入れるには ANTHROPIC_API_KEY が必要です（Console で手で入れるなら --no-vault）。');
  }
  if (useClipboard && !dryRun && !hasClipboard()) {
    console.log('注意：クリップボード（pbcopy）が使えません。network secrets の手順では、キーを一度だけ画面に表示するか尋ねます。');
  }

  console.log(`登録する人（${targets.length} 件）：\n`);
  for (const a of targets) console.log(`${planText(a)}\n`);
  console.log('登録すると、その Agent は TimePersona に残ります。人物のバインドは取り消せません。');
  if (!dryRun && !(await confirm('この内容で登録してよいですか？'))) { console.log('やめました。'); return; }

  for (const a of targets) {
    const ok = await registerOne(a);
    if (ok === false && !dryRun && !(await confirm('次の人に進みますか？'))) break;
  }
  console.log('\n終わりました。ENS を書いた agents.json を、両方のリポジトリで commit してください（キーは入っていません）。');
}

main().catch((err) => {
  console.error(`エラー：${describeError(err)}`);
  process.exitCode = 1;
});
