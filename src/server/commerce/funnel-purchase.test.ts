import { afterEach, describe, expect, it, vi } from 'vitest';
import { funnelPurchaseAvailability } from './funnel-purchase';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { __resetProgramCommerceRuntime, fictionalCurriculumDigest, fictionalPersonId, selectProgramOfferLedger } from './program-commerce-runtime';
import { PURCHASE_HOLD_EXPLANATIONS } from '../../contracts/programOffers';

/**
 * The buy choice as the server answers it: an unbound page, a disabled ledger, a failed read and a
 * real offer are four different answers; outside the local fixture this process has no ledger at all.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222';
const binding = { programBinding: { organizationId: org, programId: program } };
afterEach(() => { vi.unstubAllEnvs(); __resetProgramCommerceRuntime(); });

describe('the runtime selection', () => {
  it('has no ledger outside the local contract fixture, and the fictional one under it', () => {
    expect(selectProgramOfferLedger({})).toEqual({ kind: 'disabled', reason: 'commerce_disabled' });
    expect(selectProgramOfferLedger({ CLINICAL_CONTRACT_FIXTURE: '1', CLINICAL_SUPABASE_URL: 'https://urcjiehlxoehievobezf.supabase.co' }).kind).toBe('disabled');
    expect(selectProgramOfferLedger({ CLINICAL_CONTRACT_FIXTURE: '1', CLINICAL_SUPABASE_URL: 'https://fictional.example' }).kind).toBe('disabled');
    expect(selectProgramOfferLedger({ CLINICAL_CONTRACT_FIXTURE: '1', CLINICAL_SUPABASE_URL: 'http://127.0.0.1:3999' }).kind).toBe('fictional');
    // The deployed-runtime refusal reads the process, not the argument: a production-mode server has no ledger even on loopback.
    vi.stubEnv('NODE_ENV', 'production');
    expect(selectProgramOfferLedger({ CLINICAL_CONTRACT_FIXTURE: '1', CLINICAL_SUPABASE_URL: 'http://127.0.0.1:3999' }).kind).toBe('disabled');
  });
  it('derives a stable fictional actor and a fictional curriculum digest that is not confused with the SQL one', () => {
    expect(fictionalPersonId('a@b.example')).toBe(fictionalPersonId(' A@B.example '));
    expect(fictionalPersonId('a@b.example')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fictionalPersonId('a@b.example')).not.toBe(fictionalPersonId('c@d.example'));
    expect(fictionalCurriculumDigest(null)).toBeNull();
    expect(fictionalCurriculumDigest({ title: 'x', phases: [] })).toBeNull();
    expect(fictionalCurriculumDigest({ title: 'x', phases: [{ id: 'p' }] })).toMatch(/^[a-f0-9]{64}$/);
    expect(fictionalCurriculumDigest({ title: 'x', phases: [{ id: 'p' }] })).not.toBe(fictionalCurriculumDigest({ title: 'x', phases: [{ id: 'q' }] }));
  });
});

describe('the buy choice', () => {
  it('is unavailable for an unbound page before any ledger is consulted', async () => {
    const ledger = createFictionalProgramOfferLedger({ curriculum: async () => { throw new Error('must not be read'); } });
    expect(await funnelPurchaseAvailability({ programBinding: null }, { kind: 'fictional', ledger, registerCurriculum: () => undefined })).toEqual({ available: false, reason: 'program_unbound', explanation: PURCHASE_HOLD_EXPLANATIONS.program_unbound });
  });
  it('is unavailable as "not switched on" when this process has no ledger', async () => {
    expect(await funnelPurchaseAvailability(binding, { kind: 'disabled', reason: 'commerce_disabled' })).toMatchObject({ available: false, reason: 'commerce_disabled' });
    expect(await funnelPurchaseAvailability(binding)).toMatchObject({ available: false, reason: 'commerce_disabled' });
  });
  it('follows the ledger: absent, draft, available on exact terms, changed, and "could not be checked" on a failure', async () => {
    const current = { versionId: '33333333-3333-4333-8333-333333333333', version: 1, sourceDigest: 'a'.repeat(64) };
    const state = { current: current as typeof current | null, fail: false };
    const ledger = createFictionalProgramOfferLedger({ curriculum: async (o, p) => { if (state.fail) throw new Error('fictional outage'); return o === org && p === program ? { programId: p, current: state.current } : null; } });
    const selection = { kind: 'fictional' as const, ledger, registerCurriculum: () => undefined };
    const me: OfferActor = { personId: '44444444-4444-4444-8444-444444444444', organizationId: org };
    expect(await funnelPurchaseAvailability(binding, selection)).toMatchObject({ reason: 'offer_absent' });
    const created = await ledger.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    expect(await funnelPurchaseAvailability(binding, selection)).toMatchObject({ reason: 'offer_draft' });
    await ledger.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await ledger.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
    expect(await funnelPurchaseAvailability(binding, selection)).toMatchObject({ available: true, offerId, revision: 3, pricing: { amountMinor: 1999 }, accessDurationDays: 90 });
    state.current = { ...current, sourceDigest: 'b'.repeat(64) };
    expect(await funnelPurchaseAvailability(binding, selection)).toMatchObject({ reason: 'curriculum_changed' });
    state.fail = true;
    expect(await funnelPurchaseAvailability(binding, selection)).toMatchObject({ reason: 'commerce_unverifiable' });
    expect(await funnelPurchaseAvailability({ programBinding: { organizationId: '55555555-5555-4555-8555-555555555555', programId: program } }, { ...selection })).toMatchObject({ reason: 'commerce_unverifiable' });
  });
});
