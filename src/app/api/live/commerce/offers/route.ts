import { NextResponse } from 'next/server';
import { programsLive } from '@/adapters/programs.live';
import { getRequestSession } from '@/server/session';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { programOfferCommand } from '@/contracts/programOffers';
import { fictionalCurriculumDigest, fictionalPersonId, selectProgramOfferLedger } from '@/server/commerce/program-commerce-runtime';
import { ProgramOfferError, type OfferLedgerCategory } from '@/server/commerce/program-offer-ledger';
import { liveGuard } from '../../route-helpers';

/**
 * The Studio's program-offer authoring route (program-offer/1). Same-origin and the practitioner's
 * cookie session before anything else; the body is the offer command and nothing more; the actor and
 * the clinic come from the session, never from the body. The ledger this process may use is chosen
 * server-side: none outside the local contract fixture, in which case the answer is an honest 503
 * `commerce_disabled` rather than a saved-looking draft that nobody will ever find again.
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const STATUS: Record<OfferLedgerCategory, number> = {
  request_invalid: 400, program_not_found: 404, offer_not_found: 404, revision_stale: 409, state_invalid: 409, curriculum_unpublished: 409,
  curriculum_changed: 409, publish_refused: 409, identity_refused: 403, activation_refused: 503, service_unavailable: 503,
};
const CODE: Record<number, string> = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 503: 'unavailable' };

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: { code: 'forbidden', message: 'identity_refused' } });
  const session = await getRequestSession();
  if (!session.token || !session.orgId || !session.email) return json(401, { error: { code: 'unauthenticated', message: 'reauth_required' } });
  let command: ReturnType<typeof programOfferCommand.parse>;
  try {
    command = programOfferCommand.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 8192, 5000))));
  } catch {
    return json(400, { error: { code: 'invalid', message: 'request_invalid' } });
  }
  const selection = selectProgramOfferLedger();
  if (selection.kind === 'disabled') return json(503, { error: { code: 'unavailable', message: selection.reason } });
  // The clinical service derives the real actor from the token; the fictional ledger needs a stable stand-in for this session's person.
  const actor = { personId: fictionalPersonId(session.email), organizationId: session.orgId };
  if (command.action === 'create' || command.action === 'list') {
    // The fictional ledger binds to what the Studio can read now, through the same authenticated read the Studio uses.
    try {
      const studio = await programsLive.getStudio(command.programId, session.token);
      const digest = studio.published ? fictionalCurriculumDigest(studio.published.consumerProgram) : null;
      const consumerProgram = studio.published?.consumerProgram as { title?: unknown; phases?: unknown } | null | undefined;
      const content = consumerProgram && typeof consumerProgram.title === 'string' && Array.isArray(consumerProgram.phases) ? { title: consumerProgram.title, phases: consumerProgram.phases } : null;
      selection.registerCurriculum(actor.organizationId, command.programId, studio.published && digest ? { versionId: studio.published.id, version: studio.published.version, sourceDigest: digest } : null, content);
    } catch {
      return json(503, { error: { code: 'unavailable', message: 'commerce_unverifiable' } });
    }
  }
  try {
    return json(200, { data: await selection.ledger.execute(actor, command) });
  } catch (error) {
    const category = error instanceof ProgramOfferError ? error.category : 'service_unavailable';
    const holds = error instanceof ProgramOfferError ? error.holds : [];
    const status = STATUS[category];
    return json(status, { error: { code: CODE[status] ?? 'unavailable', message: category, holds } });
  }
}
