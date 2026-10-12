import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { selectLearnerHost } from '@/server/learner/learner-host';
import { EducationAccessError } from '@/server/commerce/education-access-service';
import { EducationProgressError } from '@/server/commerce/education-progress-service';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';

/**
 * My courses, server side: a learner's own access view, exact purchased curriculum and progress,
 * through the learner host (src/server/learner/learner-host.ts) and nothing else.
 *
 *   - Same-origin browser requests only; the body is bounded and is exactly `{service, body}`.
 *   - The learner is whoever the host's own authentication verifies for this request. A workforce
 *     session is not consulted, and nothing in the body names a person, a subject or a clinic.
 *   - Without a reviewed host (and outside the journey fixture), the answer is
 *     `learner_host_unavailable`: no ledger is constructed and nothing is read.
 *   - Identity is verified before the service call and again after it. A reply finished for a
 *     learner who is no longer verified (signed out, revoked, or someone else now) is discarded,
 *     never returned.
 *   - Every answer is private and never stored: `Cache-Control: no-store, private`.
 *   - Claims are not taken here: an access code is redeemed in the app, so this route offers only
 *     the reads and the progress writes.
 */
export const dynamic = 'force-dynamic';
const PRIVATE = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: PRIVATE });
const refuse = (status: number, code: string) => json(status, { error: { code, message: code } });
const request = z.discriminatedUnion('service', [
  z.object({ service: z.literal('education'), body: z.discriminatedUnion('action', [
    z.object({ action: z.literal('access') }).strict(),
    z.object({ action: z.literal('curriculum'), entitlementId: z.string().uuid() }).strict(),
  ]) }).strict(),
  z.object({ service: z.literal('progress'), body: z.unknown() }).strict(),
]);
const same = (a: ClinicalRequestContext, b: ClinicalRequestContext | null) => !!b
  && a.actorPersonId === b.actorPersonId
  && a.organizationId === b.organizationId
  && a.identitySubject === b.identitySubject
  && a.identityPool === b.identityPool
  && a.purpose === b.purpose
  && a.environment === b.environment
  && a.dataClassification === b.dataClassification
  && a.containsPhi === b.containsPhi
  && a.realPatientData === b.realPatientData
  && ('productionBound' in a ? a.productionBound : false) === ('productionBound' in b ? b.productionBound : false);

export async function POST(req: Request) {
  if (!sameBrowserOrigin(req)) return refuse(403, 'origin_refused');
  const host = selectLearnerHost();
  if (!host) return refuse(503, 'learner_host_unavailable');
  let parsed: z.infer<typeof request>;
  try { parsed = request.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedRequestBody(req, 16_384, 5_000)))); }
  catch { return refuse(400, 'request_invalid'); }
  let context: ClinicalRequestContext | null;
  try { context = await host.identify(req); } catch { return refuse(503, 'service_unavailable'); }
  if (!context || context.identityPool !== 'consumer' || context.purpose !== 'clinical_data') return refuse(401, 'learner_signin_required');
  let data: unknown;
  try {
    const services = host.services();
    data = parsed.service === 'education' ? await services.education(context, parsed.body) : await services.progress(context, parsed.body);
  } catch (error) {
    const category = error instanceof EducationAccessError || error instanceof EducationProgressError ? error.category : 'service_unavailable';
    // A refusal is re-checked too: an identity that lapsed meanwhile is told so, not shown a service error.
    const after = await host.identify(req).catch(() => null);
    if (!same(context, after)) return refuse(401, 'learner_signin_required');
    return refuse(category === 'request_invalid' ? 400 : category === 'identity_refused' ? 403 : 503, category);
  }
  let after: ClinicalRequestContext | null;
  try { after = await host.identify(req); } catch { return refuse(503, 'service_unavailable'); }
  if (!same(context, after)) return refuse(401, 'learner_signin_required');
  return json(200, { data, host: host.kind });
}
