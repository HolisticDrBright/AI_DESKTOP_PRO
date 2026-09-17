import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import {privacyOperationSchema,parsePrivacyOperationResult,type PrivacyOperation} from '@/contracts/privacyOperations';
export class PrivacyOperationError extends Error{
  constructor(readonly code:'reauth_required'|'privacy_access_refused'|'request_invalid'|'conflict'|'legal_hold'|'service_unavailable'){super(code);}
}
export function createPrivacyOperations(database:ClinicalCoreDatabase){
  return async(context:ProductionClinicalRequestContext,input:PrivacyOperation)=>{
    const parsed=privacyOperationSchema.safeParse(input);
    if(!parsed.success)throw new PrivacyOperationError('request_invalid');
    const v=parsed.data;
    if(context.identityPool!=='workforce'||context.purpose!=='consent_management'||context.environment!=='production-clinical'
      ||context.dataClassification!=='clinical_phi'||!context.productionBound||!context.containsPhi||!context.realPatientData)
      throw new PrivacyOperationError('privacy_access_refused');
    try{return await database.transaction(async tx=>{
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
        clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,
        context.purpose,context.environment,context.dataClassification]);
      if(v.action==='list'){
        const result=await tx.query<{result:unknown}>('select clinical_private.list_assigned_privacy_requests($1,25,$2) as result',
          [v.after?clinicalUuid(v.after):null,v.includeClosed]);
        const items=decode(result.rows[0]?.result);
        if(!Array.isArray(items))throw new Error('shape');
        return parsePrivacyOperationResult(v,{items,nextAfter:items.length===25?items.at(-1)?.privacyRequestId:null});
      }
      if(v.action==='resolve')await tx.query('select clinical_private.resolve_owned_correction($1,$2,$3,$4)',
        [clinicalUuid(v.privacyRequestId),v.outcome,v.appliedRevision,v.explanation]);
      const result=await tx.query<{result:unknown}>('select clinical_private.get_assigned_privacy_request($1) as result',[clinicalUuid(v.privacyRequestId)]);
      return parsePrivacyOperationResult(v,decode(result.rows[0]?.result));
    });}catch(error){
      if(error instanceof PrivacyOperationError)throw error;
      if(error instanceof ClinicalCoreDatabaseRejection){
        const code=error.category;
        throw new PrivacyOperationError(code==='identity_refused'||code==='operation_refused'?'privacy_access_refused':
          code==='conflict'||code==='legal_hold'||code==='request_invalid'?code:'service_unavailable');
      }
      throw new PrivacyOperationError('service_unavailable');
    }
  };
}
function decode(value:unknown):unknown{return typeof value==='string'?JSON.parse(value):value;}
