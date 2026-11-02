// Fire a Claude Code routine (scheduled task) through its API trigger.
// Docs: https://code.claude.com/docs/en/routines (API trigger) — the endpoint is research preview
// and ships under the experimental beta header below.

const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

/** Returns { url, token } for a member key from FIRE_URL_<KEY> / FIRE_TOKEN_<KEY>, or null. */
export function routineTarget(key, env = process.env) {
  const k = key.toUpperCase();
  const url = env[`FIRE_URL_${k}`];
  const token = env[`FIRE_TOKEN_${k}`];
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Send the wake-up payload. `payload` is a plain object that is sent as the routine's `text`
 * (the routine receives it wrapped as untrusted data). Never put post bodies in it — ids only.
 */
export async function fireRoutine(target, payload) {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.token}`,
      'anthropic-beta': ROUTINE_BETA,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: JSON.stringify(payload) }),
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`routine fire failed: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body.slice(0, 300) };
  }
}
