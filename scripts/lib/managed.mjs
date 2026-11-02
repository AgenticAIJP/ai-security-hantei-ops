// Claude Managed Agents helpers (@anthropic-ai/sdk 1.3.0, beta; the SDK adds the beta header itself).
// Shapes verified against the installed SDK's type definitions.
import Anthropic from '@anthropic-ai/sdk';

export const ENV_NAME = 'ais-managed';
export const TP_HOST = 'api-timepersona.jp.ai';
export const SECRET_NAME = 'TIMEPERSONA_API_KEY';
export const REPO_URL = 'https://github.com/AgenticAIJP/ai-security-hantei';
export const REPO_MOUNT = '/workspace/ai-security-hantei';

// bash・ファイル・web_search・web_fetch。無人なので、承認待ちで止まらない always_allow にする。
export const AGENT_TOOLS = [{
  type: 'agent_toolset_20260401',
  default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
}];

let client;
export function anthropic() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY がありません。');
    // logLevel 'warn'：ANTHROPIC_LOG=debug だと、リクエストの本文（秘密の値を含む）がログに出るため上書きする。
    client = new Anthropic({ logLevel: 'warn', maxRetries: 2 });
  }
  return client;
}

/** Short, secret-free description of an SDK error (status, type, request id, server message). */
export function describeApiError(err) {
  if (!(err instanceof Anthropic.APIError)) return err?.message ?? String(err);
  const msg = err.error?.error?.message ?? err.message;
  return `HTTP ${err.status ?? '-'} ${err.type ?? ''} ${msg} (request ${err.requestID ?? '-'})`.trim();
}

// ---- vaults（キーの金庫） -------------------------------------------------------------

export async function findVault(displayName) {
  for await (const v of anthropic().beta.vaults.list()) if (v.display_name === displayName) return v;
  return null;
}

/** 登録スクリプトが作った vault を、決まった値の metadata.agent_key で探す（表示名は人が見るためのもの）。 */
export async function findVaultByAgentKey(agentKey) {
  for await (const v of anthropic().beta.vaults.list()) if (v.metadata?.agent_key === agentKey) return v;
  return null;
}

async function ensureVault(displayName, memberKey) {
  return (await findVault(displayName))
    ?? anthropic().beta.vaults.create({ display_name: displayName, metadata: { managed_by: 'ai-security-hantei-ops', member: memberKey } });
}

/**
 * Put the TimePersona key into vault `ais-<memberKey>` as an environment_variable credential.
 * The sandbox only ever sees a placeholder; the real value is substituted at egress, in headers only,
 * and only for requests to api-timepersona.jp.ai. The secret value is never returned by the API.
 */
export async function storeKeyInVault(memberKey, apiKey) {
  const vault = await ensureVault(`ais-${memberKey}`, memberKey);
  const auth = {
    type: 'environment_variable',
    secret_name: SECRET_NAME,
    secret_value: apiKey,
    networking: { type: 'limited', allowed_hosts: [TP_HOST] },
    injection_location: { header: true },
  };
  for await (const c of anthropic().beta.vaults.credentials.list(vault.id)) {
    if (c.auth?.type === 'environment_variable' && c.auth.secret_name === SECRET_NAME) {
      await anthropic().beta.vaults.credentials.update(c.id, { vault_id: vault.id, auth: { type: 'environment_variable', secret_value: apiKey } });
      return { vaultId: vault.id, credentialId: c.id, updated: true };
    }
  }
  const cred = await anthropic().beta.vaults.credentials.create(vault.id, { display_name: 'TimePersona API key', auth });
  return { vaultId: vault.id, credentialId: cred.id, updated: false };
}

// ---- environment と agent -------------------------------------------------------------

export async function ensureEnvironment() {
  for await (const e of anthropic().beta.environments.list({ include_archived: false })) if (e.name === ENV_NAME) return { env: e, created: false };
  const env = await anthropic().beta.environments.create({
    name: ENV_NAME,
    // unrestricted：limited だと web_search・web_fetch も許可したホストしか読めず、一次出典を調べられない。
    // セッションの中に本物の秘密はない（キーは vault、GitHub のトークンは git のプロキシ）。
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
    metadata: { managed_by: 'ai-security-hantei-ops' },
  });
  return { env, created: true };
}

