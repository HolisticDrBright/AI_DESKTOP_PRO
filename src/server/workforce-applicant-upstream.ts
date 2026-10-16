import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { abuseKey } from '@/server/public-abuse-boundary';

/**
 * The one way this Desktop reaches the BLOCKED applicant API, for the application and new-clinic routes alike.
 *
 * The origin must be exactly an API Gateway execute-api host (`WORKFORCE_APPLICATIONS_API_ORIGIN`); anything else, or
 * nothing, is `application_service_not_configured`, so a missing service is never read as "no application" or "no
 * clinic". Only the session's own bearer token is sent: never a clinic, a selection or a cookie. Answers are bounded,
 * JSON only, never cached, and an error name the caller does not list reaches the browser as
 * `workforce_application_unavailable`. Nothing about the applicant is logged.
 */
const PASSED = new Set([400, 401, 403, 404, 409, 429]);

export function applicantUpstreamOrigin(): string | null {
  try {
    const origin = new URL(process.env.WORKFORCE_APPLICATIONS_API_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || origin.port
      || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) return null;
    return origin.origin;
  } catch { return null; }
}

export function applicantClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 128) || 'local';
  return abuseKey('client', forwarded);
}

export type ApplicantAnswer =
  | { ok: true; status: number; payload: Record<string, unknown> }
  | { ok: false; status: number; error: string; payload: Record<string, unknown> };

export async function forwardToApplicantApi(request: Request, token: string, input: {
  method: 'GET' | 'POST'; path: string; body?: unknown; refusals: readonly string[];
}): Promise<ApplicantAnswer> {
  const origin = applicantUpstreamOrigin();
  if (!origin) return { ok: false, status: 503, error: 'application_service_not_configured', payload: {} };
  const response = await fetch(origin + input.path, { method: input.method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + token, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: input.body === undefined ? undefined : JSON.stringify(input.body) });
  const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: request.signal }, 65536, 15000);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('invalid');
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
  if (response.ok) return { ok: true, status: response.status, payload };
  const error = typeof payload.error === 'string' && input.refusals.includes(payload.error) ? payload.error : 'workforce_application_unavailable';
  return { ok: false, status: PASSED.has(response.status) ? response.status : 503, error, payload };
}
