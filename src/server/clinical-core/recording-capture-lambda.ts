import type { ApiGatewayV2Event } from './aws-identity-api';
import { qualificationActivation, qualificationFrom } from './qualification-execution';
import { createRecordingCaptureApi } from './recording-capture-api';
import type { createRecordingCaptureRuntime } from './recording-capture-runtime';

let cached: ReturnType<typeof createRecordingCaptureApi> | undefined;
let services: ReturnType<typeof createRecordingCaptureRuntime> | undefined;
function runtime() {
  // Deliberately separate deployment bundle: inactive/unauthenticated requests
  // must not load or initialize database/storage SDKs. Both files ship together.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeModule = services ? undefined : require('./recording-capture-runtime.js') as { createRecordingCaptureRuntime: typeof createRecordingCaptureRuntime };
  return services ??= runtimeModule!.createRecordingCaptureRuntime(process.env);
}
export async function handler(event: ApiGatewayV2Event) {
  if (!cached) {
    const e = process.env;
    cached = createRecordingCaptureApi({ configuration: {
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '', organizationId: e.RECORDING_ORGANIZATION_ID ?? '',
      phiAllowed: e.PHI_ALLOWED === 'true', activation: qualificationActivation(e.RECORDING_CAPTURE_ACTIVATION), ...qualificationFrom(e, e.RECORDING_CAPTURE_ACTIVATION),
      activationEvidenceSha256: e.RECORDING_CAPTURE_EVIDENCE_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, captureReleaseId: e.RECORDING_CAPTURE_RELEASE_ID ?? '',
      captureReviewSha256: e.RECORDING_CAPTURE_REVIEW_SHA256, storageReviewSha256: e.RECORDING_STORAGE_REVIEW_SHA256,
      retentionReviewSha256: e.RECORDING_RETENTION_REVIEW_SHA256,
    }, lifecycle: () => runtime().lifecycle, upload: () => runtime().upload, reconcile: () => runtime().reconcile });
  }
  return cached(event);
}
