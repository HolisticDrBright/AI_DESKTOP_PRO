import { describe, expect, it, vi } from 'vitest';
import { requireConsumerCore, requireQualificationConsumerCore } from './core-subscription-guard';

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
  it('refuses an oversized or falsely sized billing reply before trusting its entitlement', async () => {
    const now = Date.now();
    const valid = { contractVersion: 'consumer-subscriptions/1', serviceAvailable: true, storeEnvironment: 'Production', enabledAddOns: [],
      checkedAt: new Date(now).toISOString(), core: { active: true, status: 'active', expiresAt: new Date(now + 60000).toISOString() } };
    const oversized = vi.fn(async () => new Response(JSON.stringify({ ...valid, padding: 'x'.repeat(70000) })));
    await expect(requireConsumerCore(headers, env, oversized)).rejects.toThrow('core_subscription_unavailable');
    const falseLength = vi.fn(async () => new Response(JSON.stringify(valid), { headers: { 'content-length': '70000' } }));
    await expect(requireConsumerCore(headers, env, falseLength)).rejects.toThrow('core_subscription_unavailable');
  });
  it('qualification admits only a fresh Sandbox Core answer from its own configured API', async () => {
    const now = Date.now();
    const value = { contractVersion: 'consumer-subscriptions/1', serviceAvailable: true, storeEnvironment: 'Sandbox', enabledAddOns: [],
      checkedAt: new Date(now).toISOString(), core: { active: true, status: 'active', expiresAt: new Date(now + 60000).toISOString() } };
    const qualification = { QUALIFICATION_BILLING_API_ORIGIN: 'https://billing123.execute-api.us-east-2.amazonaws.com' };
    const request = vi.fn(async () => new Response(JSON.stringify(value)));
    await expect(requireQualificationConsumerCore(headers.authorization, qualification, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(`${qualification.QUALIFICATION_BILLING_API_ORIGIN}/billing/entitlements`, expect.objectContaining({
      headers: { authorization: headers.authorization }, redirect: 'error',
    }));
    await expect(requireQualificationConsumerCore(headers.authorization, env, request)).rejects.toThrow('core_subscription_unavailable');
    value.storeEnvironment = 'Production';
    await expect(requireQualificationConsumerCore(headers.authorization, qualification, request)).rejects.toThrow('core_subscription_unavailable');
    value.storeEnvironment = 'Sandbox'; value.core.active = false;
    await expect(requireQualificationConsumerCore(headers.authorization, qualification, request)).rejects.toThrow('core_subscription_unavailable');
  });
});
