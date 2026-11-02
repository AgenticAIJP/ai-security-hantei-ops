// TimePersona API client for the ops scripts (registration and the watcher).
// The hyphen host is the one the vault credentials are bound to; never use the underscore host.

export const TP_HOST = 'api-timepersona.jp.ai';
export const TP_BASE = `https://${TP_HOST}/v1`;

async function call(method, pathname, { body, apiKey, query } = {}) {
  const url = new URL(`${TP_BASE}${pathname}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
  if (!res.ok) {
    // Error bodies never contain our key; still, keep them short.
    const detail = json?.error ?? json?.message ?? text.slice(0, 300);
    const err = new Error(`TimePersona ${method} ${pathname} failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (json === undefined) throw new Error(`TimePersona ${method} ${pathname}: response is not JSON`);
  return json;
}

/**
 * Register a new agent. Returns only { ens, apiKey } — the caller must never print or persist apiKey.
 * Response per skill.md: { success, ens, message, api_key } (api_key is shown only once).
 */
export async function registerAgent({ name, description, primary_sector, model }) {
  const res = await call('POST', '/agents/register', { body: { name, description, primary_sector, model } });
  const ens = res.ens;
  const apiKey = res.api_key;
  if (typeof ens !== 'string' || typeof apiKey !== 'string' || !apiKey) {
    throw new Error('登録の応答に ens か api_key がありません（キーは表示しません）');
  }
  return { ens, apiKey };
}

/** Bind a historical persona. Irreversible on the server side. */
export async function bindPersona(apiKey, characterId, eraId) {
  return call('POST', '/agent/persona/bind', { apiKey, body: { character_id: characterId, era_id: eraId } });
}

/**
 * Posts in a room, oldest first. The API has no cursor: only `limit` (we use 100) and newest-first order,
 * with pinned posts returned separately — so merge both lists and let the caller de-duplicate by id.
 */
export async function recentRoomPosts(roomId, limit = 100) {
  const res = await call('GET', '/posts/recent', { query: { room: roomId, limit } });
  const byId = new Map();
  for (const p of [...(res.pinned_posts ?? []), ...(res.posts ?? [])]) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
}

/** One post, including root_post_id (absent on root posts). */
export async function getPost(id) {
  return call('GET', `/posts/${encodeURIComponent(id)}`);
}

export { call as tpCall };
