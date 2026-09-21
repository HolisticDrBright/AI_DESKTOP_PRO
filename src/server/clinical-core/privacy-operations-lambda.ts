import type {ApiGatewayV2Event} from './aws-identity-api';
import {createPrivacyOperationsApi} from './privacy-operations-api';
import {resolveQualificationExecution} from './qualification-execution';
import {createPrivacyOperations} from './privacy-operations';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {createExternalInventoryReader} from './privacy-external-inventory';
import {createExternalPurgeExecutor,type ExternalPurgeExecutor} from './privacy-external-purge';
import {ownedExternalDeletionGuardFromEnv} from './owned-external-deletion';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {S3Client} from '@aws-sdk/client-s3';
import {SFNClient} from '@aws-sdk/client-sfn';
import {stopLabExecutions} from './lab-execution-stop';
import {createAwsVoiceService} from './aws-voice-jobs-lambda';
import {createConsumerIdentityDeleter} from './owned-identity-deletion';
import {CognitoIdentityProviderClient} from '@aws-sdk/client-cognito-identity-provider';
import {createAwsPrivacyExportStore} from './aws-privacy-export-store';
import type {PrivacyExportRetentionDelivery} from './privacy-operations';
let cached:ReturnType<typeof createPrivacyOperationsApi>|undefined;
const tableName=(arn:string)=>arn.split(':table/')[1]??'';
/** Purge dependencies are built only when the reviewed purge flag is on; the
 * lab and voice tables are the same deployment-pinned ARNs the inventory reads. */
function purgeExecutor(e:NodeJS.ProcessEnv):(()=>ExternalPurgeExecutor)|undefined{
  if(e.EXTERNAL_PURGE_ENABLED!=='true')return undefined;
  if(e.LAB_OBJECT_PREFIX!=='personal-labs')throw new Error('privacy_purge_configuration_invalid');
  return()=>{
    const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:e.AWS_REGION}));
    const deletionGuard=ownedExternalDeletionGuardFromEnv(e);
    const sfn=new SFNClient({region:e.AWS_REGION});
    const voice=createAwsVoiceService({table:tableName(e.PRIVACY_VOICE_TABLE_ARN??''),bucket:e.VOICE_BUCKET??'',kms:e.VOICE_KMS_KEY_ARN??'',
      mode:'production',policy:{verify:async()=>{/* purge only advances jobs it has already cancelled */}},deletionGuard});
    return createExternalPurgeExecutor({
      lab:{db,s3:new S3Client({region:e.AWS_REGION}),table:tableName(e.PRIVACY_LAB_TABLE_ARN??''),bucket:e.LAB_DOCUMENT_BUCKET??'',deletionGuard,
        stopExecutions:jobId=>stopLabExecutions(sfn,e.LAB_STATE_MACHINE_ARN??'',jobId)},
      voice:{db,table:tableName(e.PRIVACY_VOICE_TABLE_ARN??''),service:voice},
    });
  };
}
function identityDeleter(e:NodeJS.ProcessEnv){
  if(e.IDENTITY_DELETION_ENABLED!=='true')return undefined;
  return()=>createConsumerIdentityDeleter({client:new CognitoIdentityProviderClient({region:e.AWS_REGION}),poolId:e.CONSUMER_USER_POOL_ID??''});
}
/** Export retention is built only when its reviewed flag is on and the export bucket, key and owner are all pinned. */
function exportRetention(e:NodeJS.ProcessEnv):(()=>PrivacyExportRetentionDelivery)|undefined{
  if(e.EXPORT_CLEANUP_ENABLED!=='true')return undefined;
  const storage={bucket:e.PERSONAL_EXPORT_BUCKET??'',kmsKeyArn:e.PERSONAL_EXPORT_KMS_KEY_ARN??'',expectedBucketOwner:e.PERSONAL_EXPORT_BUCKET_OWNER??'',region:e.AWS_REGION??''};
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(storage.bucket)||!/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9-]{36}$/.test(storage.kmsKeyArn)
    ||!/^[0-9]{12}$/.test(storage.expectedBucketOwner)||!/^[a-z0-9-]+$/.test(storage.region))throw new Error('privacy_export_cleanup_configuration_invalid');
  return()=>({store:createAwsPrivacyExportStore(),storage});
}
export async function handler(event:ApiGatewayV2Event){
  if(!cached){
    const e=process.env;
    const activation=e.PRIVACY_OPERATIONS_ACTIVATION==='approved'?'approved' as const:'blocked' as const;
    const qualification=resolveQualificationExecution(e,activation);
    cached=createPrivacyOperationsApi({configuration:{workforceIssuer:e.WORKFORCE_ISSUER??'',workforceAudience:e.WORKFORCE_AUDIENCE??'',
      phiAllowed:e.PHI_ALLOWED==='true',activation,...(qualification?{qualification}:{}),
      evidenceSha256:e.PRIVACY_OPERATIONS_EVIDENCE_SHA256,mfaReviewSha256:e.WORKFORCE_MFA_REVIEW_SHA256,
      personalPurgeEnabled:e.PERSONAL_PURGE_ENABLED==='true',personalPurgeEvidenceSha256:e.PERSONAL_PURGE_EVIDENCE_SHA256,
      externalInventoryEnabled:e.EXTERNAL_INVENTORY_ENABLED==='true',externalInventoryEvidenceSha256:e.EXTERNAL_INVENTORY_EVIDENCE_SHA256,
      externalPurgeEnabled:e.EXTERNAL_PURGE_ENABLED==='true',externalPurgeEvidenceSha256:e.EXTERNAL_PURGE_EVIDENCE_SHA256,
      identityDeletionEnabled:e.IDENTITY_DELETION_ENABLED==='true',identityDeletionEvidenceSha256:e.IDENTITY_DELETION_EVIDENCE_SHA256,
      exportCleanupEnabled:e.EXPORT_CLEANUP_ENABLED==='true',exportCleanupEvidenceSha256:e.EXPORT_CLEANUP_EVIDENCE_SHA256},
      operations:()=>createPrivacyOperations(createRdsDataClinicalCoreDatabase({clusterArn:e.CLINICAL_DATABASE_CLUSTER_ARN??'',
        secretArn:e.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:e.CLINICAL_DATABASE_NAME??'',region:e.AWS_REGION}),
        ()=>createExternalInventoryReader({labs:e.PRIVACY_LAB_TABLE_ARN??'',voice:e.PRIVACY_VOICE_TABLE_ARN??'',region:e.AWS_REGION??''}),
        purgeExecutor(e),identityDeleter(e),exportRetention(e))});
  }
  return cached(event);
}
