import type { ApiGatewayV2Event } from './aws-identity-api';
import { qualificationActivation, qualificationFrom } from './qualification-execution';
import { createRecordingTranscriptionApi } from './recording-transcription-api';
import type { createRecordingTranscriptionRuntime } from './recording-transcription-runtime';

let cached: ReturnType<typeof createRecordingTranscriptionApi> | undefined;
let services: ReturnType<typeof createRecordingTranscriptionRuntime> | undefined;
function runtime() {
  // Separate bundle: inactive or unauthenticated requests never load SDKs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeModule = services ? undefined : require('./recording-transcription-runtime.js') as { createRecordingTranscriptionRuntime: typeof createRecordingTranscriptionRuntime };
  return services ??= runtimeModule!.createRecordingTranscriptionRuntime(process.env);
}
export async function handler(event: ApiGatewayV2Event) {
  if (!cached) {
    const e = process.env;
    cached = createRecordingTranscriptionApi({ configuration: {
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '', organizationId: e.RECORDING_ORGANIZATION_ID ?? '',
      phiAllowed: e.PHI_ALLOWED === 'true', activation: qualificationActivation(e.RECORDING_TRANSCRIPTION_ACTIVATION), ...qualificationFrom(e, e.RECORDING_TRANSCRIPTION_ACTIVATION),
      activationEvidenceSha256: e.RECORDING_TRANSCRIPTION_EVIDENCE_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, transcriptionReleaseId: e.RECORDING_TRANSCRIPTION_RELEASE_ID ?? '',
      transcriptionReviewSha256: e.RECORDING_TRANSCRIPTION_REVIEW_SHA256, providerReviewSha256: e.RECORDING_PROVIDER_REVIEW_SHA256,
      storageReviewSha256: e.RECORDING_STORAGE_REVIEW_SHA256,
    }, processor: () => runtime() });
  }
  return cached(event);
}