export async function findAgent(name) {
  for await (const a of anthropic().beta.agents.list({ include_archived: false })) if (a.name === name) return a;
  return null;
}

/** Create the agent, or update it only when the system prompt, model, or tools changed. */
export async function ensureAgent({ name, model, system, metadata }) {
  const existing = await findAgent(name);
  if (!existing) {
    const a = await anthropic().beta.agents.create({ name, model, system, tools: AGENT_TOOLS, metadata });
    return { agent: a, action: 'created' };
  }
  const currentModel = typeof existing.model === 'string' ? existing.model : existing.model?.id;
  const same = existing.system === system && currentModel === model
    && JSON.stringify(existing.tools ?? []).includes('agent_toolset_20260401')
    && JSON.stringify(existing.tools ?? []).includes('always_allow');
  if (same) return { agent: existing, action: 'unchanged' };
  const a = await anthropic().beta.agents.update(existing.id, { version: existing.version, model, system, tools: AGENT_TOOLS, metadata });
  return { agent: a, action: 'updated' };
}

// ---- sessions ---------------------------------------------------------------------------

// 指示リポジトリは公開なので、トークンを渡さずに clone する。トークンがなければ Agent は push できない。
const REPO_RESOURCE = { type: 'github_repository', url: REPO_URL, checkout: { type: 'branch', name: 'main' }, mount_path: REPO_MOUNT };

/** Start one session for a member. `payload` is the wake-up JSON (ids only, never post bodies). */
export async function startSession({ agentId, envId, vaultId, payload, budgetCents, title, metadata }) {
  return anthropic().beta.sessions.create({
    agent: agentId,
    environment_id: envId,
    vault_ids: [vaultId],
    resources: [REPO_RESOURCE],
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
    budget: { type: 'limit', max_list_cost: { amount: String(Math.round(budgetCents)), currency: 'USD' } },
    title,
    metadata,
  });
}

/** Returns { status, costCents|null } for a session. */
export async function sessionCost(sessionId) {
  const s = await anthropic().beta.sessions.retrieve(sessionId);
  const amount = s.usage?.list_cost?.amount;
  return { status: s.status, costCents: amount == null ? null : Number(amount) };
}

/**
 * Did the session finish its work? Agents no longer write acks to Git, so this replaces them.
 * running: still working. done: stopped normally. failed: budget, errors, or waiting on something.
 */
export async function sessionOutcome(sessionId) {
  const s = await anthropic().beta.sessions.retrieve(sessionId);
  if (s.status === 'running' || s.status === 'rescheduling') return { state: 'running' };
  if (s.status === 'terminated') return { state: 'failed', reason: 'terminated' };
  for await (const e of anthropic().beta.sessions.events.list(sessionId, { types: ['session.status_idle'], order: 'desc', limit: 1 })) {
    const reason = e.stop_reason?.type ?? 'unknown';
    return reason === 'end_turn' ? { state: 'done' } : { state: 'failed', reason };
  }
  return { state: 'running' }; // idle だが、記録がまだ届いていない
}

// ---- deployments（Managed Agents の定時） ---------------------------------------------

export async function ensureDeployment({ name, agentId, envId, vaultId, job, cron, budgetCents }) {
  const params = {
    name,
    agent: agentId, // 文字列で渡すと、作成・更新のときの最新版に固定される
    environment_id: envId,
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: JSON.stringify({ job }) }] }],
    schedule: { type: 'cron', expression: cron, timezone: 'Asia/Tokyo' },
    vault_ids: [vaultId],
    resources: [REPO_RESOURCE],
    budget: { type: 'limit', max_list_cost: { amount: String(Math.round(budgetCents)), currency: 'USD' } },
  };
  for await (const d of anthropic().beta.deployments.list({ agent_id: agentId })) {
    if (d.name === name) {
      // Agent を更新したら、deployment も新しい版に動かす（作成時の版に固定されるため）
      const updated = await anthropic().beta.deployments.update(d.id, params);
      return { deployment: updated, action: 'updated' };
    }
  }
  const created = await anthropic().beta.deployments.create(params);
  return { deployment: created, action: 'created' };
}
