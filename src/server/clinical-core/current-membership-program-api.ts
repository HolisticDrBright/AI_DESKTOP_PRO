if (typeof window !== 'undefined') throw new Error('current-membership-program-api is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { createCurrentMembershipProgramAssignments } from './current-membership-program-assignments';
import { CurrentMembershipRefusal, currentMembershipWorkforcePrincipal, SELECTED_CLINIC_REQUEST_HEADER } from './current-membership-workforce';
import { ProductionProgramAssignmentError } from './production-program-assignments';

/**
 * The practitioner program route under the unactivated `database_current` authority, as a host would mount it. Source
 * only: no Lambda entry point, template or route registration imports this, and no deployed host serves the production
 * program family. Where it is mounted is an owner and Codex decision (the qualification program API reaches the
 * database only through its two reviewed proxies, and the production identity API's pilot route list excludes it).
 *
 * The token gives only the verified subject; the one selected clinic must be the clinic configured here; the adapter
 * binds the current membership in the operation's transaction and refuses before any request without the activation
 * evidence. The answer names the clinic it was decided in.
 */
export const CURRENT_MEMBERSHIP_PROGRAM_ROUTE = 'POST /clinical-core/workforce/programs';

export function createCurrentMembershipProgramApi(input: {
  configuration: { workforceIssuer: string; workforceAudience: string; organizationId: string };
  programs: () => ReturnType<typeof createCurrentMembershipProgramAssignments>;
  now?: () => number;
}): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  return async event => {
    if (event.routeKey !== CURRENT_MEMBERSHIP_PROGRAM_ROUTE) return reply(404, { error: 'route_not_found' });
    try {
      const principal = currentMembershipWorkforcePrincipal(event, input.configuration, input.now?.() ?? Date.now());
      const data = await input.programs()(principal, readBody(event));
      return reply(200, { data }, { [SELECTED_CLINIC_REQUEST_HEADER]: principal.selectedOrganizationId });
    } catch (error) {
      if (error instanceof CurrentMembershipRefusal) return reply(error.code === 'reauth_required' ? 401 : 403, { error: error.code });
      if (error instanceof RequestInvalid) return reply(400, { error: 'request_invalid' });
      if (error instanceof ProductionProgramAssignmentError) {
        const code = error.category;
        if (code === 'activation_refused') return reply(503, { error: 'production_not_activated', phiAllowed: false });
        return reply(code === 'request_invalid' ? 400 : code === 'conflict' ? 409 : code === 'service_unavailable' ? 503 : 403,
          { error: code, ...(code === 'conflict' && error.reason ? { reason: error.reason } : {}) });
      }
      return reply(503, { error: 'service_unavailable' });
    }
  };
}
class RequestInvalid extends Error {}
function readBody(event: ApiGatewayV2Event): unknown {
  const type = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Object.keys(event.queryStringParameters ?? {}).length
    || typeof event.body !== 'string' || event.isBase64Encoded || Buffer.byteLength(event.body, 'utf8') > 262_144) throw new RequestInvalid();
  try { return JSON.parse(event.body); } catch { throw new RequestInvalid(); }
}
function reply(statusCode: number, payload: Record<string, unknown>, extra: Record<string, string> = {}): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
    body: JSON.stringify(payload) };
}
