import {createOwnedVoiceApi,type OwnedVoiceEvent} from './owned-voice-api';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {createAwsVoiceService} from './aws-voice-jobs-lambda';
let cached:ReturnType<typeof createOwnedVoiceApi>|undefined;
export async function handler(event:OwnedVoiceEvent){
  const env=process.env;
  cached??=createOwnedVoiceApi({
    configuration:{consumerIssuer:env.CONSUMER_ISSUER??'',consumerAudience:env.CONSUMER_AUDIENCE??'',
      phiAllowed:env.PHI_ALLOWED==='true',activationState:env.PERSONAL_VOICE_ACTIVATION==='draining'?'draining':env.PERSONAL_VOICE_ACTIVATION==='approved'?'approved':'blocked',
      activationEvidenceSha256:env.PERSONAL_VOICE_EVIDENCE_SHA256,providerEvidenceSha256:env.PERSONAL_VOICE_PROVIDER_EVIDENCE_SHA256,
      cleanupEvidenceSha256:env.PERSONAL_VOICE_CLEANUP_EVIDENCE_SHA256,
      allowedScopes:(env.PERSONAL_VOICE_ALLOWED_SCOPES??'').split(',').filter(Boolean)},
    adapter:()=>createOwnedConsumerRecordsAdapter(createRdsDataClinicalCoreDatabase({clusterArn:env.CLINICAL_DATABASE_CLUSTER_ARN??'',
      secretArn:env.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:env.CLINICAL_DATABASE_NAME??'',region:env.AWS_REGION})),
    service:policy=>createAwsVoiceService({mode:'production',policy,table:env.VOICE_JOB_TABLE??'',bucket:env.TRANSCRIPTION_BUCKET??'',kms:env.VOICE_KMS_KEY_ARN??''}),
  });
  return cached(event);
}
