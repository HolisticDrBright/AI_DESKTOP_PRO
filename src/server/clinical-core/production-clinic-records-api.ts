import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { clinicRecordConsumerRequest, clinicRecordWorkforceRequest } from '../../contracts/clinicRecordRequests';
import { ownedConsumerIdentity } from './owned-consumer-api';
import { OwnedStorageError } from './owned-consumer-records';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { recordingWorkforceExecution, recordingWorkforceIdentity, type RecordingAuthorityConfiguration } from './recording-authority-api';
import { markQualificationResponse, qualificationAdmits } from './qualification-execution';
import { ClinicRecordError, type createProductionClinicRecordsConsumer, type createProductionClinicRecordsWorkforce } from './production-clinic-records';

export type ProductionClinicRecordsConfiguration = RecordingAuthorityConfiguration & {
  consumerIssuer: string; consumerAudience: string;
  /** Independent reviews a serving deployment must carry: the disclosure workflow and the retention posture of fulfilled copies. */
  disclosureReviewSha256?: string; retentionReviewSha256?: string;
};
export const CLINIC_RECORD_ROUTES = ['POST /clinical-core/consumer/clinic-records', 'POST /clinical-core/workforce/clinic-records'] as const;
/** A patient must have signed in within this window to submit, withdraw or inspect a clinic request. */
const CONSUMER_FRESH_AUTH_MS = 15 * 60_000;
/** Reading a fulfilled copy is a download of clinic-held records: the fresh sign-in window the personal export download uses. */
const COPY_READ_FRESH_AUTH_MS = 5 * 60_000;
/**
 * UNRELEASED candidate: this does not register routes or activate a workload.
 * Gateway-verified JWT claims only; no identity, patient, clinic or owner from
 * the request body. Qualification may admit reviewed fictional subjects, never
 * ordinary traffic. The consumer route carries one person's own requests and
 * copies; the workforce route carries one clinic's review and decisions.
 */
export function createProductionClinicRecordsApi(input: {
  configuration: ProductionClinicRecordsConfiguration;
  consumer: () => ReturnType<typeof createProductionClinicRecordsConsumer>;
  workforce: () => ReturnType<typeof createProductionClinicRecordsWorkforce>;
  now?: () => number;
}) {
  const c = input.configuration, execution = recordingWorkforceExecution(c), hash = /^[a-f0-9]{64}$/;
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(c.consumerAudience)
    || c.consumerIssuer === c.workforceIssuer || c.consumerAudience === c.workforceAudience) throw new Error('clinic_record_api_configuration_invalid');
  if (execution.serving && (!hash.test(c.disclosureReviewSha256 ?? '') || !hash.test(c.retentionReviewSha256 ?? '')
    || !hash.test(c.mfaReviewSha256 ?? ''))) throw new Error('clinic_record_review_required');
  const handle = async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!execution.serving) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (!CLINIC_RECORD_ROUTES.includes(event.routeKey as typeof CLINIC_RECORD_ROUTES[number])) return reply(404, { error: 'route_not_found' });
    try {
      const workforce = event.routeKey === CLINIC_RECORD_ROUTES[1];
      const now = input.now?.() ?? Date.now();
      if (!Number.isFinite(now)) throw new ClinicRecordError('identity_refused');
      const context = workforce ? recordingWorkforceIdentity(event, c, now) : ownedConsumerIdentity(event, c, 'consent_management', now);
      if (context.organizationId !== c.organizationId) throw new ClinicRecordError('identity_refused');
      if (!execution.active && !qualificationAdmits(execution.qualification, context.identitySubject)) return reply(503, { error: 'production_not_activated', phiAllowed: false });
      const raw = body(event);
      if (workforce) {
        const parsed = clinicRecordWorkforceRequest.safeParse(raw);
        if (!parsed.success) throw new ClinicRecordError('request_invalid');
        return reply(200, { data: await input.workforce()(context, parsed.data) });
      }
      const parsed = clinicRecordConsumerRequest.safeParse(raw);
      if (!parsed.success) throw new ClinicRecordError('request_invalid');
      // A patient acting on clinic-held records signed in recently; reading a fulfilled copy needs the download window.
      const window = parsed.data.action === 'read_copy' ? COPY_READ_FRESH_AUTH_MS : CONSUMER_FRESH_AUTH_MS;
      if (!freshSignIn(event, now, window)) return reply(401, { error: 'reauth_required' });
      return reply(200, { data: await input.consumer()(context, parsed.data) });
    } catch (e) {
      if (e instanceof OwnedStorageError || e instanceof RecordingAuthorityError) return reply(401, { error: 'reauth_required' });
      const code = e instanceof ClinicRecordError ? e.category : 'service_unavailable';
      return reply(code === 'request_invalid' ? 400 : code === 'conflict' || code === 'disclosure_release_required' ? 409
        : code === 'not_found' ? 404
        : code === 'identity_refused' || code === 'connection_required' || code === 'subject_not_disclosed' || code === 'account_deletion_write_blocked' ? 403
        : 503, { error: code });
    }
  };
  return async (event: ApiGatewayV2Event) => markQualificationResponse(execution.qualification, await handle(event));
}
function freshSignIn(event: ApiGatewayV2Event, now: number, window: number) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const time = claims.auth_time;
  return (typeof time === 'number' || typeof time === 'string' && /^\d+$/.test(time))
    && Number.isSafeInteger(Number(time)) && Number(time) > 0 && Number(time) <= Number(claims.iat) && now - Number(time) * 1000 <= window;
}
function body(event: ApiGatewayV2Event): unknown {
  const invalid = (): never => { throw new ClinicRecordError('request_invalid'); };
  const type = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Object.keys(event.queryStringParameters ?? {}).length
    || typeof event.body !== 'string' || event.body.length > 120000) invalid();
  const bytes = Buffer.from(event.body!, event.isBase64Encoded ? 'base64' : 'utf8');
  // Large enough for an amendment's addendum text; nothing else comes close.
  if (bytes.length === 0 || bytes.length > 81920 || event.isBase64Encoded && bytes.toString('base64') !== event.body) invalid();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid(); }
}
function reply(statusCode: number, payload: unknown): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(payload) };
}
