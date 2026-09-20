import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { recordingWorkforceActivation, recordingWorkforceIdentity, type RecordingAuthorityConfiguration } from './recording-authority-api';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { RecordingTranscriptionError, type createRecordingTranscriptionProcessor } from './recording-transcription';
import { transcriptionOperationSchema, transcriptionListingSchema, transcriptionReceiptSchema, transcriptContentSchema } from '@/contracts/encounterRecordingTranscription';

export const RECORDING_TRANSCRIPTION_ROUTE = 'POST /clinical-core/workforce/encounter-recording/transcription';
export type RecordingTranscriptionConfiguration = RecordingAuthorityConfiguration & {
  transcriptionReleaseId: string; transcriptionReviewSha256?: string; providerReviewSha256?: string; storageReviewSha256?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, hash = /^[a-f0-9]{64}$/;
const reply = (statusCode: number, value: unknown): ApiGatewayV2Response => ({ statusCode, body: JSON.stringify(value),
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
/** Gateway-verified workforce identity only; one route, five operations. Every
 * operation is authorized again inside the database. Transcript text is returned
 * only through `read`, never listed, logged or cached. */
export function createRecordingTranscriptionApi(input: { configuration: RecordingTranscriptionConfiguration;
  processor: () => ReturnType<typeof createRecordingTranscriptionProcessor>; now?: () => number }) {
  const c = input.configuration;
  const active = recordingWorkforceActivation(c) && uuid.test(c.transcriptionReleaseId)
    && [c.transcriptionReviewSha256, c.providerReviewSha256, c.storageReviewSha256].every(v => hash.test(v ?? ''));
  if (c.phiAllowed && !active) throw new Error('recording_api_activation_invalid');
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!active) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (event.routeKey !== RECORDING_TRANSCRIPTION_ROUTE) return reply(404, { error: 'route_not_found' });
    try {
      const context = recordingWorkforceIdentity(event, c, input.now?.() ?? Date.now());
      const type = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      if (Object.keys(event.queryStringParameters ?? {}).length || type?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || typeof event.body !== 'string' || event.body.length > 3_000_000) throw new RecordingTranscriptionError('request_invalid');
      const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
      if (bytes.length > 2_100_000 || event.isBase64Encoded && bytes.toString('base64') !== event.body) throw new RecordingTranscriptionError('request_invalid');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new RecordingTranscriptionError('request_invalid'); }
      const request = transcriptionOperationSchema.safeParse(raw);
      if (!request.success) throw new RecordingTranscriptionError('request_invalid');
      const processor = input.processor();
      const op = request.data;
      let data: unknown;
      if (op.operation === 'request') data = transcriptionReceiptSchema.parse(await processor.request(context, op.input.recordingId, op.input.commandId));
      else if (op.operation === 'advance') data = transcriptionListingSchema.parse(await processor.advance(context, op.input.recordingId));
      else if (op.operation === 'list') data = transcriptionListingSchema.parse(await processor.list(context, op.input.recordingId));
      else if (op.operation === 'reconcile') data = transcriptionListingSchema.parse(await processor.reconcile(context, op.input.recordingId));
      else if (op.operation === 'correct') { await processor.correct(context, op.input.recordingId, op.input.text, op.input.reason);
        data = transcriptionListingSchema.parse(await processor.list(context, op.input.recordingId)); }
      else data = transcriptContentSchema.parse(await processor.read(context, op.input.transcriptId));
      return reply(200, { data, capabilities: { transcription: true, aiDrafting: false, reason: 'ai_drafting_not_configured' } });
    } catch (error) {
      const known = ['request_invalid', 'access_refused', 'consent_required', 'conflict', 'refused', 'legal_hold', 'service_unavailable', 'storage_unverified', 'media_too_large'];
      const code = error instanceof RecordingAuthorityError ? error.code
        : error instanceof Error && error.name === 'RecordingTranscriptionError' && 'code' in error && typeof error.code === 'string' && known.includes(error.code) ? error.code
        : 'service_unavailable';
      return reply(code === 'reauth_required' ? 401 : code === 'request_invalid' ? 400 : code === 'conflict' ? 409 : code === 'media_too_large' ? 413
        : ['access_refused', 'consent_required', 'refused', 'legal_hold', 'recording_access_refused', 'recording_consent_required'].includes(code) ? 403 : 503, { error: code });
    }
  };
}
