import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFictionalProgramOfferLedger, type OfferActor } from './program-offer-ledger';
import { createProgramCheckout } from './program-checkout';
import { createFictionalCheckoutLedger } from './program-checkout-ledger';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import { createFictionalEducationLedger } from './program-education-ledger';
import { createProgramSettlement } from './program-settlement';
import { createEducationProgressService, EducationProgressError } from './education-progress-service';
import { fictionalDelivery } from '../../test-support/commerceDelivery';
import { FICTIONAL_COURSE_TITLE, fictionalCoursePhases } from '../../test-support/commerceCourse';
import { courseLessons, educationProgress, isCompleted, neighbours, resumeLesson, type EducationProgressRequest } from '../../contracts/programEducationProgress';
import type { ConsumerCaller } from './program-commerce-authority';
import type { VerifiedEvent } from '../stripe-boundary';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';

/**
 * Work package 4, the learner's own progress (program-education-progress/1) over the fictional
 * ledgers: explicit completion with a receipt, idempotent retries, two devices, resume, and every
 * refusal named by the contract. Progress is bookkeeping; nothing here is clinical.
 */
const org = '11111111-1111-4111-8111-111111111111', program = '22222222-2222-4222-8222-222222222222', staff = '33333333-3333-4333-8333-333333333333';
const curriculum = { versionId: '44444444-4444-4444-8444-444444444444', version: 1, sourceDigest: 'c'.repeat(64) };
const me: OfferActor = { personId: staff, organizationId: org };
const alice: ConsumerCaller = { kind: 'consumer', personId: '66666666-6666-4666-8666-000000000001', identitySubject: 'sub:fictional-alice-0001' };
const bob: ConsumerCaller = { kind: 'consumer', personId: '66666666-6666-4666-8666-000000000002', identitySubject: 'sub:fictional-bob-00002' };
const operator = { kind: 'operator' as const, operatorId: 'op:fictional-operator-1' };
const expected = { accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
const PROGRESS_SHA = '7'.repeat(64);

async function harness() {
  let clock = Date.parse('2026-10-11T12:00:00Z');
  const now = () => new Date(clock);
  const offers = createFictionalProgramOfferLedger({ curriculum: async (o, p) => o === org && p === program ? { programId: p, current: curriculum } : null, now });
  const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
  const offerId = created.action === 'create' ? created.offer.offerId : '';
  await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
  await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  const ledger = createFictionalCheckoutLedger({ now });
  const processor = createFictionalCheckoutProcessor({ now });
  const checkout = createProgramCheckout({ offers, ledger, processor, publicOrigin: 'https://clinic.fictional.example', now });
  const content = { title: FICTIONAL_COURSE_TITLE, phases: fictionalCoursePhases, sourceDigest: curriculum.sourceDigest };
  let contentDown = false;
  const education = createFictionalEducationLedger({ orders: ledger, now, content: async binding => { if (contentDown) throw new Error('down'); return binding.versionId === curriculum.versionId ? content : null; } });
  const delivery = fictionalDelivery(education, now);
  const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => content, expectedAccountRef: expected.accountRef, now, sealer: delivery.sealer });
  async function purchase(attemptKey: string, owner: ConsumerCaller) {
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey });
    const order = ledger.orders.get(started.started ? started.orderId : '')!;
    processor.settle(order.processor!.sessionRef, 'paid');
    const event: VerifiedEvent = { id: 'evt_' + attemptKey, type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: order.processor!.sessionRef } } };
    await checkout.admitEvent(event, 'raw', expected);
    await checkout.processEvent(event.id);
    await settlement.settleOrder(order);
    const claimed = await settlement.claim(owner, await delivery.codeFor(order.orderId));
    if (claimed.outcome !== 'claimed') throw new Error('claim refused: ' + claimed.reason);
    const enrollment = [...education.enrollments.values()].find(n => n.entitlementId === claimed.entitlement.entitlementId)!;
    return { orderId: order.orderId, entitlementId: claimed.entitlement.entitlementId, enrollmentId: enrollment.enrollmentId };
  }
  const write = (bought: { entitlementId: string; enrollmentId: string }, action: 'complete' | 'position', lesson: { phaseId: string; itemId: string }, expectedRevision: number, requestId = randomUUID()): Extract<EducationProgressRequest, { action: 'complete' | 'position' }> =>
    ({ action, entitlementId: bought.entitlementId, enrollmentId: bought.enrollmentId, curriculum, lesson, expectedRevision, requestId });
  return { education, settlement, purchase, write, tick: (ms: number) => { clock += ms; }, setContentDown: (down: boolean) => { contentDown = down; } };
}
const lessonA = { phaseId: 'phase-1', itemId: 'lesson-a' }, habitB = { phaseId: 'phase-1', itemId: 'habit-b' }, supplementC = { phaseId: 'phase-1', itemId: 'supplement-c' };
const lessonD = { phaseId: 'phase-1', itemId: 'lesson-d' }, lessonE = { phaseId: 'phase-2', itemId: 'lesson-e' };

