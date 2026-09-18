import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ApiGatewayV2Event} from './aws-identity-api';
import {createRecordingCleanupExecutionApi} from './recording-cleanup-execution-api';
import type {createRecordingCleanupExecutionRuntime} from './recording-cleanup-execution-runtime';
let api:ReturnType<typeof createRecordingCleanupExecutionApi>|undefined,service:ReturnType<typeof createRecordingCleanupExecutionRuntime>|undefined;
function runtime(){
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeModule=service?undefined:require('./recording-cleanup-execution-runtime.js') as {createRecordingCleanupExecutionRuntime:typeof createRecordingCleanupExecutionRuntime};
  return service??=runtimeModule!.createRecordingCleanupExecutionRuntime(process.env);
}
export async function handler(event:ApiGatewayV2Event){
  const e=process.env;
  if(!api){
    // Review binds the actual bundled worker bytes, not a caller's claimed hash.
    if(e.PHI_ALLOWED==='true'){
      const actual=createHash('sha256').update(readFileSync(join(__dirname,'recording-cleanup-execution-runtime.js'))).digest('hex');
      if(actual!==e.RECORDING_CLEANUP_WORKER_SHA256)throw new Error('recording_cleanup_worker_digest_mismatch');
    }
    api=createRecordingCleanupExecutionApi({configuration:{workforceIssuer:e.WORKFORCE_ISSUER??'',workforceAudience:e.WORKFORCE_AUDIENCE??'',
      organizationId:e.RECORDING_ORGANIZATION_ID??'',phiAllowed:e.PHI_ALLOWED==='true',activation:e.RECORDING_CLEANUP_EXECUTION_ACTIVATION==='approved'?'approved':'blocked',
      activationEvidenceSha256:e.RECORDING_CLEANUP_EXECUTION_EVIDENCE_SHA256,mfaReviewSha256:e.WORKFORCE_MFA_REVIEW_SHA256,
      databaseReviewSha256:e.DATABASE_REVIEW_SHA256,cleanupReleaseId:e.RECORDING_CLEANUP_RELEASE_ID,workerSha256:e.RECORDING_CLEANUP_WORKER_SHA256,
      executionReviewSha256:e.RECORDING_CLEANUP_EXECUTION_REVIEW_SHA256,storageReviewSha256:e.RECORDING_STORAGE_REVIEW_SHA256,
      holdCoordinationReviewSha256:e.RECORDING_HOLD_COORDINATION_REVIEW_SHA256},service:runtime});
  }
  return api(event);
}
