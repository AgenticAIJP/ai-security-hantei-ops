// Shared helpers for the ops scripts. Nothing here ever handles secret values except
// copyToClipboard / clearClipboard, which pass the value straight to pbcopy's stdin.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO 8601 string in JST, e.g. 2026-11-02T15:30:00+09:00 */
export function jstIso(date = new Date()) {
  const t = new Date(date.getTime() + JST_OFFSET_MS);
  return t.toISOString().replace(/\.\d{3}Z$/, '+09:00');
}

/** JST calendar date, e.g. 2026-11-02 */
export function jstDate(date = new Date()) {
  return jstIso(date).slice(0, 10);
}

/** Day number counted from day1 (JST), so day1 itself is 1. */
export function dayNumber(day1, date = new Date()) {
  const start = Date.parse(`${day1}T00:00:00+09:00`);
  const today = Date.parse(`${jstDate(date)}T00:00:00+09:00`);
  return Math.floor((today - start) / 86_400_000) + 1;
}

export function readJson(file, fallback = undefined) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return structuredClone(fallback);
    throw new Error(`file not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Print an error without dumping request objects (which may carry secrets in bodies or headers).
 * Only the class name, HTTP status, and message are shown.
 */
export function describeError(err) {
  if (!err) return 'unknown error';
  const status = err.status ? ` (HTTP ${err.status})` : '';
  const name = err.constructor?.name && err.constructor.name !== 'Error' ? `${err.constructor.name}: ` : '';
  return `${name}${err.message ?? String(err)}${status}`;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[name] = next; i++; } else { args[name] = true; }
  }
  return args;
}

export async function ask(question) {
  if (!process.stdin.isTTY) throw new Error('対話が必要です。ターミナルで直接実行してください。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question) {
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

export function hasClipboard() {
  return process.platform === 'darwin' && spawnSync('which', ['pbcopy']).status === 0;
}

/** Copy a value to the macOS clipboard via stdin (the value never appears in argv or on screen). */
export function copyToClipboard(value) {
  const r = spawnSync('pbcopy', [], { input: value });
  if (r.status !== 0) throw new Error('pbcopy failed');
}

export function clearClipboard() {
  spawnSync('pbcopy', [], { input: '' });
}
