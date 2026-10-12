import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestSession } from '@/server/session';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { selectProgramCheckout } from '@/server/commerce/program-commerce-runtime';
import { resolveWorkforceIdentity } from '@/server/commerce/workforce-identity';
import { liveGuard } from '../../route-helpers';

/**
 * The Studio's commercial status read for one program (program-checkout/1 orders,
 * program-education-access/1 entitlements, claims and enrollments) and the clinic's own read of the
 * exact version a purchaser was sold. Same-origin and the practitioner's cookie session; the clinic
 * comes from the session; the reply is returned under its own `commercial` key and carries no
 * clinical record. Outside the local fixture the answer is an honest 503 `commerce_disabled`: a
 * service that cannot be reached is never shown as "no purchases".
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), programId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('curriculum'), entitlementId: z.string().uuid() }).strict(),
]);

export async function POST(req: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(req)) return json(403, { error: { code: 'forbidden', message: 'identity_refused' } });
  const identity = await resolveWorkforceIdentity(await getRequestSession());
  if (!identity) return json(401, { error: { code: 'unauthenticated', message: 'reauth_required' } });
  let body: z.infer<typeof request>;
  try { body = request.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(req, 1024, 5000)))); }
  catch { return json(400, { error: { code: 'invalid', message: 'request_invalid' } }); }
  const selection = selectProgramCheckout();
  if (selection.kind === 'disabled') return json(503, { error: { code: 'unavailable', message: 'commerce_disabled' } });
  try {
    const staff = { kind: 'staff' as const, personId: identity.personId, organizationId: identity.organizationId, identitySubject: 'wf:' + identity.personId };
    if (body.action === 'status') {
      const commercial = await selection.education.listForProgram(staff, body.programId);
      return json(200, { data: { commercial: { ...commercial, readAt: new Date().toISOString() } } });
    }
    const read = await selection.education.staffCurriculum(staff, body.entitlementId);
    return json(200, { data: { commercial: { curriculum: read } } });
  } catch {
    return json(503, { error: { code: 'unavailable', message: 'commerce_unverifiable' } });
  }
}
