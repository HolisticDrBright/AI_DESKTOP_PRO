import { describe, expect, it } from 'vitest';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement } from './program-settlement';
import { purchaseRows, PURCHASE_ROW_WORDS } from '../../lib/programs/purchaseStatus';
import { RETURN_WORDS } from '../../components/funnels/ReturnPage';
import type { VerifiedEvent } from '../stripe-boundary';
import { createClaimDelivery, deliveryKeyFor, DELIVERY_SUBJECT } from './program-claim-delivery';
import { createCommerceWorker } from './program-commerce-worker';
import { fictionalDelivery, purchaserAddress } from '../../test-support/commerceDelivery';
import type { ConsumerCaller, StaffCaller } from './program-commerce-authority';

/**
 * Work package 2: claim delivery and purchaser recovery. Each case first reproduces what the handoff
 * observed on the WP1 head; the rest proves the durable, sealed delivery that replaces it.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const binding = { organizationId: org, programId: program };
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'a'.repeat(64) };
const origin = 'https://clinic.fictional.example';
const me: OfferActor = { personId: staff, organizationId: org };
const terms = { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 };
const ACCOUNT = 'acct_FictionalAccount1';
const expected = { accountRef: ACCOUNT, apiVersion: '2025-08-27.basil' };
const alice = 'sub:fictional-alice-0001', bob = 'sub:fictional-bob-00002';
const caller = (subject: string): ConsumerCaller => ({ kind: 'consumer', personId: subject === alice ? '66666666-6666-4666-8666-000000000001' : '66666666-6666-4666-8666-000000000002', identitySubject: subject });
const staffOf = (organizationId: string): StaffCaller => ({ kind: 'staff', personId: '66666666-6666-4666-8666-000000000009', organizationId, identitySubject: 'wf:66666666-6666-4666-8666-000000000009' });

async function paidOrder() {
  let at = Date.parse('2026-10-11T12:00:00Z');
  const now = () => new Date(at);
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: curriculum } : null, now });
  const created = await offers.execute(me, { action: 'create', programId: program, terms });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  const ledger = createFictionalCheckoutLedger({ now });
  const processor = createFictionalCheckoutProcessor({ now });
  const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: origin, now });
  const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
  const order = ledger.orders.get(started.started ? started.orderId : '')!;
  processor.settle(order.processor!.sessionRef, 'paid');
  const verified: VerifiedEvent = { id: 'evt_paid', type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: order.processor!.sessionRef } } };
  await checkout.admitEvent(verified, 'raw', expected);
  await checkout.processEvent('evt_paid');
  const education = createFictionalEducationLedger({ orders: ledger, now });
  const fd = fictionalDelivery(education, now);
  // The processor-held contact for this order: what the hosted page collected. Nothing else chooses a recipient.
  fd.contacts.contacts.set(order.orderId, purchaserAddress(order.orderId));
  const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: ACCOUNT, now, sealer: fd.sealer });
  return { ledger, checkout, education, settlement, fd, order: ledger.orders.get(order.orderId)!, now, tick: (ms: number) => { at += ms; } };
}
const codesIn = (mailbox: { text: string }[]) => mailbox.map(m => /^([A-Za-z0-9_-]{43,64})$/m.exec(m.text)![1]!);
const operator = { kind: 'operator' as const, operatorId: 'op:fictional-operator-1' };

describe('reproduced on the WP1 head, and now held', () => {
  it('the staff status reply carries no code and no code digest; the claim shows its delivery state', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    await h.fd.delivery.deliverDue();
    const status = JSON.stringify(await h.education.listForProgram(staffOf(org), program));
    const hashes = [...h.education.claims.values()].map(c => c.tokenHash);
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) expect(status).not.toContain(hash);
    for (const code of codesIn(h.fd.provider.mailbox)) expect(status).not.toContain(code);
    expect(status).not.toMatch(/tokenHash|sealed|ciphertext/);
    expect(status).not.toContain(purchaserAddress(h.order.orderId));
    expect(status).toContain('"delivery":{"state":"accepted","attempts":1');
  });
  it('a settlement result and a worker report never carry the code', async () => {
    const h = await paidOrder();
    const outcome = await h.settlement.settleOrder(h.order);
    const report = await createCommerceWorker({ ledger: h.ledger, checkout: h.checkout, settlement: h.settlement, delivery: h.fd.delivery, now: h.now }).runOnce();
    const code = codesIn(h.fd.provider.mailbox)[0]!;
    expect(JSON.stringify(outcome)).not.toContain(code);
    expect(JSON.stringify(report)).not.toContain(code);
    expect(JSON.stringify(report)).not.toContain(purchaserAddress(h.order.orderId));
  });
  it('a first delivery that fails is not the end: after a restart the purchaser still receives one usable code', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    h.fd.provider.faults.next = 'unknown';
    expect(await h.fd.delivery.deliverDue()).toMatchObject({ ok: true, results: [{ state: 'provider_unknown' }] });
    expect(h.fd.provider.mailbox).toHaveLength(0);
    // The process exits. A new delivery step (same durable ledger, same sealing key) picks it up when it is due.
    h.tick(5 * 60_000);
    const restarted = createClaimDelivery({ ledger: h.education, sealer: h.fd.sealer, contacts: h.fd.contacts, provider: h.fd.provider, now: h.now });
    expect(await restarted.deliverDue()).toMatchObject({ ok: true, results: [{ state: 'accepted' }] });
    expect(h.fd.provider.mailbox).toHaveLength(1);
    expect((await h.settlement.claim(caller(alice), codesIn(h.fd.provider.mailbox)[0]!)).outcome).toBe('claimed');
  });
  it('the winning owner retrying after a lost reply gets the same receipt, not a refusal and not a second enrollment', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    const code = await h.fd.codeFor(h.order.orderId);
    const first = await h.settlement.claim(caller(alice), code);
    expect(first.outcome).toBe('claimed');
    expect(await h.settlement.claim(caller(alice), code)).toEqual(first);
    expect(h.education.enrollments.size).toBe(1);
    expect(await h.settlement.claim(caller(bob), code)).toEqual({ outcome: 'refused', reason: 'already_claimed_by_other' });
  });
  it('no staff row or return page says a code was sent while delivery has failed or is unknown', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    const kindNow = async () => purchaseRows((await h.education.listForProgram(staffOf(org), program)) as never, h.now())[0]!;
    expect((await kindNow()).kind).toBe('code_delivery_pending');
    h.fd.provider.faults.next = 'unknown';
    await h.fd.delivery.deliverDue();
    expect((await kindNow()).kind).toBe('code_delivery_unknown');
    h.tick(5 * 60_000);
    h.fd.provider.faults.next = 'refuse';
    await h.fd.delivery.deliverDue();
    const failed = await kindNow();
    expect(failed.kind).toBe('code_delivery_failed');
    for (const row of [failed]) expect(row.summary).not.toMatch(/\bsent\b/i);
    expect(RETURN_WORDS.payment_verified.detail).not.toMatch(/\bis sent\b|\bwas sent\b|\bhas been sent\b/i);
    for (const words of Object.values(PURCHASE_ROW_WORDS)) expect(words).not.toMatch(/\bcode sent\b/i);
    expect(PURCHASE_ROW_WORDS.pending_account).toMatch(/not proof/);
  });
});

describe('delivery: durable, deduplicated, bounded, and only to the processor-held contact', () => {
  it('a lost provider receipt is retried under the same key and the purchaser gets exactly one message', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    h.fd.provider.faults.next = 'accept_then_lose_reply';
    expect(await h.fd.delivery.deliverDue()).toMatchObject({ ok: true, results: [{ state: 'provider_unknown' }] });
    h.tick(5 * 60_000);
    expect(await h.fd.delivery.deliverDue()).toMatchObject({ ok: true, results: [{ state: 'accepted' }] });
    expect(h.fd.provider.mailbox).toHaveLength(1);
    const delivery = [...h.education.deliveries.values()][0]!;
    expect(delivery).toMatchObject({ state: 'accepted', attempts: 2, sealed: null });
    expect(h.fd.provider.mailbox[0]!.idempotencyKey).toBe(deliveryKeyFor(delivery.deliveryId));
  });
  it('attempts are bounded: a sixth unknown outcome is a failure, visible, with the sealed code erased', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    for (let attempt = 1; attempt <= 6; attempt++) {
      h.fd.provider.faults.next = 'unknown';
      await h.fd.delivery.deliverDue();
      h.tick(61 * 60_000);
    }
    const delivery = [...h.education.deliveries.values()][0]!;
    expect(delivery).toMatchObject({ state: 'failed', attempts: 6, sealed: null, nextAttemptAt: null });
    expect(delivery.lastOutcome).toMatch(/^attempts exhausted/);
    expect(await h.fd.delivery.deliverDue()).toEqual({ ok: true, results: [] });
  });
  it('only the payment processor\'s contact is a recipient: with none, delivery fails and nothing is sent anywhere', async () => {
    const h = await paidOrder();
    h.fd.contacts.contacts.delete(h.order.orderId);
    await h.settlement.settleOrder(h.order);
    expect(await h.fd.delivery.deliverDue()).toMatchObject({ ok: true, results: [{ state: 'failed', detail: 'no purchaser contact from the payment processor' }] });
    expect(h.fd.provider.mailbox).toHaveLength(0);
    // A contact outage is not a failure: it is retried.
    const h2 = await paidOrder();
    await h2.settlement.settleOrder(h2.order);
    h2.fd.contacts.setFailing(true);
    expect(await h2.fd.delivery.deliverDue()).toMatchObject({ ok: true, results: [{ state: 'provider_unknown' }] });
  });
  it('the message is generic: no program, curriculum, price or health word; the code appears once, as text, never in a link', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    await h.fd.delivery.deliverDue();
    const message = h.fd.provider.mailbox[0]!;
    expect(message.subject).toBe(DELIVERY_SUBJECT);
    expect(`${message.subject}\n${message.text}`).not.toMatch(/Fictional program|Fictional lesson|longevity|19\.99|1999|lab|diagnos|protocol|supplement|peptide|https?:\/\//i);
    expect(message.to).toBe(purchaserAddress(h.order.orderId));
  });
  it('an expired claim is never delivered: its sealed code is withdrawn and erased', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    h.tick(8 * 86_400_000);
    expect(await h.fd.delivery.deliverDue()).toEqual({ ok: true, results: [] });
    expect([...h.education.deliveries.values()][0]).toMatchObject({ state: 'withdrawn', sealed: null });
    expect(h.fd.provider.mailbox).toHaveLength(0);
  });
  it('a sealed code opens only for its own claim', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    const delivery = [...h.education.deliveries.values()][0]!;
    await expect(h.fd.sealer.unseal(delivery.sealed!, '00000000-0000-4000-8000-000000000000')).rejects.toThrow();
    expect(await h.fd.sealer.unseal(delivery.sealed!, delivery.claimId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('a failed backlog read is said, never "nothing to send"', async () => {
    const h = await paidOrder();
    const broken = createFictionalEducationLedger({ orders: h.ledger, faults: { before: op => { if (op === 'dueDeliveries') throw new Error('down'); } } });
    expect(await createClaimDelivery({ ledger: broken, sealer: h.fd.sealer, contacts: h.fd.contacts, provider: h.fd.provider }).deliverDue()).toEqual({ ok: false, reason: 'deliveries_unavailable' });
  });
  it('two delivery workers at once send one message', async () => {
    const h = await paidOrder();
    await h.settlement.settleOrder(h.order);
    const other = createClaimDelivery({ ledger: h.education, sealer: h.fd.sealer, contacts: h.fd.contacts, provider: h.fd.provider, now: h.now });
    const [a, b] = await Promise.all([h.fd.delivery.deliverDue(), other.deliverDue()]);
    const states = [a, b].flatMap(pass => (pass.ok ? pass.results.map(r => r.state) : []));
    expect(states.filter(state => state === 'accepted')).toHaveLength(1);
    expect(h.fd.provider.mailbox).toHaveLength(1);
  });
});

describe('claims, races and replacement', () => {
  it('both account race orders: whoever presents the code first holds it; the other is refused; one enrollment', async () => {
    for (const order of [[alice, bob], [bob, alice]] as const) {
      const h = await paidOrder();
      await h.settlement.settleOrder(h.order);
      const code = await h.fd.codeFor(h.order.orderId);
      const [first, second] = await Promise.all([h.settlement.claim(caller(order[0]), code), h.settlement.claim(caller(order[1]), code)]);
      expect(first.outcome).toBe('claimed');
      expect(second).toEqual({ outcome: 'refused', reason: 'already_claimed_by_other' });
      expect(h.education.enrollments.size).toBe(1);
      expect([...h.education.enrollments.values()][0]!.consumerSubject).toBe(order[0]);
    }
  });
  it('a replacement is an operator act that cancels every earlier code at once; a learner cannot ask for one', async () => {
    const h = await paidOrder();
    const settled = await h.settlement.settleOrder(h.order);
    const entitlementId = settled.settled ? settled.receipt.entitlement.entitlementId : '';
    const oldCode = await h.fd.codeFor(h.order.orderId);
    expect(await h.settlement.reissue({ kind: 'learner', operatorId: alice } as never, entitlementId)).toEqual({ reissued: false, reason: 'not_operator' });
    await expect(h.education.reissueClaim({ kind: 'consumer' } as never, entitlementId, null as never)).rejects.toMatchObject({ category: 'request_invalid' });
    expect(await h.settlement.reissue(operator, entitlementId)).toMatchObject({ reissued: true, superseded: 1 });
    const newCode = await h.fd.codeFor(h.order.orderId);
    expect(newCode).not.toBe(oldCode);
    expect(await h.settlement.claim(caller(alice), oldCode)).toEqual({ outcome: 'refused', reason: 'claim_superseded' });
    expect((await h.settlement.claim(caller(alice), newCode)).outcome).toBe('claimed');
    // Once held, nobody can replace it.
    expect(await h.settlement.reissue(operator, entitlementId)).toEqual({ reissued: false, reason: 'not_claimable' });
  });
  it('a replacement racing a claim of the old code: exactly one wins, in either landing order, and never both', async () => {
    const outcome = async (mode: 'race' | 'reissue_first' | 'claim_first') => {
      const h = await paidOrder();
      const settled = await h.settlement.settleOrder(h.order);
      const entitlementId = settled.settled ? settled.receipt.entitlement.entitlementId : '';
      const oldCode = await h.fd.codeFor(h.order.orderId);
      let reissue: Awaited<ReturnType<typeof h.settlement.reissue>>, claim: Awaited<ReturnType<typeof h.settlement.claim>>;
      if (mode === 'race') [reissue, claim] = await Promise.all([h.settlement.reissue(operator, entitlementId), h.settlement.claim(caller(alice), oldCode)]);
      else if (mode === 'reissue_first') { reissue = await h.settlement.reissue(operator, entitlementId); claim = await h.settlement.claim(caller(alice), oldCode); }
      else { claim = await h.settlement.claim(caller(alice), oldCode); reissue = await h.settlement.reissue(operator, entitlementId); }
      expect([...h.education.claims.values()].filter(c => c.state === 'issued' || c.state === 'used')).toHaveLength(1);
      return { reissue, claim };
    };
    const reissueWon = (r: Awaited<ReturnType<typeof outcome>>) => r.reissue.reissued === true && r.claim.outcome === 'refused' && r.claim.reason === 'claim_superseded';
    const claimWon = (r: Awaited<ReturnType<typeof outcome>>) => r.claim.outcome === 'claimed' && r.reissue.reissued === false && r.reissue.reason === 'not_claimable';
    expect(reissueWon(await outcome('reissue_first'))).toBe(true);
    expect(claimWon(await outcome('claim_first'))).toBe(true);
    const raced = await outcome('race');
    expect(reissueWon(raced) !== claimWon(raced)).toBe(true);
  });
});
