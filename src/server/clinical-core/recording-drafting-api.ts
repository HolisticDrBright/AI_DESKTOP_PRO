import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { recordingWorkforceActivation, recordingWorkforceIdentity, type RecordingAuthorityConfiguration } from './recording-authority-api';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { RecordingDraftingError, type createRecordingDraftingProcessor } from './recording-drafting';
import { draftingOperationSchema, draftingListingSchema, draftingReceiptSchema, proposedNoteContentSchema } from '@/contracts/encounterRecordingDrafting';

export const RECORDING_DRAFTING_ROUTE = 'POST /clinical-core/workforce/encounter-recording/drafting';
export type RecordingDraftingConfiguration = RecordingAuthorityConfiguration & {
  draftingReleaseId: string; draftingReviewSha256?: string; providerReviewSha256?: string; storageReviewSha256?: string; openAiSecretArn: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, hash = /^[a-f0-9]{64}$/;
const secretArn = /^arn:(aws|aws-us-gov):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const reply = (statusCode: number, value: unknown): ApiGatewayV2Response => ({ statusCode, body: JSON.stringify(value),
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
/** Gateway-verified workforce identity only; one route, four operations. The
 * service never writes a clinical note: proposed text leaves only through `read`. */
export function createRecordingDraftingApi(input: { configuration: RecordingDraftingConfiguration;
  processor: () => ReturnType<typeof createRecordingDraftingProcessor>; now?: () => number }) {
  const c = input.configuration;
  const active = recordingWorkforceActivation(c) && uuid.test(c.draftingReleaseId) && secretArn.test(c.openAiSecretArn)
    && [c.draftingReviewSha256, c.providerReviewSha256, c.storageReviewSha256].every(v => hash.test(v ?? ''));
  if (c.phiAllowed && !active) throw new Error('recording_api_activation_invalid');
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!active) return reply(503, { error: 'production_not_activated', phiAllowed: false });
    if (event.routeKey !== RECORDING_DRAFTING_ROUTE) return reply(404, { error: 'route_not_found' });
    try {
      const context = recordingWorkforceIdentity(event, c, input.now?.() ?? Date.now());
      const type = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
      if (Object.keys(event.queryStringParameters ?? {}).length || type?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || typeof event.body !== 'string' || event.body.length > 20_000) throw new RecordingDraftingError('request_invalid');
      const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
      if (bytes.length > 16_000 || event.isBase64Encoded && bytes.toString('base64') !== event.body) throw new RecordingDraftingError('request_invalid');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new RecordingDraftingError('request_invalid'); }
      const request = draftingOperationSchema.safeParse(raw);
      if (!request.success) throw new RecordingDraftingError('request_invalid');
      const processor = input.processor();
      const op = request.data;
      let data: unknown;
      if (op.operation === 'request') data = draftingReceiptSchema.parse(await processor.request(context, op.input.recordingId, op.input.transcriptId, op.input.commandId, op.input.noteType));
      else if (op.operation === 'advance') data = draftingListingSchema.parse(await processor.advance(context, op.input.recordingId));
      else if (op.operation === 'list') data = draftingListingSchema.parse(await processor.list(context, op.input.recordingId));
      else if (op.operation === 'reconcile') data = draftingListingSchema.parse(await processor.reconcile(context, op.input.recordingId));
      else data = proposedNoteContentSchema.parse(await processor.read(context, op.input.proposedNoteId));
      return reply(200, { data, capabilities: { aiDrafting: true, writesClinicalNotes: false, reason: 'review_only' } });
    } catch (error) {
      const known = ['request_invalid', 'access_refused', 'consent_required', 'conflict', 'refused', 'legal_hold', 'service_unavailable', 'storage_unverified',
        'provider_unavailable', 'provider_output_invalid', 'prompt_unreviewed'];
      const code = error instanceof RecordingAuthorityError ? error.code
        : error instanceof Error && error.name === 'RecordingDraftingError' && 'code' in error && typeof error.code === 'string' && known.includes(error.code) ? error.code
        : 'service_unavailable';
      return reply(code === 'reauth_required' ? 401 : code === 'request_invalid' ? 400 : code === 'conflict' ? 409
        : ['access_refused', 'consent_required', 'refused', 'legal_hold', 'recording_access_refused', 'recording_consent_required'].includes(code) ? 403 : 503, { error: code });
    }
  };
}
