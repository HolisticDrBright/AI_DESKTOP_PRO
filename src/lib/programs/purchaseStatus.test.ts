import { describe, expect, it } from 'vitest';
import { purchaseCounts, purchaseRows, PURCHASE_ROW_WORDS, type PurchaseRowKind } from './purchaseStatus';
import { programOrder, type ProgramOrder } from '@/contracts/programCheckout';
import { programClaim, programEntitlement, type ProgramClaim, type ProgramEntitlement } from '@/contracts/programEducationAccess';

/**
 * The staff purchase rows: each order lands in exactly one kind, the kinds the handoff names are
 * distinct, a verified payment without access is "paid, not fulfilled" and never "enrolled", and
 * clinical delivery is pending for every claimed purchase because a purchase never starts it.
 */
const id = (n: number) => '91000000-0000-4000-8000-' + String(n).padStart(12, '0');
const curriculum = { versionId: id(4), version: 2, sourceDigest: 'a'.repeat(64) };
const now = new Date('2026-10-12T00:00:00Z');
const order = (n: number, state: ProgramOrder['state']): ProgramOrder => programOrder.parse({
  contract: 'program-checkout/1', orderId: id(n), organizationId: id(1), programId: id(2), offerId: id(3), offerRevision: 3, funnelSlug: 'longevity-program', curriculum,
  pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30,
  attemptKeyHash: 'b'.repeat(64), subject: { kind: 'unclaimed' }, state, revision: 2,
  processor: state === 'admitted' ? null : { provider: 'stripe', mode: 'test', sessionRef: 'cs_test_fictional' + String(n).padStart(8, '0'), expiresAt: '2026-10-11T12:30:00Z', returnSuccess: `https://clinic.fictional.example/buy/return?order=${id(n)}&returned=success`, returnCancel: `https://clinic.fictional.example/buy/return?order=${id(n)}&returned=cancel` },
  verification: ['payment_verified', 'payment_failed'].includes(state) ? { eventId: 'evt_' + n, sessionRef: 'cs_test_fictional' + String(n).padStart(8, '0'), amountMinor: 1999, currency: 'USD', paymentStatus: state === 'payment_verified' ? 'paid' : 'unpaid', accountRef: 'acct_FictionalAccount1', verifiedAt: '2026-10-11T12:10:00Z' } : null,
  createdAt: '2026-10-11T12:00:00Z', updatedAt: `2026-10-11T12:${String(n).padStart(2, '0')}:00Z`,
});
const entitlement = (n: number, state: ProgramEntitlement['state'], claimed = state !== 'awaiting_claim', endsAt: string | null = '2026-11-10T12:00:00Z'): ProgramEntitlement => programEntitlement.parse({
  contract: 'program-education-access/1', entitlementId: id(100 + n), orderId: id(n), organizationId: id(1), programId: id(2), offerId: id(3), offerRevision: 3, curriculum, accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30,
  subject: claimed ? { kind: 'claimed', consumerSubject: 'sub:fictional-alice-0001', claimedAt: '2026-10-11T12:20:00Z' } : { kind: 'unclaimed' }, state, revision: 2,
  window: claimed ? { startsAt: '2026-10-11T12:20:00Z', endsAt } : null, settlement: { verificationEventId: 'evt_' + n, settledAt: '2026-10-11T12:15:00Z' }, policy: null, createdAt: '2026-10-11T12:15:00Z', updatedAt: `2026-10-11T13:${String(n).padStart(2, '0')}:00Z`,
});
const claim = (n: number, state: ProgramClaim['state'], expiresAt = '2026-10-18T12:00:00Z'): ProgramClaim => programClaim.parse({ claimId: id(200 + n), entitlementId: id(100 + n), tokenHash: 'c'.repeat(64), issuedAt: '2026-10-11T12:15:00Z', expiresAt, state, usedAt: null, usedBy: null });

describe('purchase rows', () => {
  it('lands every order in exactly one distinct kind', () => {
    const orders = [order(1, 'checkout_open'), order(2, 'creation_unresolved'), order(3, 'checkout_expired'), order(4, 'checkout_cancelled'), order(5, 'payment_failed'), order(6, 'refused'), order(7, 'payment_verified'),
      order(8, 'payment_verified'), order(9, 'payment_verified'), order(10, 'payment_verified'), order(11, 'payment_verified'), order(12, 'payment_verified'), order(13, 'payment_verified'), order(14, 'payment_verified'), order(15, 'payment_verified')];
    const entitlements = [entitlement(8, 'awaiting_claim'), entitlement(9, 'awaiting_claim'), entitlement(10, 'active'), entitlement(11, 'active', true, '2026-10-11T23:00:00Z'), entitlement(12, 'held_refund'), entitlement(13, 'held_dispute'), entitlement(14, 'revoked'), entitlement(15, 'held_policy')];
    const claims = [claim(8, 'issued'), claim(9, 'issued', '2026-10-11T23:00:00Z')];
    const rows = purchaseRows({ orders, entitlements, claims, enrollments: [] }, now);
    const kinds = Object.fromEntries(rows.map(r => [r.orderId, r.kind])) as Record<string, PurchaseRowKind>;
    expect(kinds).toEqual({
      [id(1)]: 'checkout_open', [id(2)]: 'checkout_unresolved', [id(3)]: 'checkout_closed', [id(4)]: 'checkout_closed', [id(5)]: 'payment_failed', [id(6)]: 'order_refused', [id(7)]: 'paid_not_fulfilled',
      [id(8)]: 'pending_account', [id(9)]: 'claim_expired', [id(10)]: 'access_active', [id(11)]: 'access_expired', [id(12)]: 'held_refund', [id(13)]: 'held_dispute', [id(14)]: 'revoked', [id(15)]: 'held_policy',
    });
    for (const row of rows) { expect(row.summary).toBe(PURCHASE_ROW_WORDS[row.kind]); expect(row.terms).toContain('19.99 USD, one payment; 30 days of access; offer revision 3'); }
    expect(rows.find(r => r.orderId === id(7))).toMatchObject({ entitlementId: null, clinicalDelivery: 'not_applicable', curriculumVersion: 2 });
    expect(rows.find(r => r.orderId === id(10))).toMatchObject({ entitlementId: id(110), clinicalDelivery: 'pending_review' });
    expect(rows.find(r => r.orderId === id(8))).toMatchObject({ clinicalDelivery: 'not_applicable' });
    expect(PURCHASE_ROW_WORDS.paid_not_fulfilled).not.toMatch(/enrol/i);
    expect(PURCHASE_ROW_WORDS.access_active).toContain('not clinic membership');
    expect(rows[0]!.updatedAt >= rows[rows.length - 1]!.updatedAt).toBe(true);
    expect(purchaseCounts(rows)).toMatchObject({ checkout_closed: 2, paid_not_fulfilled: 1, access_active: 1 });
  });
});
