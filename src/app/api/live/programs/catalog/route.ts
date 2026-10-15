import { NextResponse } from 'next/server';
import { getRequestSession } from '@/server/session';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { programCatalogObservationRequest } from '@/contracts/programCatalogObservation';
import { CatalogObservationError, observeProgramCatalog, workforceApiOrigin } from '@/server/programs/program-catalog-observation';
import { liveGuard } from '../../route-helpers';

/**
 * The Studio's governed catalog read. The practitioner's cookie session is exchanged for the
 * workforce JWT here, so the browser never holds it; the reply is the `program-catalog-observation/2`
 * observation bound to this session's clinic and the draft version the Studio named. A failure is
 * returned as the category it is, so the picker can say "could not be read" and never "no match".
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const STATUS: Record<CatalogObservationError['category'], number> = {
  reauth_required: 401, identity_refused: 403, service_unavailable: 503, catalog_unverifiable: 503, catalog_target_changed: 503,
};

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: { code: 'forbidden', message: 'identity_refused' } });
  const session = await getRequestSession();
  if (!session.token || !session.orgId) return json(401, { error: { code: 'unauthenticated', message: 'reauth_required' } });
  let body: ReturnType<typeof programCatalogObservationRequest.parse>;
  try {
    body = programCatalogObservationRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 4096, 5000))));
  } catch {
    return json(400, { error: { code: 'invalid', message: 'request_invalid' } });
  }
  const origin = workforceApiOrigin(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN);
  if (!origin) return json(503, { error: { code: 'unavailable', message: 'service_unavailable' } });
  try {
    // Only the explicitly synthetic, PHI-disabled host may use the older catalog contract.
    // Production never falls back from the exact-label projection to the incompatible old reader.
    const source = process.env.CLINICAL_AWS_RUNTIME_MODE === 'synthetic' && process.env.PHI_ALLOWED !== 'true'
      ? 'legacy-synthetic' : 'production-reference';
    const data = await observeProgramCatalog({ token: session.token, clinic: session.orgId, versionId: body.versionId, query: body.query, origin, source });
    return json(200, { data });
  } catch (error) {
    const category = error instanceof CatalogObservationError ? error.category : 'service_unavailable';
    const code = category === 'reauth_required' ? 'unauthenticated' : category === 'identity_refused' ? 'forbidden' : 'unavailable';
    return json(STATUS[category], { error: { code, message: category } });
  }
}
