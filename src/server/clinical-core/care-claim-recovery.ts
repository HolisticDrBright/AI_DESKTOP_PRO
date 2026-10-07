if(typeof window!=='undefined')throw new Error('care-claim-recovery is server-only');
import {careClaimRequest,parseCareClaimResponse} from '@/contracts/careClaimRecovery';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {ClinicalCoreDatabaseRejection,clinicalUuid,type ClinicalCoreDatabase} from './database';
import {CareConnectionError} from './production-care-connections';

/** Unreleased settlement port. Request identity never supplies actor/clinic
 * authority. Call only through a separately bound, reviewed candidate. */
export function createCareClaimRecovery(database:ClinicalCoreDatabase){
  return async(context:ProductionClinicalRequestContext,body:unknown)=>{
    const parsed=careClaimRequest.safeParse(body);
    if(!parsed.success)throw new CareConnectionError('request_invalid');
    const request=parsed.data;
    if(context.environment!=='production-clinical'||context.dataClassification!=='clinical_phi'||context.productionBound!==true
      ||context.containsPhi!==true||context.realPatientData!==true||context.identityPool!=='consumer'||context.purpose!=='identity_link')
      throw new CareConnectionError('identity_refused');
    try{
      return await database.transaction(async tx=>{
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[clinicalUuid(context.actorPersonId),
          clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,context.purpose,context.environment,context.dataClassification]);
        const result=await tx.query<{data:unknown}>('select clinical_core.production_care_claim_request($1::jsonb) as data',[JSON.stringify(request)]);
        const raw=result.rows[0]?.data;return parseCareClaimResponse(request,typeof raw==='string'?JSON.parse(raw):raw);
      });
    }catch(error){
      if(error instanceof ClinicalCoreDatabaseRejection){
        throw new CareConnectionError(['request_invalid','conflict','account_deletion_write_blocked'].includes(error.category)
          ?error.category as 'request_invalid'|'conflict'|'account_deletion_write_blocked':'identity_refused');
      }
      throw new CareConnectionError('service_unavailable');
    }
  };
}
