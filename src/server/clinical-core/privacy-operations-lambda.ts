import type {ApiGatewayV2Event} from './aws-identity-api';
import {createPrivacyOperationsApi} from './privacy-operations-api';
import {createPrivacyOperations} from './privacy-operations';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
let cached:ReturnType<typeof createPrivacyOperationsApi>|undefined;
export async function handler(event:ApiGatewayV2Event){
  if(!cached){
    const e=process.env;
    cached=createPrivacyOperationsApi({configuration:{workforceIssuer:e.WORKFORCE_ISSUER??'',workforceAudience:e.WORKFORCE_AUDIENCE??'',
      phiAllowed:e.PHI_ALLOWED==='true',activation:e.PRIVACY_OPERATIONS_ACTIVATION==='approved'?'approved':'blocked',
      evidenceSha256:e.PRIVACY_OPERATIONS_EVIDENCE_SHA256,mfaReviewSha256:e.WORKFORCE_MFA_REVIEW_SHA256,
      personalPurgeEnabled:e.PERSONAL_PURGE_ENABLED==='true',personalPurgeEvidenceSha256:e.PERSONAL_PURGE_EVIDENCE_SHA256},
      operations:()=>createPrivacyOperations(createRdsDataClinicalCoreDatabase({clusterArn:e.CLINICAL_DATABASE_CLUSTER_ARN??'',
        secretArn:e.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:e.CLINICAL_DATABASE_NAME??'',region:e.AWS_REGION}))});
  }
  return cached(event);
}
