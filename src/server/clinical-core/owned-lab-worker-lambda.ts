if (typeof window !== "undefined") throw new Error("owned-lab-worker-lambda is server-only");
import {createAwsLabAnalysisWorker} from './aws-lab-analysis-worker';
import {createOwnedLabAuthorization} from './owned-lab-authorization';
import {ownedLabAdapterFromEnv} from './owned-lab-api-lambda';
import {publishLabResult} from './owned-lab-publication';
import {resolveQualificationExecution} from './qualification-execution';
let policy:ReturnType<typeof createOwnedLabAuthorization>['policy']|undefined;
/** Production worker: every pass re-verifies the job's consent binding before
 * provider dispatch and before the result is stored. A blocked candidate
 * refuses instead of processing without a policy. */
export async function handler(event:{jobId?:string;pass?:number;fail?:boolean;failureCategory?:string}){
  const env=process.env;
  if(env.LAB_OBJECT_PREFIX!=='personal-labs')throw new Error('owned_lab_namespace_required');
  // Production activation, or qualification execution (jobs exist only for admitted fixture identities; consent is re-verified per pass).
  const activation=env.PERSONAL_LAB_ACTIVATION==='approved'?'approved':'blocked';
  const qualification=resolveQualificationExecution(env,activation);
  if(!(env.PHI_ALLOWED==='true'&&activation==='approved')&&qualification===undefined)throw new Error('production_not_activated');
  const adapter=ownedLabAdapterFromEnv(env);
  policy??=createOwnedLabAuthorization(adapter).policy;
  const verify=policy;
  return createAwsLabAnalysisWorker(event,{policy,publish:async job=>{await verify.verify(job);return publishLabResult({job,adapter});}});
}
