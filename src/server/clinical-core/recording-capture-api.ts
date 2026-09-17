import { z } from 'zod';
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { recordingWorkforceActivation, recordingWorkforceIdentity, type RecordingAuthorityConfiguration } from './recording-authority-api';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { recordingContentTypeSchema, recordingStartSchema, recordingStartReceiptSchema, recordingLifecycleCommandSchema,
  recordingLifecycleReceiptSchema, recordingRecoveryStateSchema, RecordingLifecycleError, type createRecordingLifecycleRepository } from './recording-lifecycle';
import { recordingSegmentInputSchema, recordingSegmentReceiptSchema, RecordingUploadError, type createRecordingSegmentUploader } from './recording-segments';

export const RECORDING_CAPTURE_ROUTES = {
  start: 'POST /clinical-core/workforce/encounter-recording/start',
  state: 'POST /clinical-core/workforce/encounter-recording/state',
  command: 'POST /clinical-core/workforce/encounter-recording/command',
  segment: 'POST /clinical-core/workforce/encounter-recording/segment',
} as const;
export type RecordingCaptureConfiguration = RecordingAuthorityConfiguration & {
  captureReleaseId: string; captureReviewSha256?: string; storageReviewSha256?: string; retentionReviewSha256?: string;
};
const id = z.string().uuid(), stateRequest = z.object({ recordingId: id }).strict();
const hash = /^[a-f0-9]{64}$/, maxBytes = 4194304;
const uploadHeaders = ['x-alp-recording-id', 'x-alp-session-id', 'x-alp-capture-token', 'x-alp-sequence', 'x-alp-sha256'];
const reply = (statusCode: number, value: unknown): ApiGatewayV2Response => ({ statusCode, body: JSON.stringify(value),
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
function header(event: ApiGatewayV2Event, name: string) {
  const found = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  if (found.length !== 1 || typeof found[0][1] !== 'string') throw new RecordingLifecycleError('request_invalid');
  return found[0][1];
}
function jsonBody(event: ApiGatewayV2Event): unknown {
  if (header(event, 'content-type').split(';')[0].trim().toLowerCase() !== 'application/json'
    || typeof event.body !== 'string' || event.body.length > 16000) throw new RecordingLifecycleError('request_invalid');
  const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length > 10000 || event.isBase64Encoded && bytes.toString('base64') !== event.body) throw new RecordingLifecycleError('request_invalid');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RecordingLifecycleError('request_invalid'); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RecordingLifecycleError('request_invalid');
  return result.data;
}
/** Only Gateway-verified workforce claims authenticate. No public function URL,
 * caller-selected provider/storage, query credentials or token-only recovery.
 * The separate consent endpoint remains incapable of activating this transport.
 */
export function createRecordingCaptureApi(input: { configuration: RecordingCaptureConfiguration;
  lifecycle: () => ReturnType<typeof createRecordingLifecycleRepository>;
  upload: () => ReturnType<typeof createRecordingSegmentUploader>; now?: () => number }) {
  const c = input.configuration;
  const active = recordingWorkforceActivation(c) && id.safeParse(c.captureReleaseId).success
    && [c.captureReviewSha256, c.storageReviewSha256, c.retentionReviewSha256].every(v => hash.test(v ?? ''));
  if (c.phiAllowed && !active) throw new Error('recording_capture_activation_invalid');
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!active) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (!Object.values(RECORDING_CAPTURE_ROUTES).includes(event.routeKey as typeof RECORDING_CAPTURE_ROUTES[keyof typeof RECORDING_CAPTURE_ROUTES]))
      return reply(404, { error: 'route_not_found' });
    try {
      const context = recordingWorkforceIdentity(event, c, input.now?.() ?? Date.now());
      if (Object.keys(event.queryStringParameters ?? {}).length || Object.keys(event.headers ?? {}).some(k =>
        k.toLowerCase().startsWith('x-alp-') && !uploadHeaders.includes(k.toLowerCase()))) throw new RecordingLifecycleError('request_invalid');
      let data: unknown;
      if (event.routeKey === RECORDING_CAPTURE_ROUTES.segment) {
        const contentType = parse(recordingContentTypeSchema, header(event, 'content-type'));
        if (event.isBase64Encoded !== true || typeof event.body !== 'string' || event.body.length > Math.ceil(maxBytes / 3) * 4)
          throw new RecordingLifecycleError('request_invalid');
        const bytes = Buffer.from(event.body, 'base64'), sequence = header(event, 'x-alp-sequence');
        if (!/^(0|[1-9][0-9]{0,3})$/.test(sequence) || !bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== event.body)
          throw new RecordingLifecycleError('request_invalid');
        const request = parse(recordingSegmentInputSchema, { recordingId: header(event, 'x-alp-recording-id'), sessionId: header(event, 'x-alp-session-id'),
          captureToken: header(event, 'x-alp-capture-token'), sha256: header(event, 'x-alp-sha256'), sequence: Number(sequence), bytes: bytes.length, contentType });
        data = recordingSegmentReceiptSchema.parse(await input.upload()(context, request, bytes));
      } else {
        if (Object.keys(event.headers ?? {}).some(k => k.toLowerCase().startsWith('x-alp-'))) throw new RecordingLifecycleError('request_invalid');
        const body = jsonBody(event);
        if (event.routeKey === RECORDING_CAPTURE_ROUTES.start) {
          const request = parse(recordingStartSchema, body);
          data = recordingStartReceiptSchema.parse(await input.lifecycle().start(context, request, c.captureReleaseId));
        } else if (event.routeKey === RECORDING_CAPTURE_ROUTES.state) {
          const request = parse(stateRequest, body);
          data = recordingRecoveryStateSchema.parse(await input.lifecycle().state(context, request.recordingId));
        } else {
          const request = parse(recordingLifecycleCommandSchema, body);
          data = recordingLifecycleReceiptSchema.parse(await input.lifecycle().command(context, request));
        }
      }
      return reply(200, { data });
    } catch (error) {
      // The separately bundled runtime has its own class identities. Accept only
      // authored error names plus bounded codes, never arbitrary provider text.
      const runtimeCode = error instanceof Error && ['RecordingLifecycleError', 'RecordingUploadError'].includes(error.name)
        && 'code' in error && typeof error.code === 'string'
        && ['request_invalid', 'access_refused', 'consent_required', 'conflict', 'service_unavailable', 'storage_unverified'].includes(error.code)
        ? error.code : 'service_unavailable';
      const code = error instanceof RecordingAuthorityError || error instanceof RecordingLifecycleError || error instanceof RecordingUploadError
        ? error.code : runtimeCode;
      return reply(code === 'reauth_required' ? 401 : code === 'request_invalid' ? 400 : code === 'conflict' ? 409
        : ['access_refused', 'consent_required', 'recording_access_refused', 'recording_consent_required'].includes(code) ? 403 : 503, { error: code });
    }
  };
}
