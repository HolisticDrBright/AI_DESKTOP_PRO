import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { careMessageRequest } from '../../contracts/careMessages';
import { careMessageExportRequest } from '../../contracts/careMessageExport';
import { ownedConsumerIdentity } from './owned-consumer-api';
import { OwnedStorageError } from './owned-consumer-records';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { recordingWorkforceExecution, recordingWorkforceIdentity, type RecordingAuthorityConfiguration } from './recording-authority-api';
import { markQualificationResponse, qualificationAdmits } from './qualification-execution';
import { ProductionCareMessageError, type createCurrentMembershipCareMessaging, type createProductionCareMessaging, type createProductionCareMessageExport } from './production-care-messaging';
import { CurrentMembershipRefusal, currentMembershipWorkforcePrincipal, SELECTED_CLINIC_REQUEST_HEADER } from './current-membership-workforce';

export type ProductionCareMessagingConfiguration = RecordingAuthorityConfiguration & {
  consumerIssuer: string; consumerAudience: string;
  messagingReviewSha256?: string; retentionReviewSha256?: string;
  /** Unset or `legacy_claims`: the workforce route reads the person and clinic claims, as deployed. `database_current`
   * (unactivated) serves it from current membership rows for the selected clinic; the consumer routes are unchanged. */
  workforceAuthority?: 'legacy_claims' | 'database_current';
};
export const PRODUCTION_CARE_MESSAGE_ROUTES = [
  'POST /clinical-core/consumer/messages', 'POST /clinical-core/workforce/messages',
  'POST /clinical-core/consumer/messages/export',
] as const;
/** UNRELEASED candidate: this does not register routes or activate a workload.
 * Gateway-verified JWT claims only; no identity or owner from the request body.
 * Qualification may admit reviewed fictional subjects, never ordinary traffic. */
export function createProductionCareMessagingApi(input: {
  configuration: ProductionCareMessagingConfiguration;
  messaging: () => ReturnType<typeof createProductionCareMessaging>;
  exporter: () => ReturnType<typeof createProductionCareMessageExport>;
  /** The workforce route under `database_current`. Absent there, that route answers 503 `membership_authority_not_configured`. */
  currentMessaging?: () => ReturnType<typeof createCurrentMembershipCareMessaging>;
  now?: () => number;
}) {
  const c = input.configuration, execution = recordingWorkforceExecution(c), hash = /^[a-f0-9]{64}$/;
  if (c.workforceAuthority !== undefined && c.workforceAuthority !== 'legacy_claims' && c.workforceAuthority !== 'database_current') {
    throw new Error('care_message_api_configuration_invalid');
  }
  const current = c.workforceAuthority === 'database_current';
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(c.consumerAudience)
    || c.consumerIssuer === c.workforceIssuer || c.consumerAudience === c.workforceAudience) throw new Error('care_message_api_configuration_invalid');
  if (execution.serving && (!hash.test(c.messagingReviewSha256 ?? '') || !hash.test(c.retentionReviewSha256 ?? '')
    || !hash.test(c.mfaReviewSha256 ?? ''))) throw new Error('care_message_review_required');
  const handle = async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!execution.serving) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (!PRODUCTION_CARE_MESSAGE_ROUTES.includes(event.routeKey as typeof PRODUCTION_CARE_MESSAGE_ROUTES[number])) return reply(404, { error: 'route_not_found' });
    try {
      const workforce = event.routeKey === PRODUCTION_CARE_MESSAGE_ROUTES[1], privacy = event.routeKey === PRODUCTION_CARE_MESSAGE_ROUTES[2];
      const now = input.now?.() ?? Date.now();
      if (!Number.isFinite(now)) throw new ProductionCareMessageError('identity_refused');
      if (workforce && current) {
        // No claim fallback: the person and clinic are the current rows for this subject in the one selected clinic.
        const principal = currentMembershipWorkforcePrincipal(event, c, now);
        if (!execution.active && !qualificationAdmits(execution.qualification, principal.subject)) return reply(503, { error: 'production_not_activated', phiAllowed: false });
        const parsed = careMessageRequest.safeParse(body(event));
        if (!parsed.success) throw new ProductionCareMessageError('request_invalid');
        if (!input.currentMessaging) return reply(503, { error: 'membership_authority_not_configured' });
        // The answer names the clinic it was decided in, so a caller can tell a current-membership answer from any other.
        return reply(200, { data: await input.currentMessaging()(principal, parsed.data) },
          { [SELECTED_CLINIC_REQUEST_HEADER]: principal.selectedOrganizationId });
      }
      const context = workforce ? recordingWorkforceIdentity(event, c, now)
        : ownedConsumerIdentity(event, c, privacy ? 'consent_management' : 'clinical_data', now);
      if (context.organizationId !== c.organizationId) throw new ProductionCareMessageError('identity_refused');
      if (!execution.active && !qualificationAdmits(execution.qualification, context.identitySubject)) return reply(503, { error: 'production_not_activated', phiAllowed: false });
      if (privacy) {
        const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
        const time = claims.auth_time;
        if (!(typeof time === 'number' || typeof time === 'string' && /^\d+$/.test(time))
          || !Number.isSafeInteger(Number(time)) || Number(time) <= 0 || Number(time) > Number(claims.iat)
          || now - Number(time) * 1000 > 15 * 60000) return reply(401, { error: 'reauth_required' });
      }
      const raw = body(event);
      if (privacy) {
        const parsed = careMessageExportRequest.safeParse(raw);
        if (!parsed.success) throw new ProductionCareMessageError('request_invalid');
        return reply(200, { data: await input.exporter()(context, parsed.data) });
      }
      const parsed = careMessageRequest.safeParse(raw);
      if (!parsed.success) throw new ProductionCareMessageError('request_invalid');
      return reply(200, { data: await input.messaging()(context, parsed.data) });
    } catch (e) {
      if (e instanceof OwnedStorageError || e instanceof RecordingAuthorityError) return reply(401, { error: 'reauth_required' });
      if (e instanceof CurrentMembershipRefusal) return reply(e.code === 'reauth_required' ? 401 : 403, { error: e.code });
      const code = e instanceof ProductionCareMessageError ? e.category : 'service_unavailable';
      return reply(code === 'request_invalid' ? 400 : code === 'conflict' ? 409
        : code === 'identity_refused' || code === 'consent_required' || code === 'account_deletion_write_blocked' ? 403 : 503, { error: code });
    }
  };
  return async (event: ApiGatewayV2Event) => markQualificationResponse(execution.qualification, await handle(event));
}
function body(event: ApiGatewayV2Event): unknown {
  const invalid = (): never => { throw new ProductionCareMessageError('request_invalid'); };
  const type = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Object.keys(event.queryStringParameters ?? {}).length
    || typeof event.body !== 'string' || event.body.length > 30000) invalid();
  const bytes = Buffer.from(event.body!, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length === 0 || bytes.length > 20480 || event.isBase64Encoded && bytes.toString('base64') !== event.body) invalid();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid(); }
}
function reply(statusCode: number, payload: unknown, extra: Record<string, string> = {}): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }, body: JSON.stringify(payload) };
}
