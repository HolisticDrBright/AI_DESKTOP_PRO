/** Production consumer generation requires server-verified Core access, independent of clinic membership. */
export class CoreSubscriptionError extends Error {}
const MAX_REPLY_BYTES = 16_384;
type Request = typeof fetch;

export async function requireConsumerCore(headers: Record<string, string | undefined>, env: Record<string, string | undefined> = process.env, request: Request = fetch) {
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? '';
  return requireCore(authorization, env.BILLING_AWS_API_ORIGIN ?? '', 'Production', request);
}

/** Fictional qualification still checks the actual, current Sandbox billing entitlement; it never uses the
 * synthetic-testflight client bypass. An absent billing service or an unreviewed origin refuses every consumer call. */
export async function requireQualificationConsumerCore(authorization: string, env: Record<string, string | undefined> = process.env, request: Request = fetch) {
  return requireCore(authorization, env.QUALIFICATION_BILLING_API_ORIGIN ?? '', 'Sandbox', request);
}

async function requireCore(authorization: string, origin: string, storeEnvironment: 'Production' | 'Sandbox', request: Request): Promise<void> {
  if (!/^Bearer [A-Za-z0-9_.-]{40,12288}$/.test(authorization)
    || !/^https:\/\/[a-z0-9-]+\.execute-api\.us-east-2\.amazonaws\.com$/.test(origin)) throw new CoreSubscriptionError('core_subscription_unavailable');
  try {
    const response = await request(`${origin}/billing/entitlements`, { headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedReply(response))) as {
      contractVersion?: string; storeEnvironment?: string; serviceAvailable?: boolean; checkedAt?: string; enabledAddOns?: unknown[];
      core?: { active?: boolean; status?: string; expiresAt?: string };
    };
    const now = Date.now(); const checkedAt = Date.parse(value.checkedAt ?? '');
    if (value.contractVersion !== 'consumer-subscriptions/1' || value.storeEnvironment !== storeEnvironment || value.serviceAvailable !== true
      || !Array.isArray(value.enabledAddOns) || value.enabledAddOns.length !== 0 || value.core?.active !== true
      || !['active', 'cancelled'].includes(value.core.status ?? '') || !(Date.parse(value.core.expiresAt ?? '') > now)
      || !Number.isFinite(checkedAt) || checkedAt > now + 30000 || now - checkedAt >= 300000) throw new Error();
  } catch { throw new CoreSubscriptionError('core_subscription_unavailable'); }
}

async function boundedReply(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REPLY_BYTES)) throw new Error('billing_reply_too_large');
  if (!response.body) throw new Error('billing_reply_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPLY_BYTES) {
        await reader.cancel();
        throw new Error('billing_reply_too_large');
      }
      chunks.push(value);
    }
    if (total === 0 || (declared !== null && total !== Number(declared))) throw new Error('billing_reply_incomplete');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}