describe('the course, read from the served phases only', () => {
  it('names why an outline is not the whole course, and never aliases a lesson (mirrored contract, hardening WP1)', () => {
    expect(courseLessons(fictionalCoursePhases)).toMatchObject({ complete: true, problem: null });
    const reused = courseLessons([fictionalCoursePhases[0], { ...fictionalCoursePhases[1], items: [{ ...(fictionalCoursePhases[1] as { items: object[] }).items[0], id: 'lesson-a' }] }]);
    expect(reused).toEqual({ lessons: [], complete: false, problem: 'ambiguous' });
    expect(courseLessons(Array.from({ length: 53 }, (_, i) => ({ id: `phase-${i}`, title: 'x', items: [] }))).problem).toBe('oversized');
    const twice = { lesson: lessonA, completedAt: '2026-10-11T12:00:00Z', requestId: randomUUID() };
    expect(educationProgress.safeParse({ contract: 'program-education-progress/1', entitlementId: randomUUID(), enrollmentId: randomUUID(), curriculum, revision: 2, completed: [twice, { ...twice, requestId: randomUUID() }], position: null, updatedAt: null }).success).toBe(false);
  });
  it('lists every lesson in order, marks what may be completed, and says when part of the course could not be read', () => {
    const { lessons, complete } = courseLessons(fictionalCoursePhases);
    expect(complete).toBe(true);
    expect(lessons.map(l => `${l.ref.itemId}:${l.completable}`)).toEqual(['lesson-a:true', 'habit-b:true', 'supplement-c:false', 'lesson-d:false', 'lesson-e:true']);
    expect(neighbours(lessons, lessonA)).toMatchObject({ previous: null, next: { ref: habitB } });
    expect(neighbours(lessons, lessonE)).toMatchObject({ previous: { ref: lessonD }, next: null });
    const damaged = courseLessons([fictionalCoursePhases[0], { id: 'phase-x', title: 'x', items: [{ id: 'only-a-title' }] }]);
    expect(damaged.complete).toBe(false);
    expect(damaged.lessons).toHaveLength(4);
    // Resume: the recorded position; otherwise the first released lesson not yet completed; never a guess.
    expect(resumeLesson(lessons, null)?.ref).toEqual(lessonA);
    expect(resumeLesson(lessons, { completed: [{ lesson: lessonA, completedAt: '2026-10-11T12:00:00Z', requestId: randomUUID() }], position: null })?.ref).toEqual(habitB);
    expect(resumeLesson(lessons, { completed: [], position: lessonE })?.ref).toEqual(lessonE);
    expect(resumeLesson(lessons, { completed: [], position: { phaseId: 'phase-9', itemId: 'gone' } })?.ref).toEqual(lessonA);
    expect(resumeLesson([], null)).toBeNull();
  });
});

