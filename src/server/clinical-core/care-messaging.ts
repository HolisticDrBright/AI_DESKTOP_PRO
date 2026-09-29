import {careMessageRequest,careMessageResponse,type CareMessageRequest,type CareMessageResponse} from '../../contracts/careMessages';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';
export class CareMessageError extends Error {
 constructor(readonly category:'request_invalid'|'identity_refused'|'conflict'|'service_unavailable') {super(category);}
}
export function createCareMessaging(database:ClinicalCoreDatabase) {
 return async (context:ClinicalRequestContext,body:unknown):Promise<CareMessageResponse>=>{
  // This first release is deliberately not a production activation path.
  if(context.environment!=='synthetic-staging'||context.dataClassification!=='synthetic_only')throw new CareMessageError('identity_refused');
  const parsed=careMessageRequest.safeParse(body);
  if(!parsed.success)throw new CareMessageError('request_invalid');
  const request:CareMessageRequest=parsed.data;
  if(request.action==='send'&&((!request.threadId&&!request.subject)||(request.threadId&&request.subject)))throw new CareMessageError('request_invalid');
  try{return await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
    {kind:'uuid',value:context.actorPersonId},{kind:'uuid',value:context.organizationId},context.identityPool,context.identitySubject,
    context.purpose,context.environment,context.dataClassification]);
   const result=await tx.query<{data:unknown}>('select clinical_core.care_message_request($1::jsonb) as data',[JSON.stringify(request)]);
   const raw=result.rows[0]?.data;
   return careMessageResponse.parse(typeof raw==='string'?JSON.parse(raw):raw);
  });}catch(error){
   if(error instanceof ClinicalCoreDatabaseRejection)throw new CareMessageError(error.category==='conflict'?'conflict':error.category==='request_invalid'?'request_invalid':'identity_refused');
   throw new CareMessageError('service_unavailable');
  }
 };
}
