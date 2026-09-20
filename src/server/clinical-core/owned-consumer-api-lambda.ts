import type {ApiGatewayV2Event} from './aws-identity-api';
import {createOwnedConsumerApi} from './owned-consumer-api';
import {createOwnedConsumerRecordsAdapter,OWNED_STORAGE_SCOPES,type OwnedStorageScope} from './owned-consumer-records';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {loadReviewedKnowledge} from './aws-reviewed-knowledge';
import {createOwnedPrivacyExportJobs} from './owned-privacy-export-job';
import {createAwsPrivacyExportStore} from './aws-privacy-export-store';
let cached:ReturnType<typeof createOwnedConsumerApi>|undefined;
/** Export delivery exists only with a reviewed bucket, key and owner account; otherwise the job routes refuse. */
function exportDelivery(env:NodeJS.ProcessEnv){
  const bucket=env.PERSONAL_EXPORT_BUCKET??'',kmsKeyArn=env.PERSONAL_EXPORT_KMS_KEY_ARN??'',expectedBucketOwner=env.PERSONAL_EXPORT_BUCKET_OWNER??'',region=env.AWS_REGION??'';
  if(!bucket&&!kmsKeyArn)return undefined;
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||!/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9-]{36}$/.test(kmsKeyArn)||!/^[0-9]{12}$/.test(expectedBucketOwner)||!/^[a-z]{2}-[a-z]+-[1-9]$/.test(region))
    throw new Error('personal_export_configuration_invalid');
  return {store:createAwsPrivacyExportStore(),storage:{bucket,kmsKeyArn,expectedBucketOwner,region}};
}
export async function handler(event:ApiGatewayV2Event){
  if(!cached){
    const env=process.env;
    const scopes=(env.PERSONAL_STORAGE_ALLOWED_SCOPES??'').split(',').filter(Boolean);
    if(scopes.some(scope=>!OWNED_STORAGE_SCOPES.includes(scope as OwnedStorageScope)))throw new Error('owned_storage_configuration_invalid');
    const delivery=exportDelivery(env);
    const database=()=>createRdsDataClinicalCoreDatabase({clusterArn:env.CLINICAL_DATABASE_CLUSTER_ARN??'',secretArn:env.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:env.CLINICAL_DATABASE_NAME??'',region:env.AWS_REGION});
    cached=createOwnedConsumerApi({configuration:{consumerIssuer:env.CONSUMER_ISSUER??'',consumerAudience:env.CONSUMER_AUDIENCE??'',phiAllowed:env.PHI_ALLOWED==='true',activationState:env.PERSONAL_STORAGE_ACTIVATION==='approved'?'approved':'blocked',activationEvidenceSha256:env.PERSONAL_STORAGE_EVIDENCE_SHA256,allowedScopes:scopes as OwnedStorageScope[]},
      knowledgeLoader:loadReviewedKnowledge,
      adapter:()=>createOwnedConsumerRecordsAdapter(database()),
      ...(delivery?{exportJobs:()=>createOwnedPrivacyExportJobs((context,work)=>createOwnedConsumerRecordsAdapter(database()).runPrivacy(context,work),delivery)}:{})});
  }
  return cached(event);
}
