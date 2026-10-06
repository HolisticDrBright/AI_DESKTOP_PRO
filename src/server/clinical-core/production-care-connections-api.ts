import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { careConnectionRequest, careConsentScope } from '../../contracts/careConnections';
import { ownedConsumerIdentity } from './owned-consumer-api';
import { OwnedStorageError } from './owned-consumer-records';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { recordingWorkforceExecution, recordingWorkforceIdentity, type RecordingAuthorityConfiguration } from './recording-authority-api';
import { markQualificationResponse, qualificationAdmits } from './qualification-execution';
import { CareConnectionError, type createProductionCareConnections } from './production-care-connections';

export type CareConnectionConfiguration = RecordingAuthorityConfiguration & {
  consumerIssuer: string; consumerAudience: string; connectionReviewSha256?: string; consentReviewSha256?: string;
  enabledScopes: readonly string[];
};
export const CARE_CONNECTION_ROUTES = ['POST /clinical-core/consumer/connection', 'POST /clinical-core/workforce/connection'] as const;
/** Unreleased: no route registration, secret access, activation or consent
 * approval. The API consumes approved copy bytes; it cannot create approvals. */
export function createProductionCareConnectionApi(input: { configuration: CareConnectionConfiguration;
  operations: () => ReturnType<typeof createProductionCareConnections>; now?: () => number }) {
  const c = structuredClone(input.configuration), execution = recordingWorkforceExecution(c), hash = /^[a-f0-9]{64}$/;
  const clock = input.now ?? Date.now, operations = input.operations;
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(c.consumerAudience) || c.consumerIssuer === c.workforceIssuer
    || c.consumerAudience === c.workforceAudience || !Array.isArray(c.enabledScopes)
    || c.enabledScopes.some(scope => !careConsentScope.safeParse(scope).success)
    || new Set(c.enabledScopes).size !== c.enabledScopes.length) throw new Error('care_connection_configuration_invalid');
  if (execution.serving && (!hash.test(c.connectionReviewSha256 ?? '') || !hash.test(c.consentReviewSha256 ?? '')
    || !hash.test(c.mfaReviewSha256 ?? ''))) throw new Error('care_connection_review_required');
  const handle = async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!execution.serving) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (!CARE_CONNECTION_ROUTES.includes(event.routeKey as typeof CARE_CONNECTION_ROUTES[number])) return reply(404, { error: 'route_not_found' });
    try {
      const parsed = careConnectionRequest.safeParse(readBody(event));
      if (!parsed.success) throw new CareConnectionError('request_invalid');
      const request = parsed.data, workforce = event.routeKey === CARE_CONNECTION_ROUTES[1], now = clock();
      if (workforce !== (request.action === 'issue')) throw new CareConnectionError('identity_refused');
      const context = workforce ? recordingWorkforceIdentity(event, c, now)
        : ownedConsumerIdentity(event, c, request.action === 'claim' ? 'identity_link' : 'consent_management', now);
      if (context.organizationId !== c.organizationId) throw new CareConnectionError('identity_refused');
      if (!execution.active && !qualificationAdmits(execution.qualification, context.identitySubject)) return reply(503, { error: 'production_not_activated', phiAllowed: false });
      if (request.action === 'claim' || request.action === 'grant') {
        const claims = event.requestContext?.authorizer?.jwt?.claims ?? {}, time = claims.auth_time;
        if (!(typeof time === 'number' || typeof time === 'string' && /^\d+$/.test(time))
          || !Number.isSafeInteger(Number(time)) || Number(time) <= 0 || Number(time) > Number(claims.iat)
          || now - Number(time) * 1000 > 15 * 60000) return reply(401, { error: 'reauth_required' });
      }
      // Removing a scope must never remove status access or withdrawal.
      if (request.action === 'grant' && !c.enabledScopes.includes(request.scope)) return reply(403, { error: 'feature_scope_not_enabled' });
      const result = await operations()(context, request);
      if (request.action === 'consent' && !c.enabledScopes.includes(request.scope) && 'artifact' in result)
        return reply(200, { data: { ...result, artifact: null } });
      return reply(200, { data: result });
    } catch (error) {
      if (error instanceof OwnedStorageError || error instanceof RecordingAuthorityError) return reply(401, { error: 'reauth_required' });
      const code = error instanceof CareConnectionError ? error.category : 'service_unavailable';
      return reply(code === 'request_invalid' ? 400 : code === 'conflict' ? 409
        : ['identity_refused', 'consent_required', 'account_deletion_write_blocked'].includes(code) ? 403 : 503, { error: code });
    }
  };
  return async (event: ApiGatewayV2Event) => markQualificationResponse(execution.qualification, await handle(event));
}
function readBody(event: ApiGatewayV2Event): unknown {
  const invalid = (): never => { throw new CareConnectionError('request_invalid'); };
  const type = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Object.keys(event.queryStringParameters ?? {}).length
    || typeof event.body !== 'string' || event.body.length > 30000) invalid();
  const bytes = Buffer.from(event.body!, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length === 0 || bytes.length > 22000 || event.isBase64Encoded && bytes.toString('base64') !== event.body) invalid();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid(); }
}
function reply(statusCode: number, value: unknown): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(value) };
}
