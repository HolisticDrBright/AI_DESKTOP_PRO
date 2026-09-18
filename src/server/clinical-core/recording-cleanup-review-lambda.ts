import type {ApiGatewayV2Event} from './aws-identity-api';
import {createRecordingCleanupReviewApi} from './recording-cleanup-review-api';
import type {createRecordingCleanupReviewRuntime} from './recording-cleanup-review-runtime';
let api:ReturnType<typeof createRecordingCleanupReviewApi>|undefined,service:ReturnType<typeof createRecordingCleanupReviewRuntime>|undefined;
function runtime(){
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeModule=service?undefined:require('./recording-cleanup-review-runtime.js') as {createRecordingCleanupReviewRuntime:typeof createRecordingCleanupReviewRuntime};
  return service??=runtimeModule!.createRecordingCleanupReviewRuntime(process.env);
}
export async function handler(event:ApiGatewayV2Event){
  const e=process.env;
  api??=createRecordingCleanupReviewApi({configuration:{workforceIssuer:e.WORKFORCE_ISSUER??'',workforceAudience:e.WORKFORCE_AUDIENCE??'',
    organizationId:e.RECORDING_ORGANIZATION_ID??'',phiAllowed:e.PHI_ALLOWED==='true',activation:e.RECORDING_CLEANUP_REVIEW_ACTIVATION==='approved'?'approved':'blocked',
    activationEvidenceSha256:e.RECORDING_CLEANUP_REVIEW_EVIDENCE_SHA256,mfaReviewSha256:e.WORKFORCE_MFA_REVIEW_SHA256,
    databaseReviewSha256:e.DATABASE_REVIEW_SHA256,cleanupReviewSha256:e.RECORDING_CLEANUP_REVIEW_SHA256},service:runtime});
  return api(event);
}
