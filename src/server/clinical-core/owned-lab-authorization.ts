import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {OwnedStorageError,type createOwnedConsumerRecordsAdapter} from './owned-consumer-records';

type Adapter=Pick<ReturnType<typeof createOwnedConsumerRecordsAdapter>,'consentState'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Lab/document processing sends health documents and measured values to the
 * AI service and stores resulting observations in the owner's personal lab
 * history. Both owner-specific consents are therefore bound to every job. */
export const LAB_AUTHORIZATION_SCOPES=['ai_context','lab_history'] as const;
export type LabAuthorization={
  version:'owned-lab/1';personId:string;organizationId:string;identitySubject:string;
  consents:Record<typeof LAB_AUTHORIZATION_SCOPES[number],{revision:number;releaseVersion:string;contentSha256:string}>;
};
export class LabAuthorizationRevoked extends Error{constructor(){super('lab_consent_required');}}
/** Minimal job shape the policy needs; the lab job store owns the rest. */
export type AuthorizedLabJob={ownerSub:string;organizationId:string;personId:string;authorization?:LabAuthorization};
export type LabAuthorizationPolicy={verify(job:AuthorizedLabJob):Promise<void>};

function validRevision(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=1;}
export function sameLabAuthorization(a:LabAuthorization|undefined,b:LabAuthorization|undefined):boolean{
  return JSON.stringify(a??null)===JSON.stringify(b??null);
}
export function createOwnedLabAuthorization(adapter:()=>Adapter,now=()=>Date.now()){
  const capture=async(context:ProductionClinicalRequestContext):Promise<LabAuthorization>=>{
    const consents={} as LabAuthorization['consents'];
    for(const scope of LAB_AUTHORIZATION_SCOPES){
      const state=await adapter().consentState({...context,purpose:'consent_management'},scope);
      if(state.scope!==scope||!state.release||!state.current||state.current.status!=='granted'||state.activeRevision!==state.current.revision
        ||!validRevision(state.current.revision)||!/^[a-f0-9]{64}$/.test(state.release.contentSha256)
        ||state.current.releaseVersion!==state.release.version||!Number.isFinite(Date.parse(state.release.approvedAt))
        ||Date.parse(state.release.approvedAt)>now())throw new LabAuthorizationRevoked();
      consents[scope]={revision:state.current.revision,releaseVersion:state.current.releaseVersion,contentSha256:state.release.contentSha256};
    }
    return {version:'owned-lab/1',personId:context.actorPersonId,organizationId:context.organizationId,identitySubject:context.identitySubject,consents};
  };
  const policy:LabAuthorizationPolicy={
    async verify(job){
      const a=job.authorization;
      if(!a||a.version!=='owned-lab/1'||!UUID.test(a.personId)||!UUID.test(a.organizationId)
        ||!/^[A-Za-z0-9:_-]{8,128}$/.test(a.identitySubject))throw new LabAuthorizationRevoked();
      // The stored job identity and the captured authorization must agree; a
      // job cannot carry another person's consent.
      if(job.ownerSub!==a.identitySubject||job.organizationId!==a.organizationId||job.personId!==a.personId)throw new LabAuthorizationRevoked();
      const context:ProductionClinicalRequestContext={actorPersonId:a.personId,organizationId:a.organizationId,identitySubject:a.identitySubject,
        identityPool:'consumer',purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
      try{
        const current=await capture(context);
        for(const scope of LAB_AUTHORIZATION_SCOPES)if(a.consents?.[scope]?.revision!==current.consents[scope].revision
          ||a.consents?.[scope]?.releaseVersion!==current.consents[scope].releaseVersion
          ||a.consents?.[scope]?.contentSha256!==current.consents[scope].contentSha256)throw new LabAuthorizationRevoked();
      }catch(error){
        if(error instanceof OwnedStorageError&&['owner_required','consent_required'].includes(error.code))throw new LabAuthorizationRevoked();
        throw error;
      }
    },
  };
  return {capture,policy};
}
