import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { __resetProgramCommerceRuntime, __setFixtureOfferOutage, selectProgramCheckout } from '@/server/commerce/program-commerce-runtime';
import { JOURNEY_FIXTURE, JOURNEY_PURCHASER_ADDRESS, __resetJourneySeed, ensureJourneySeed, journeyFixtureAllowed, publishCourse } from '@/server/commerce/journey-fixture';
import { createEducationAccessService, EducationAccessError } from '@/server/commerce/education-access-service';
import { createEducationProgressService, EducationProgressError } from '@/server/commerce/education-progress-service';
import { FICTIONAL_REVIEW_FIXTURE } from '@/server/commerce/program-commerce-authority';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '@/server/commerce/program-commerce-activation';
import { PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 } from '@/server/commerce/program-checkout-ledger-sql';
import { PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 } from '@/server/commerce/program-education-ledger-sql';
import { purchaseRows } from '@/lib/programs/purchaseStatus';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { FIXTURE_LEARNER_COOKIE, __resetLearnerHost, openFixtureLearnerSession, revokeFixtureLearnerSessions } from '@/server/learner/learner-host';
import { liveGuard } from '../../route-helpers';

/**
 * The journey fixture's stand-ins, and nothing else. It answers 404 unless the local contract
 * fixture admits this process AND COMMERCE_JOURNEY_FIXTURE=1 (journey-fixture.ts), so a deployment
 * has no such route. Each action stands in for something outside this process, never for the
 * system under test:
 *
 *   pay       the processor's hosted page: the visitor finishes, pays later, fails or abandons,
 *             and the page collects the purchaser's contact (the fictional processor's own state);
 *   work      the host's scheduler: one pass of the real commerce worker;
 *   mailbox   the purchaser's inbox: what the real claim delivery sent to the fixture address;
 *   consumer  a verified consumer session: the REAL education access and progress services, called
 *             with a fixture consumer context the identity API would otherwise build;
 *   learner_session  the consumer identity service signing a fictional learner in for the Desktop
 *             My courses page: an opaque, http-only session the fixture learner host recognises;
 *   learner_revoke   that identity service revoking the learner's sessions (signed out elsewhere);
 *   staff     a clinician of the fixture clinic: the real staff status, with the Studio's own rows;
 *   operator  a trusted operator: a replacement code, or a policy decision;
 *   publish   the Studio publishing a later course version (the stale-curriculum case);
 *   age_claim time passing for a claim (its expiry moves into the past);
 *   outage    the processor's session creation or the offer catalog going down, or coming back;
 *   reset     forget everything this fixture holds.
 * The payment event itself is NOT sent from here: the test signs it and posts it to the real
 * webhook route, which verifies the signature over the exact bytes like any processor event.
 */
export const dynamic = 'force-dynamic';
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const learner = z.enum(['a', 'b']);
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reset') }).strict(),
  z.object({ action: z.literal('pay'), orderId: z.string().uuid(), outcome: z.enum(['paid', 'processing', 'succeeded_async', 'failed_async', 'expired']) }).strict(),
  z.object({ action: z.literal('work') }).strict(),
  z.object({ action: z.literal('mailbox') }).strict(),
  z.object({ action: z.literal('consumer'), learner, service: z.enum(['access', 'progress']), body: z.unknown() }).strict(),
  z.object({ action: z.literal('staff') }).strict(),
  z.object({ action: z.literal('learner_session'), learner }).strict(),
  z.object({ action: z.literal('learner_revoke'), learner }).strict(),
  z.object({ action: z.literal('operator'), op: z.enum(['reissue', 'refund', 'operator_release']), orderId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('publish'), variant: z.enum(['first', 'later']) }).strict(),
  z.object({ action: z.literal('age_claim'), orderId: z.string().uuid(), days: z.number().int().min(1).max(30) }).strict(),
  z.object({ action: z.literal('outage'), target: z.enum(['processor', 'catalog']), down: z.boolean() }).strict(),
]);

/** Activation evidence for the fixture's services: its reviewer is the fixture, and it exists only in this process. */
const fixtureEvidence = { contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'f'.repeat(64), reviewedBy: FICTIONAL_REVIEW_FIXTURE, reviewedAt: '2026-10-12T00:00:00Z' };
const consumerContext = (who: 'a' | 'b'): ClinicalRequestContext => ({
  actorPersonId: JOURNEY_FIXTURE.learners[who].personId, organizationId: JOURNEY_FIXTURE.organizationId, identityPool: 'consumer', identitySubject: JOURNEY_FIXTURE.learners[who].identitySubject,
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false,
} as ClinicalRequestContext);

