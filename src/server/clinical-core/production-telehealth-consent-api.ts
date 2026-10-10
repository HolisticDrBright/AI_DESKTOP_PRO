import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { telehealthConsentRequest } from '../../contracts/telehealthConsent';
import { ownedConsumerIdentity } from './owned-consumer-api';
import { OwnedStorageError } from './owned-consumer-records';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { recordingWorkforceExecution } from './recording-authority-api';
import { markQualificationResponse, qualificationAdmits } from './qualification-execution';
import { CareConnectionError } from './production-care-connections';
import type { CareConnectionConfiguration } from './production-care-connections-api';
import type { createProductionTelehealthConsent } from './production-telehealth-consent';

export const TELEHEALTH_CONSENT_ROUTE = 'POST /clinical-core/consumer/telehealth-consent';
/** New serving path is independently reviewed and default disabled. No consent
 * copy is approved here. Status/withdrawal survive disabling new consent grants. */
export function createProductionTelehealthConsentApi(input: {
  configuration: Omit<CareConnectionConfiguration, 'enabledScopes'> & { telehealthConsentEnabled: boolean };
  operations: () => ReturnType<typeof createProductionTelehealthConsent>; now?: () => number;
}) {
  const c = structuredClone(input.configuration), execution = recordingWorkforceExecution(c);
  const hash = /^[a-f0-9]{64}$/, clock = input.now ?? Date.now, operations = input.operations;
  if (!/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(c.consumerIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(c.consumerAudience) || c.consumerIssuer === c.workforceIssuer
    || c.consumerAudience === c.workforceAudience || typeof c.telehealthConsentEnabled !== 'boolean')
    throw Error('telehealth_consent_configuration_invalid');
  if (execution.serving && (!hash.test(c.connectionReviewSha256 ?? '') || !hash.test(c.consentReviewSha256 ?? '')
    || !hash.test(c.mfaReviewSha256 ?? ''))) throw Error('telehealth_consent_review_required');
  const handle = async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!execution.serving) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (event.routeKey !== TELEHEALTH_CONSENT_ROUTE) return reply(404, { error: 'route_not_found' });
    try {
      const type = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Object.keys(event.queryStringParameters ?? {}).length
        || typeof event.body !== 'string' || event.body.length > 30000) throw new CareConnectionError('request_invalid');
      const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
      if (!bytes.length || bytes.length > 22000 || event.isBase64Encoded && bytes.toString('base64') !== event.body)
        throw new CareConnectionError('request_invalid');
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new CareConnectionError('request_invalid'); }
      const parsed = telehealthConsentRequest.safeParse(body);
      if (!parsed.success) throw new CareConnectionError('request_invalid');
      const request = parsed.data, now = clock();
      const context = ownedConsumerIdentity(event, c, 'consent_management', now);
      if (context.organizationId !== c.organizationId) throw new CareConnectionError('identity_refused');
      if (!execution.active && !qualificationAdmits(execution.qualification, context.identitySubject))
        return reply(503, { error: 'production_not_activated', phiAllowed: false });
      if (request.action === 'grant') {
        if (!c.telehealthConsentEnabled) return reply(403, { error: 'feature_scope_not_enabled' });
        const claims = event.requestContext?.authorizer?.jwt?.claims ?? {}, time = claims.auth_time;
        if (!(typeof time === 'number' || typeof time === 'string' && /^\d+$/.test(time))
          || !Number.isSafeInteger(Number(time)) || Number(time) <= 0 || Number(time) > Number(claims.iat)
          || now - Number(time) * 1000 > 15 * 60000) return reply(401, { error: 'reauth_required' });
      }
      const result = await operations()(context, request);
      return reply(200, { data: request.action === 'consent' && !c.telehealthConsentEnabled && 'artifact' in result
        ? { ...result, artifact: null } : result });
    } catch (error) {
      if (error instanceof OwnedStorageError || error instanceof RecordingAuthorityError) return reply(401, { error: 'reauth_required' });
      const code = error instanceof CareConnectionError ? error.category : 'service_unavailable';
      return reply(code === 'request_invalid' ? 400 : code === 'conflict' ? 409
        : ['identity_refused', 'consent_required', 'account_deletion_write_blocked'].includes(code) ? 403 : 503, { error: code });
    }
  };
  return async (event: ApiGatewayV2Event) => markQualificationResponse(execution.qualification, await handle(event));
}
function reply(statusCode: number, value: unknown): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' }, body: JSON.stringify(value) };
}