describe('progress through the fictional ledger', () => {
  it('reading records nothing; an explicit completion records once with a receipt, and a retry converges on the same receipt', async () => {
    const h = await harness();
    const bought = await h.purchase('browser-a', alice);
    const first = await h.education.progress(alice, bought.entitlementId);
    expect(first).toMatchObject({ outcome: 'read', progress: { revision: 0, completed: [], position: null, curriculum } });
    expect((await h.education.progress(alice, bought.entitlementId))).toEqual(first);
    const command = h.write(bought, 'complete', lessonA, 0);
    const done = await h.education.recordProgress(alice, command);
    expect(done).toMatchObject({ outcome: 'recorded', receipt: { requestId: command.requestId, action: 'complete', lesson: lessonA, revision: 1 }, progress: { revision: 1, completed: [{ lesson: lessonA, requestId: command.requestId }] } });
    // The reply was lost; the device sends the same request again: same receipt, still one completion, revision unchanged.
    const again = await h.education.recordProgress(alice, command);
    expect(again).toEqual(done);
    expect(again.outcome === 'recorded' && again.progress.completed).toHaveLength(1);
    // A request id names one write.
    expect(await h.education.recordProgress(alice, { ...command, lesson: habitB })).toEqual({ outcome: 'refused', reason: 'request_conflict', progress: null });
  });
  it('two devices: a write against an older revision is refused with the current record, never merged or overwritten', async () => {
    const h = await harness();
    const bought = await h.purchase('browser-a', alice);
    expect((await h.education.recordProgress(alice, h.write(bought, 'complete', lessonA, 0))).outcome).toBe('recorded');
    const stale = await h.education.recordProgress(alice, h.write(bought, 'position', lessonE, 0));
    expect(stale).toMatchObject({ outcome: 'refused', reason: 'revision_stale', progress: { revision: 1, completed: [{ lesson: lessonA }], position: null } });
    // The second device re-reads and writes at the current revision.
    const moved = await h.education.recordProgress(alice, h.write(bought, 'position', lessonE, 1));
    expect(moved).toMatchObject({ outcome: 'recorded', progress: { revision: 2, position: lessonE, completed: [{ lesson: lessonA }] } });
    const read = await h.education.progress(alice, bought.entitlementId);
    expect(read.outcome === 'read' && isCompleted(read.progress, lessonA)).toBe(true);
    expect(read.outcome === 'read' && resumeLesson(courseLessons(fictionalCoursePhases).lessons, read.progress)?.ref).toEqual(lessonE);
  });
  it('refuses another owner, another enrollment, an older version, an unknown lesson, a supplement or unreleased step, and an inactive course', async () => {
    const h = await harness();
    const bought = await h.purchase('browser-a', alice);
    const bobs = await h.purchase('browser-b', bob);
    expect(await h.education.progress(bob, bought.entitlementId)).toEqual({ outcome: 'refused', reason: 'not_owner' });
    expect(await h.education.recordProgress(bob, h.write(bought, 'complete', lessonA, 0))).toEqual({ outcome: 'refused', reason: 'not_owner', progress: null });
    expect(await h.education.recordProgress(alice, { ...h.write(bought, 'complete', lessonA, 0), enrollmentId: bobs.enrollmentId })).toEqual({ outcome: 'refused', reason: 'enrollment_mismatch', progress: null });
    expect(await h.education.recordProgress(alice, { ...h.write(bought, 'complete', lessonA, 0), curriculum: { ...curriculum, version: 2 } })).toEqual({ outcome: 'refused', reason: 'stale_version', progress: null });
    expect(await h.education.recordProgress(alice, h.write(bought, 'complete', { phaseId: 'phase-1', itemId: 'lesson-z' }, 0))).toEqual({ outcome: 'refused', reason: 'unknown_lesson', progress: null });
    expect(await h.education.recordProgress(alice, h.write(bought, 'complete', { phaseId: 'phase-2', itemId: 'lesson-a' }, 0))).toEqual({ outcome: 'refused', reason: 'unknown_lesson', progress: null });
    expect(await h.education.recordProgress(alice, h.write(bought, 'complete', supplementC, 0))).toEqual({ outcome: 'refused', reason: 'not_completable', progress: null });
    expect(await h.education.recordProgress(alice, h.write(bought, 'complete', lessonD, 0))).toEqual({ outcome: 'refused', reason: 'not_completable', progress: null });
    // Reading a supplement step is a position, not a start: allowed, and nothing is completed.
    expect(await h.education.recordProgress(alice, h.write(bought, 'position', supplementC, 0))).toMatchObject({ outcome: 'recorded', progress: { completed: [], position: supplementC } });
    // A policy hold makes the course inactive: writes are refused and nothing is recorded.
    await h.settlement.recordPolicy(operator, bought.orderId, 'refund', 're_fictional_1');
    expect(await h.education.recordProgress(alice, h.write(bought, 'complete', lessonA, 1))).toEqual({ outcome: 'refused', reason: 'not_active', progress: null });
    // An ended window is inactive too.
    h.tick(31 * 86_400_000);
    expect(await h.education.recordProgress(bob, h.write(bobs, 'complete', lessonA, 0))).toEqual({ outcome: 'refused', reason: 'not_active', progress: null });
    expect((await h.education.progress(alice, bought.entitlementId))).toMatchObject({ outcome: 'read', progress: { revision: 1, completed: [] } });
  });
});

