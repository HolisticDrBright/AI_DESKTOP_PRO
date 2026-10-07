import {careErasureRecoveryRequest,parseCareErasureRecoveryResponse} from '../../contracts/careErasureRecovery';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';
import {CareDataError} from './care-data-lifecycle';

/** Source candidate only: not wired into the deployed identity handler. Owner
 * identity comes exclusively from the authenticated context, never the body. */
export function createCareErasureRecovery(database:ClinicalCoreDatabase){
 return async(context:ClinicalRequestContext,body:unknown)=>{
  if(context.environment!=='synthetic-staging'||context.dataClassification!=='synthetic_only'
   ||context.identityPool!=='consumer')throw new CareDataError('identity_refused');
  const parsed=careErasureRecoveryRequest.safeParse(body);
  if(!parsed.success)throw new CareDataError('request_invalid');
  const input=parsed.data;
  try{return await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
    {kind:'uuid',value:context.actorPersonId},{kind:'uuid',value:context.organizationId},
    context.identityPool,context.identitySubject,'consent_management',context.environment,context.dataClassification]);
   const fn=input.action==='prepare_erasure'?'clinical_core.care_data_prepare_erasure':'clinical_core.care_data_discover_erasures';
   const result=await tx.query<{data:unknown}>(`select ${fn}($1::jsonb) as data`,[JSON.stringify(input)]);
   const raw=result.rows[0]?.data;
   return parseCareErasureRecoveryResponse(input,typeof raw==='string'?JSON.parse(raw):raw);
  });}catch(error){
   if(error instanceof ClinicalCoreDatabaseRejection)throw new CareDataError(error.category==='conflict'?'conflict'
    :error.category==='request_invalid'?'request_invalid':'identity_refused');
   throw new CareDataError('service_unavailable');
  }
 };
}