export async function POST(req: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!journeyFixtureAllowed()) return json(404, { error: { code: 'not_found', message: 'not_found' } });
  let body: z.infer<typeof request>;
  try { body = request.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(req, 16_384, 5000)))); }
  catch { return json(400, { error: { code: 'invalid', message: 'request_invalid' } }); }
  if (body.action === 'reset') {
    __resetProgramCommerceRuntime(); __resetJourneySeed(); __resetLearnerHost();
    await ensureJourneySeed();
    return json(200, { data: { reset: true } });
  }
  await ensureJourneySeed();
  const selection = selectProgramCheckout();
  if (selection.kind !== 'fictional') return json(503, { error: { code: 'unavailable', message: 'checkout_unconfigured' } });
  switch (body.action) {
    case 'pay': {
      const order = await selection.ledger.readOrder(body.orderId);
      if (!order?.processor) return json(404, { error: { code: 'not_found', message: 'no session for this order' } });
      selection.processor.settle(order.processor.sessionRef, body.outcome);
      selection.contacts.contacts.set(order.orderId, JOURNEY_PURCHASER_ADDRESS);
      return json(200, { data: { sessionRef: order.processor.sessionRef, accountRef: selection.expected.accountRef, apiVersion: selection.expected.apiVersion } });
    }
    case 'work': {
      const report = await selection.worker.runOnce();
      return json(200, { data: { intake: report.intake, reconcile: report.reconcile, settlement: report.settlement.ok ? { ok: true, settled: report.settlement.outcomes.length } : report.settlement, delivery: report.delivery, expiry: report.expiry.ok ? { ok: true, expired: report.expiry.expired.length } : report.expiry, status: report.status } });
    }
    case 'mailbox':
      return json(200, { data: { messages: selection.mailbox.filter(message => message.to === JOURNEY_PURCHASER_ADDRESS) } });
    case 'consumer': {
      try {
        const reply = body.service === 'access'
          ? await createEducationAccessService({ settlement: selection.settlement, activation: fixtureEvidence, checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, expectedCheckoutSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, expectedEducationSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 })(consumerContext(body.learner), body.body)
          : await createEducationProgressService({ ledger: selection.education, activation: fixtureEvidence, progressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, expectedProgressSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256 })(consumerContext(body.learner), body.body);
        return json(200, { data: reply });
      } catch (error) {
        const category = error instanceof EducationAccessError || error instanceof EducationProgressError ? error.category : 'service_unavailable';
        return json(category === 'request_invalid' ? 400 : category === 'identity_refused' ? 403 : 503, { error: { code: category, message: category } });
      }
    }
    case 'learner_session': {
      const response = json(200, { data: { learner: body.learner } });
      response.cookies.set(FIXTURE_LEARNER_COOKIE, openFixtureLearnerSession(body.learner), { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
      return response;
    }
    case 'learner_revoke':
      return json(200, { data: { revoked: revokeFixtureLearnerSessions(body.learner) } });
    case 'staff': {
      const staff = { kind: 'staff' as const, personId: JOURNEY_FIXTURE.staffPersonId, organizationId: JOURNEY_FIXTURE.organizationId, identitySubject: 'wf:' + JOURNEY_FIXTURE.staffPersonId };
      const commercial = await selection.education.listForProgram(staff, JOURNEY_FIXTURE.programId);
      return json(200, { data: { commercial, rows: purchaseRows(commercial as never, new Date()) } });
    }
    case 'operator': {
      const operator = { kind: 'operator' as const, operatorId: 'op:journey-fixture-operator' };
      if (body.op === 'reissue') {
        const entitlement = await selection.education.entitlementForOrder(body.orderId);
        if (!entitlement) return json(404, { error: { code: 'not_found', message: 'no entitlement for this order' } });
        return json(200, { data: await selection.settlement.reissue(operator, entitlement.entitlementId) });
      }
      return json(200, { data: await selection.settlement.recordPolicy(operator, body.orderId, body.op, `journey-fixture-${body.op}`) });
    }
    case 'publish':
      publishCourse(body.variant);
      return json(200, { data: { published: body.variant } });
    case 'age_claim': {
      const entitlement = await selection.education.entitlementForOrder(body.orderId);
      if (!entitlement) return json(404, { error: { code: 'not_found', message: 'no entitlement for this order' } });
      for (const claim of selection.education.claims.values()) {
        if (claim.entitlementId === entitlement.entitlementId && claim.state === 'issued') {
          selection.education.claims.set(claim.claimId, { ...claim, expiresAt: new Date(Date.parse(claim.expiresAt) - body.days * 86_400_000).toISOString() });
        }
      }
      return json(200, { data: { aged: body.days } });
    }
    case 'outage':
      if (body.target === 'processor') selection.processor.faults.createSession = body.down ? 'unavailable' : undefined;
      else __setFixtureOfferOutage(body.down);
      return json(200, { data: { target: body.target, down: body.down } });
  }
}
