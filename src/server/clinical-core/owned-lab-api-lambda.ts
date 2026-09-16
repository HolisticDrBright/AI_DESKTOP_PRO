if (typeof window !== "undefined") throw new Error("owned-lab-api-lambda is server-only");
import {createOwnedLabApi,type OwnedLabEvent} from './owned-lab-api';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
export function ownedLabConfigurationFromEnv(env:Record<string,string|undefined>){
  return {consumerIssuer:env.CONSUMER_ISSUER??'',consumerAudience:env.CONSUMER_AUDIENCE??'',
    phiAllowed:env.PHI_ALLOWED==='true',activationState:env.PERSONAL_LAB_ACTIVATION==='approved'?'approved' as const:'blocked' as const,
    activationEvidenceSha256:env.PERSONAL_LAB_EVIDENCE_SHA256,providerEvidenceSha256:env.PERSONAL_LAB_PROVIDER_EVIDENCE_SHA256,
    allowedScopes:(env.PERSONAL_LAB_ALLOWED_SCOPES??'').split(',').filter(Boolean)};
}
export function ownedLabAdapterFromEnv(env:Record<string,string|undefined>){
  return ()=>createOwnedConsumerRecordsAdapter(createRdsDataClinicalCoreDatabase({clusterArn:env.CLINICAL_DATABASE_CLUSTER_ARN??'',
    secretArn:env.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:env.CLINICAL_DATABASE_NAME??'',region:env.AWS_REGION}));
}
let cached:ReturnType<typeof createOwnedLabApi>|undefined;
export async function handler(event:OwnedLabEvent){
  const env=process.env;
  if(env.LAB_OBJECT_PREFIX!=='personal-labs')throw new Error('owned_lab_namespace_required');
  cached??=createOwnedLabApi({configuration:ownedLabConfigurationFromEnv(env),adapter:ownedLabAdapterFromEnv(env)});
  return cached(event);
}
export { labCleanupHandler as cleanup } from './aws-lab-cleanup-lambda';
