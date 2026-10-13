import { NextResponse } from 'next/server';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { selectStaffMediaHost } from '@/server/programs/learner-media-staff-host';
import { LearnerMediaError } from '@/server/programs/learner-media';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';

/**
 * Staff view of one admitted lesson media slot (program-learner-media-staff/1), through the WORKFORCE
 * host only. No reviewed workforce host is installed by this source, so the answer is
 * `staff_media_host_unavailable` and nothing is read. When one is installed: same-origin only, a
 * bounded body, the clinician verified before and after the read, and a reply finished for someone who
 * is no longer verified is discarded. Never cached.
 */
export const dynamic = 'force-dynamic';
const PRIVATE = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
const refuse = (status: number, code: string) => NextResponse.json({ error: { code, message: code } }, { status, headers: PRIVATE });
const same = (a: ClinicalRequestContext, b: ClinicalRequestContext | null) => !!b && a.actorPersonId === b.actorPersonId && a.organizationId === b.organizationId
  && a.identitySubject === b.identitySubject && a.identityPool === b.identityPool;

export async function POST(req: Request) {
  if (!sameBrowserOrigin(req)) return refuse(403, 'origin_refused');
  const host = selectStaffMediaHost();
  if (!host) return refuse(503, 'staff_media_host_unavailable');
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedRequestBody(req, 4_096, 5_000))); }
  catch { return refuse(400, 'request_invalid'); }
  let context: ClinicalRequestContext | null;
  try { context = await host.identify(req); } catch { return refuse(503, 'service_unavailable'); }
  if (!context || context.identityPool !== 'workforce') return refuse(401, 'workforce_signin_required');
  let data: unknown;
  try { data = await host.read(context, body, {}); }
  catch (error) {
    const after = await host.identify(req).catch(() => null);
    if (!same(context, after)) return refuse(401, 'workforce_signin_required');
    const category = error instanceof LearnerMediaError ? error.category : 'service_unavailable';
    return refuse(category === 'request_invalid' ? 400 : category === 'identity_refused' ? 403 : 503, category);
  }
  const after = await host.identify(req).catch(() => null);
  if (!same(context, after)) return refuse(401, 'workforce_signin_required');
  return NextResponse.json({ data }, { headers: PRIVATE });
}
