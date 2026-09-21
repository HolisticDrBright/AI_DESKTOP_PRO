import type {ApiGatewayV2Event} from './aws-identity-api';
import {createOwnedConsumerApi} from './owned-consumer-api';
import {createOwnedConsumerRecordsAdapter,OWNED_STORAGE_SCOPES,type OwnedStorageScope} from './owned-consumer-records';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {loadReviewedKnowledge} from './aws-reviewed-knowledge';
import {createOwnedPrivacyExportJobs} from './owned-privacy-export-job';
import {createAwsPrivacyExportStore} from './aws-privacy-export-store';
import {createAwsCrossStoreExportReader} from './aws-cross-store-export-reader';
import {resolveQualificationExecution} from './qualification-execution';
let cached:ReturnType<typeof createOwnedConsumerApi>|undefined;
/** Export delivery exists only with a reviewed bucket, key and owner account; otherwise the job routes refuse. */
function exportDelivery(env:NodeJS.ProcessEnv){
  const bucket=env.PERSONAL_EXPORT_BUCKET??'',kmsKeyArn=env.PERSONAL_EXPORT_KMS_KEY_ARN??'',expectedBucketOwner=env.PERSONAL_EXPORT_BUCKET_OWNER??'',region=env.AWS_REGION??'';
  if(!bucket&&!kmsKeyArn)return undefined;
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||!/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9-]{36}$/.test(kmsKeyArn)||!/^[0-9]{12}$/.test(expectedBucketOwner)||!/^[a-z]{2}-[a-z]+-[1-9]$/.test(region))
    throw new Error('personal_export_configuration_invalid');
  return {store:createAwsPrivacyExportStore(),storage:{bucket,kmsKeyArn,expectedBucketOwner,region},...crossStoreExport(env,region)};
}
/** Cross-store coverage exists only where a store's table and bucket are both named; a half-named store is a configuration error. */
function crossStoreExport(env:NodeJS.ProcessEnv,region:string){
  const pair=(table:string|undefined,bucket:string|undefined)=>{
    const t=table??'',b=bucket??'';
    if(!t&&!b)return undefined;
    if(!t||!b)throw new Error('personal_export_configuration_invalid');
    return {table:t,bucket:b};
  };
  const labs=pair(env.EXPORT_LAB_JOB_TABLE,env.EXPORT_LAB_DOCUMENT_BUCKET),voice=pair(env.EXPORT_VOICE_JOB_TABLE,env.EXPORT_TRANSCRIPTION_BUCKET);
  if(!labs&&!voice)return {};
  return {crossStore:createAwsCrossStoreExportReader({...(labs?{labs}:{}),...(voice?{voice}:{}),region})};
}
export async function handler(event:ApiGatewayV2Event){
  if(!cached){
    const env=process.env;
    const scopes=(env.PERSONAL_STORAGE_ALLOWED_SCOPES??'').split(',').filter(Boolean);
    if(scopes.some(scope=>!OWNED_STORAGE_SCOPES.includes(scope as OwnedStorageScope)))throw new Error('owned_storage_configuration_invalid');
    const delivery=exportDelivery(env);
    const database=()=>createRdsDataClinicalCoreDatabase({clusterArn:env.CLINICAL_DATABASE_CLUSTER_ARN??'',secretArn:env.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:env.CLINICAL_DATABASE_NAME??'',region:env.AWS_REGION});
    const activationState=env.PERSONAL_STORAGE_ACTIVATION==='approved'?'approved' as const:'blocked' as const;
    const qualification=resolveQualificationExecution(env,activationState);
    cached=createOwnedConsumerApi({configuration:{consumerIssuer:env.CONSUMER_ISSUER??'',consumerAudience:env.CONSUMER_AUDIENCE??'',phiAllowed:env.PHI_ALLOWED==='true',activationState,...(qualification?{qualification}:{}),activationEvidenceSha256:env.PERSONAL_STORAGE_EVIDENCE_SHA256,allowedScopes:scopes as OwnedStorageScope[]},
      knowledgeLoader:loadReviewedKnowledge,
      adapter:()=>createOwnedConsumerRecordsAdapter(database()),
      ...(delivery?{exportJobs:()=>createOwnedPrivacyExportJobs((context,work)=>createOwnedConsumerRecordsAdapter(database()).runPrivacy(context,work),delivery)}:{})});
  }
  return cached(event);
}
