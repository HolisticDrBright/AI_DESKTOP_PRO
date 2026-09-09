import type {ApiGatewayV2Event} from './aws-identity-api';
import {createOwnedConsumerApi} from './owned-consumer-api';
import {createOwnedConsumerRecordsAdapter,OWNED_STORAGE_SCOPES,type OwnedStorageScope} from './owned-consumer-records';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
let cached:ReturnType<typeof createOwnedConsumerApi>|undefined;
export async function handler(event:ApiGatewayV2Event){
  if(!cached){
    const env=process.env;
    const scopes=(env.PERSONAL_STORAGE_ALLOWED_SCOPES??'').split(',').filter(Boolean);
    if(scopes.some(scope=>!OWNED_STORAGE_SCOPES.includes(scope as OwnedStorageScope)))throw new Error('owned_storage_configuration_invalid');
    cached=createOwnedConsumerApi({configuration:{consumerIssuer:env.CONSUMER_ISSUER??'',consumerAudience:env.CONSUMER_AUDIENCE??'',phiAllowed:env.PHI_ALLOWED==='true',activationState:env.PERSONAL_STORAGE_ACTIVATION==='approved'?'approved':'blocked',activationEvidenceSha256:env.PERSONAL_STORAGE_EVIDENCE_SHA256,allowedScopes:scopes as OwnedStorageScope[]},
      adapter:()=>createOwnedConsumerRecordsAdapter(createRdsDataClinicalCoreDatabase({clusterArn:env.CLINICAL_DATABASE_CLUSTER_ARN??'',secretArn:env.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:env.CLINICAL_DATABASE_NAME??'',region:env.AWS_REGION}))});
  }
  return cached(event);
}
