#!/usr/bin/env node
// RSS の記録：公的機関と報道の見出しを data/rss/YYYY-MM-DD/items.json に残す。LLM は使わない。
// 評定が「物見bot が拾わなかった事案」（§10 の漏れ）を測るための材料。本文は取らない（見出し・媒体・URL・時刻だけ）。
// 見出しは外の文章なので、読む側はデータとして扱う。
//
// 使い方：node scripts/rss.mjs [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, jstIso, jstDate, parseArgs, describeError } from './lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const outRoot = typeof args.out === 'string' ? path.resolve(args.out) : path.resolve(here, '..', 'data', 'rss');

const googleNews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:1d`)}&hl=ja&gl=JP&ceid=JP:ja`;
const FEEDS = [
  { name: 'IPA', kind: 'public', url: 'https://www.ipa.go.jp/security/alert-rss.rdf' },
  { name: 'JPCERT/CC', kind: 'public', url: 'https://www.jpcert.or.jp/rss/jpcert.rdf' },
  { name: 'Security NEXT', kind: 'news', url: 'https://www.security-next.com/feed' },
  { name: 'ScanNetSecurity', kind: 'news', url: 'https://scan.netsecurity.ne.jp/rss20/index.rdf' },
  { name: 'セキュリティ対策Lab', kind: 'news', url: 'https://rocket-boys.co.jp/feed/' },
  { name: 'Google News（漏えい）', kind: 'news', url: googleNews('不正アクセス 個人情報 漏えい') },
  { name: 'Google News（AI）', kind: 'news', url: googleNews('生成AI セキュリティ 情報漏えい') },
];
const MAX_AGE_MS = 2 * 24 * 3600_000; // 古い記事の掲載が続くフィードがあるので、2 日より前は記録しない

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&')
  .trim();

function tag(block, names) {
  for (const name of names) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    if (m) return decode(m[1]);
  }
  return '';
}

/** Parses RSS 1.0 / 2.0 and Atom. Exported for tests. */
export function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
  return blocks.map((b) => {
    const atomLink = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1];
    return {
      title: tag(b, ['title']).slice(0, 200),
      url: tag(b, ['link']) || atomLink || '',
      source: tag(b, ['source']),
      published_at: tag(b, ['pubDate', 'dc:date', 'updated', 'published']),
    };
  }).filter((i) => i.title && /^https?:\/\//.test(i.url));
}

/** 媒体の違いで同じ記事が重ならないよう、見出しの空白と末尾の媒体名を落として比べる。 */
export const titleKey = (title) => title.replace(/\s+-\s+[^-]{1,40}$/, '').replace(/\s+/g, '').toLowerCase();

async function main() {
  const today = jstDate();
  const file = path.join(outRoot, today, 'items.json');
  const data = readJson(file, { date: today, items: [], errors: [] });
  const seen = new Set(data.items.map((i) => titleKey(i.title)));
  const now = Date.now();
  const errors = [];
  let added = 0;
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { 'user-agent': 'Mozilla/5.0 ais-rss', accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const item of parseFeed(await res.text())) {
        const at = Date.parse(item.published_at);
        if (!Number.isNaN(at) && now - at > MAX_AGE_MS) continue;
        const key = titleKey(item.title);
        if (seen.has(key)) continue;
        seen.add(key);
        data.items.push({
          ...item, feed: feed.name, kind: feed.kind,
          published_at: Number.isNaN(at) ? null : jstIso(new Date(at)),
          first_seen_at: jstIso(),
        });
        added++;
      }
    } catch (err) {
      errors.push({ at: jstIso(), feed: feed.name, error: describeError(err).slice(0, 200) });
    }
  }
  data.errors = [...data.errors, ...errors].slice(-20);
  data.updated_at = jstIso();
  writeJson(file, data);
  console.log(`RSS：${added} 件を追加（今日 ${data.items.length} 件、失敗したフィード ${errors.length}）。`);
}

// テストから読み込まれたときは動かさない
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(`RSS のエラー：${describeError(err)}`); process.exitCode = 1; });
}
