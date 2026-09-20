import type { ApiGatewayV2Event } from './aws-identity-api';
import { createRecordingDraftingApi } from './recording-drafting-api';
import type { createRecordingDraftingRuntime } from './recording-drafting-runtime';

let cached: ReturnType<typeof createRecordingDraftingApi> | undefined;
let services: ReturnType<typeof createRecordingDraftingRuntime> | undefined;
function runtime() {
  // Separate bundle: inactive or unauthenticated requests never load SDKs or the provider client.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeModule = services ? undefined : require('./recording-drafting-runtime.js') as { createRecordingDraftingRuntime: typeof createRecordingDraftingRuntime };
  return services ??= runtimeModule!.createRecordingDraftingRuntime(process.env);
}
export async function handler(event: ApiGatewayV2Event) {
  if (!cached) {
    const e = process.env;
    cached = createRecordingDraftingApi({ configuration: {
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '', organizationId: e.RECORDING_ORGANIZATION_ID ?? '',
      phiAllowed: e.PHI_ALLOWED === 'true', activation: e.RECORDING_DRAFTING_ACTIVATION === 'approved' ? 'approved' : 'blocked',
      activationEvidenceSha256: e.RECORDING_DRAFTING_EVIDENCE_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, draftingReleaseId: e.RECORDING_DRAFTING_RELEASE_ID ?? '',
      draftingReviewSha256: e.RECORDING_DRAFTING_REVIEW_SHA256, providerReviewSha256: e.RECORDING_PROVIDER_REVIEW_SHA256,
      storageReviewSha256: e.RECORDING_STORAGE_REVIEW_SHA256, openAiSecretArn: e.RECORDING_DRAFTING_OPENAI_SECRET_ARN ?? '',
    }, processor: () => runtime() });
  }
  return cached(event);
}
