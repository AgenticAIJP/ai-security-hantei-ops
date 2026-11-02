// Read config/agents.json and write ENS values back without disturbing its one-object-per-entry layout.
import fs from 'node:fs';

export function loadAgents(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Map of ENS -> member key, for every entry that has an ENS. */
export function ensIndex(agents) {
  const index = new Map();
  for (const a of agents) if (a.ens) index.set(a.ens.toLowerCase(), a.key);
  return index;
}

/**
 * Set `"ens":null` to the given ENS for one key, keeping the file's hand-made formatting.
 * Falls back to a full rewrite only if the targeted replacement does not apply.
 */
export function writeEns(file, key, ens) {
  if (!/^[a-z0-9-]+\.jpyon\.eth$/i.test(ens)) throw new Error(`unexpected ENS format: ${ens}`);
  const text = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`(\\{"key":"${key}"[^\\n]*?"ens":)(null|"[^"]*")`);
  let next = text.replace(pattern, `$1"${ens}"`);
  if (next === text) {
    const agents = JSON.parse(text);
    const entry = agents.find((a) => a.key === key);
    if (!entry) throw new Error(`key not found in ${file}: ${key}`);
    entry.ens = ens;
    next = `${JSON.stringify(agents, null, 2)}\n`;
  }
  JSON.parse(next); // never leave a broken file behind
  fs.writeFileSync(file, next);
}
