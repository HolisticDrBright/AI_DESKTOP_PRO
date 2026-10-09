import { describe, expect, it, vi } from 'vitest';
import { requireConsumerCore } from './core-subscription-guard';

const env = { BILLING_AWS_API_ORIGIN: 'https://billing123.execute-api.us-east-2.amazonaws.com' };
const headers = { authorization: `Bearer ${'a'.repeat(50)}` };
describe('production consumer Core guard', () => {
  it('refuses missing billing configuration without invoking another service', async () => {
    const request = vi.fn(); await expect(requireConsumerCore(headers, {}, request)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it('requires current production entitlement, never a synthetic entitlement', async () => {
    const now = Date.now();
    const value = { contractVersion: 'consumer-subscriptions/1', serviceAvailable: true, storeEnvironment: 'Production', enabledAddOns: [],
      checkedAt: new Date(now).toISOString(), core: { active: true, status: 'active', expiresAt: new Date(now + 60000).toISOString() } };
    const request = vi.fn(async () => new Response(JSON.stringify(value)));
    await expect(requireConsumerCore(headers, env, request)).resolves.toBeUndefined();
    value.storeEnvironment = 'Sandbox'; await expect(requireConsumerCore(headers, env, request)).rejects.toThrow();
    value.storeEnvironment = 'Production'; value.core.active = false; await expect(requireConsumerCore(headers, env, request)).rejects.toThrow();
  });
});
