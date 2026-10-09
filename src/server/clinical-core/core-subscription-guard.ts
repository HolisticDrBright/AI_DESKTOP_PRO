/** Production consumer generation requires server-verified Core access, independent of clinic membership. */
export class CoreSubscriptionError extends Error {}
export async function requireConsumerCore(headers: Record<string, string | undefined>, env: Record<string, string | undefined> = process.env, request = fetch) {
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? '';
  const origin = env.BILLING_AWS_API_ORIGIN ?? '';
  if (!/^Bearer [A-Za-z0-9_.-]{40,12288}$/.test(authorization)
    || !/^https:\/\/[a-z0-9-]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin)) throw new CoreSubscriptionError('core_subscription_unavailable');
  try {
    const response = await request(`${origin}/billing/entitlements`, { headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    const value = await response.json() as { contractVersion?: string; storeEnvironment?: string; serviceAvailable?: boolean; checkedAt?: string; enabledAddOns?: unknown[]; core?: { active?: boolean; status?: string; expiresAt?: string } };
    const now = Date.now(); const checkedAt = Date.parse(value.checkedAt ?? '');
    if (value.contractVersion !== 'consumer-subscriptions/1' || value.storeEnvironment !== 'Production' || value.serviceAvailable !== true
      || !Array.isArray(value.enabledAddOns) || value.enabledAddOns.length !== 0 || value.core?.active !== true
      || !['active', 'cancelled'].includes(value.core.status ?? '') || !(Date.parse(value.core.expiresAt ?? '') > now)
      || !Number.isFinite(checkedAt) || checkedAt > now + 30000 || now - checkedAt >= 300000) throw new Error();
  } catch { throw new CoreSubscriptionError('core_subscription_unavailable'); }
}
