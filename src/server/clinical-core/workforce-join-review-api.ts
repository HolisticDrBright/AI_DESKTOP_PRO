if (typeof window !== 'undefined') throw new Error('workforce-join-review-api is server-only');
import { joinReviewRequest, type JoinReviewRequest } from '../../contracts/workforceJoinReview';
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { CurrentMembershipRefusal, currentMembershipWorkforcePrincipal, SELECTED_CLINIC_REQUEST_HEADER } from './current-membership-workforce';
import { WorkforceJoinReviewError, type createWorkforceJoinReview } from './workforce-join-review';

/**
 * The clinic administrator's join-request routes, as a host would mount them. Source only and BLOCKED: no Lambda entry
 * point, template or route registration imports this, and `WORKFORCE_JOIN_REVIEW_API_RELEASE` is `blocked`, so every
 * request answers 503 before a token is read or a database client is made. Activation is a reviewed change to that
 * constant together with the SQL candidate's registration, never a configuration value.
 *
 * The token gives only the verified subject; the one selected clinic must be the clinic configured here; the review
 * service binds the current membership in the operation's own transaction. Bodies are at most 2 KB; every answer is
 * `no-store` and names the clinic it was decided in. Nothing here logs: a refusal carries a closed code only.
 */
export const WORKFORCE_JOIN_REVIEW_API_RELEASE: 'blocked' | 'qualification' = 'blocked';
export const WORKFORCE_JOIN_REVIEW_ROUTES = {
  'GET /clinical-core/workforce/join-requests': 'list',
  'POST /clinical-core/workforce/join-requests/decisions': 'decide',
  'POST /clinical-core/workforce/memberships/revocations': 'revoke',
} as const;
const MAX_BODY_BYTES = 2048;

const STATUS: Record<WorkforceJoinReviewError['code'], number> = {
  not_released: 503, reauth_required: 401, identity_refused: 403, request_invalid: 400, not_found: 404, conflict: 409,
  applicant_mismatch: 422, self_approval_refused: 403, already_member: 409, clinic_unavailable: 409, service_unavailable: 503,
};

export function createWorkforceJoinReviewApi(input: {
  configuration: { workforceIssuer: string; workforceAudience: string; organizationId: string };
  review: () => ReturnType<typeof createWorkforceJoinReview>;
  release?: 'blocked' | 'qualification';
  now?: () => number;
}): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  const release = input.release ?? WORKFORCE_JOIN_REVIEW_API_RELEASE;
  return async event => {
    if (release !== 'qualification') return reply(503, { error: 'not_released' });
    const route = WORKFORCE_JOIN_REVIEW_ROUTES[event.routeKey as keyof typeof WORKFORCE_JOIN_REVIEW_ROUTES];
    if (!route) return reply(404, { error: 'route_not_found' });
    try {
      const principal = currentMembershipWorkforcePrincipal(event, input.configuration, input.now?.() ?? Date.now());
      const request = readRequest(event, route);
      const data = await input.review()(principal, request);
      return reply(200, { data }, { [SELECTED_CLINIC_REQUEST_HEADER]: principal.selectedOrganizationId });
    } catch (error) {
      if (error instanceof CurrentMembershipRefusal) return reply(error.code === 'reauth_required' ? 401 : 403, { error: error.code });
      if (error instanceof RequestInvalid) return reply(400, { error: 'request_invalid' });
      if (error instanceof WorkforceJoinReviewError) return reply(STATUS[error.code], { error: error.code });
      return reply(503, { error: 'service_unavailable' });
    }
  };
}

class RequestInvalid extends Error {}
function readRequest(event: ApiGatewayV2Event, route: 'list' | 'decide' | 'revoke'): JoinReviewRequest {
  if (Object.keys(event.queryStringParameters ?? {}).length || event.isBase64Encoded) throw new RequestInvalid();
  if (route === 'list') {
    if (event.body) throw new RequestInvalid();
    return { action: 'list' };
  }
  const type = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || typeof event.body !== 'string'
    || Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) throw new RequestInvalid();
  let value: unknown;
  try { value = JSON.parse(event.body); } catch { throw new RequestInvalid(); }
  const parsed = joinReviewRequest.safeParse(value);
  if (!parsed.success) throw new RequestInvalid();
  const allowed = route === 'decide' ? ['approve', 'reject'] : ['revoke'];
  if (!allowed.includes(parsed.data.action)) throw new RequestInvalid();
  return parsed.data;
}
function reply(statusCode: number, payload: Record<string, unknown>, extra: Record<string, string> = {}): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
    body: JSON.stringify(payload) };
}
