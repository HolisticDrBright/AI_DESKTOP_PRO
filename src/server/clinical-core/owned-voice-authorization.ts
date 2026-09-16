import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {OwnedStorageError,type createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {VoiceAuthorizationRevoked,type VoiceAuthorization,type VoiceAuthorizationPolicy} from './voice-authorization';

type Adapter=Pick<ReturnType<typeof createOwnedConsumerRecordsAdapter>,'consentState'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPES=['ai_context','voice_transcription'] as const;
export function voiceOwner(context:Pick<ProductionClinicalRequestContext,'actorPersonId'|'organizationId'|'identitySubject'>){
  return `production:${context.organizationId}:${context.actorPersonId}:${context.identitySubject}`;
}
export function createOwnedVoiceAuthorization(adapter:()=>Adapter,now=()=>Date.now()){
  const capture=async(context:ProductionClinicalRequestContext):Promise<VoiceAuthorization>=>{
    const consents={} as VoiceAuthorization['consents'];
    for(const scope of SCOPES){
      const state=await adapter().consentState({...context,purpose:'consent_management'},scope);
      if(state.scope!==scope||!state.release||!state.current||state.current.status!=='granted'||state.activeRevision!==state.current.revision
        ||!Number.isSafeInteger(state.current.revision)||state.current.revision<1||!/^[a-f0-9]{64}$/.test(state.release.contentSha256)
        ||state.current.releaseVersion!==state.release.version||!Number.isFinite(Date.parse(state.release.approvedAt))
        ||Date.parse(state.release.approvedAt)>now())throw new VoiceAuthorizationRevoked();
      consents[scope]={revision:state.current.revision,releaseVersion:state.current.releaseVersion,contentSha256:state.release.contentSha256};
    }
    return {version:'owned-voice/1',personId:context.actorPersonId,organizationId:context.organizationId,identitySubject:context.identitySubject,consents};
  };
  const policy:VoiceAuthorizationPolicy={
    async verify(job){
      const a=job.authorization;
      if(!a||a.version!=='owned-voice/1'||!UUID.test(a.personId)||!UUID.test(a.organizationId)
        ||!/^[A-Za-z0-9:_-]{8,128}$/.test(a.identitySubject))throw new VoiceAuthorizationRevoked();
      const context:ProductionClinicalRequestContext={actorPersonId:a.personId,organizationId:a.organizationId,identitySubject:a.identitySubject,
        identityPool:'consumer',purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
      if(job.owner!==voiceOwner(context))throw new VoiceAuthorizationRevoked();
      try{
        const current=await capture(context);
        for(const scope of SCOPES)if(a.consents?.[scope]?.revision!==current.consents[scope].revision
          ||a.consents?.[scope]?.releaseVersion!==current.consents[scope].releaseVersion
          ||a.consents?.[scope]?.contentSha256!==current.consents[scope].contentSha256)throw new VoiceAuthorizationRevoked();
      }catch(error){
        if(error instanceof OwnedStorageError&&['owner_required','consent_required'].includes(error.code))throw new VoiceAuthorizationRevoked();
        throw error;
      }
    },
  };
  return {capture,policy};
}