describe('the progress bridge', () => {
  const context = (over: Partial<ClinicalRequestContext> = {}): ClinicalRequestContext => ({ actorPersonId: alice.personId, organizationId: org, identityPool: 'consumer', identitySubject: alice.identitySubject, purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false, ...over } as ClinicalRequestContext);
  const evidence = { contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: '4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f', evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' };
  it('is disabled without exact evidence, refuses every identity but a consumer, takes the caller from the context, and says an outage instead of "no progress"', async () => {
    const h = await harness();
    const bought = await h.purchase('browser-a', alice);
    const service = (over: Record<string, unknown> = {}) => createEducationProgressService({ ledger: h.education, activation: evidence, progressCandidateSha256: PROGRESS_SHA, expectedProgressSha256: PROGRESS_SHA, ...over });
    const refusal = async (work: Promise<unknown>) => { try { await work; } catch (error) { if (error instanceof EducationProgressError) return error.category; throw error; } return 'none'; };
    expect(await refusal(service({ activation: undefined })(context(), { action: 'read', entitlementId: bought.entitlementId }))).toBe('activation_refused');
    expect(await refusal(service({ progressCandidateSha256: 'f'.repeat(64) })(context(), { action: 'read', entitlementId: bought.entitlementId }))).toBe('activation_refused');
    expect(await refusal(service()(context({ identityPool: 'workforce' }), { action: 'read', entitlementId: bought.entitlementId }))).toBe('identity_refused');
    expect(await refusal(service()(context({ purpose: 'consent_management' }), { action: 'read', entitlementId: bought.entitlementId }))).toBe('identity_refused');
    // A subject in the body is not read: the request is refused as invalid.
    expect(await refusal(service()(context(), { action: 'read', entitlementId: bought.entitlementId, consumerSubject: bob.identitySubject }))).toBe('request_invalid');
    expect(await service()(context(), { action: 'read', entitlementId: bought.entitlementId })).toMatchObject({ action: 'read', read: { outcome: 'read', progress: { revision: 0 } } });
    // Bob's verified context cannot read Alice's course by naming it.
    expect(await service()(context({ actorPersonId: bob.personId, identitySubject: bob.identitySubject }), { action: 'read', entitlementId: bought.entitlementId })).toEqual({ action: 'read', read: { outcome: 'refused', reason: 'not_owner' } });
    const write = h.write(bought, 'complete', lessonA, 0);
    expect(await service()(context(), write)).toMatchObject({ action: 'complete', outcome: { outcome: 'recorded', receipt: { requestId: write.requestId } } });
    // The content store is down: a write cannot be validated, and the bridge says unavailable, never "recorded" or "refused".
    h.setContentDown(true);
    expect(await refusal(service()(context(), h.write(bought, 'complete', habitB, 1)))).toBe('service_unavailable');
    h.setContentDown(false);
    expect((await h.education.progress(alice, bought.entitlementId))).toMatchObject({ outcome: 'read', progress: { revision: 1 } });
  });
});
