import { CampaignError, HTTP_STATUS, type EngineDeps } from './practice-context';
import { createPublicCampaigns } from './public';
import { WORKFORCE_SUBJECT } from './staff-revocation';
import { createWorkforceCampaigns } from './workforce';

/**
 * The campaign API: its own HTTP API (API Gateway v2) and Lambda, beside the clinical API and sharing nothing with it.
 *
 * Public routes (no authorizer; each accepts only its fixed fields, and the stage is throttled):
 *   GET  /campaigns/public/join/{practice}/{program}     the sign-up page's text and sealed form time, or 404
 *   GET  /campaigns/public/signup-open/{practice}/{program} whether a program page may show "Get updates"
 *   POST /campaigns/public/join                          always 202 "check your email"
 *   POST /campaigns/public/confirm                       { token } -> outcome
 *   POST /campaigns/public/unsubscribe                   { token } -> unsubscribed
 * Staff route (the workforce pool's JWT authorizer verifies issuer, audience and signature):
 *   POST /campaigns/workforce                            the Campaigns screen; practice and person from the token
 *     Before any staff operation, the token's subject is checked against the emergency revocation's signal
 *     (staff-revocation.ts): revoked is 403, and an unreadable or unconfigured signal is 503, never "not revoked".
 *
 * Bodies are never logged. A failure is an error status, never an empty answer.
 */
export type HttpEvent = {
  routeKey?: string; pathParameters?: Record<string, string | undefined>; body?: string | null; isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
};
export type HttpResponse = { statusCode: number; headers: Record<string, string>; body: string };

const json = (statusCode: number, value: unknown): HttpResponse => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function body(event: HttpEvent, limit: number): unknown {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  if (raw.length > limit) throw new CampaignError('invalid', 'body_too_large');
  try { return JSON.parse(raw || '{}'); } catch { throw new CampaignError('invalid', 'body_invalid'); }
}

export function createCampaignHttpHandler(deps: EngineDeps) {
  const publicSide = createPublicCampaigns(deps);
  const staff = createWorkforceCampaigns(deps);
  return async (event: HttpEvent): Promise<HttpResponse> => {
    try {
      if (Object.keys(event.queryStringParameters ?? {}).length) throw new CampaignError('invalid', 'no_query_accepted');
      const path = event.pathParameters ?? {};
      switch (event.routeKey) {
        case 'GET /campaigns/public/join/{practice}/{program}': {
          const info = await publicSide.joinPage(String(path.practice ?? ''), String(path.program ?? ''));
          return info ? json(200, { data: info }) : json(404, { error: 'not_found' });
        }
        case 'GET /campaigns/public/signup-open/{practice}/{program}':
          return json(200, { data: { open: await publicSide.signupOpen(String(path.practice ?? ''), String(path.program ?? '')) } });
        case 'POST /campaigns/public/join':
          return json(202, { data: await publicSide.join(body(event, 4096)) });
        case 'POST /campaigns/public/confirm': {
          const b = body(event, 2048) as { token?: unknown };
          if (typeof b.token !== 'string' || Object.keys(b).length !== 1) throw new CampaignError('invalid', 'token_required');
          return json(200, { data: { outcome: await publicSide.confirm(b.token) } });
        }
        case 'POST /campaigns/public/unsubscribe': {
          const b = body(event, 2048) as { token?: unknown };
          if (typeof b.token !== 'string' || Object.keys(b).length !== 1) throw new CampaignError('invalid', 'token_required');
          return json(200, { data: { outcome: await publicSide.unsubscribe(b.token) } });
        }
        case 'POST /campaigns/workforce': {
          const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
          const practiceId = claims['custom:organization_id'], personId = claims['custom:person_id'], subject = claims.sub, exp = Number(claims.exp);
          if (typeof practiceId !== 'string' || !UUID.test(practiceId) || typeof personId !== 'string' || !UUID.test(personId)
            || typeof subject !== 'string' || !WORKFORCE_SUBJECT.test(subject)
            || !Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new CampaignError('forbidden', 'identity_refused');
          if (!deps.staffRevocation) throw new CampaignError('unavailable', 'staff_revocation_unconfigured');
          if (await deps.staffRevocation.revoked(subject)) throw new CampaignError('forbidden', 'identity_refused');
          const email = typeof claims.email === 'string' && claims.email_verified !== false && claims.email_verified !== 'false' ? claims.email.toLowerCase() : null;
          return json(200, { data: await staff.handle({ practiceId: practiceId.toLowerCase(), personId: personId.toLowerCase(), subject, email }, body(event, 262_144)) });
        }
        default:
          return json(404, { error: 'not_found' });
      }
    } catch (error) {
      if (error instanceof CampaignError) return json(HTTP_STATUS[error.category], { error: error.category, ...(error.detail ? { detail: error.detail } : {}) });
      return json(503, { error: 'unavailable' });
    }
  };
}
