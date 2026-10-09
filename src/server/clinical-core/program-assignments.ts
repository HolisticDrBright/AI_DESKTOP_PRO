import {programAssignmentRequest,parseProgramAssignmentResponse,type ProgramAssignmentRequest,type ProgramAssignmentResponse} from '../../contracts/programAssignments';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';
/**
 * Program assignment adapter. Authorization, safety holds, phase order and the
 * clock all live in SQL; this only carries the request across and refuses a reply
 * that is not bound to what was asked.
 */
export class ProgramAssignmentError extends Error {
 constructor(readonly category:'request_invalid'|'identity_refused'|'conflict'|'service_unavailable') {super(category);}
}
const CONSUMER_ONLY=new Set(['list','read','accept','complete','check_in','advance','pause','resume','withdraw']);
const WORKFORCE_ONLY=new Set(['assign','status','release','connections','programs','preview']);
export function createProgramAssignments(database:ClinicalCoreDatabase) {
 return async (context:ClinicalRequestContext,body:unknown):Promise<ProgramAssignmentResponse>=>{
  // Not a production activation path, for the same reason messaging is not.
  if(context.environment!=='synthetic-staging'||context.dataClassification!=='synthetic_only')throw new ProgramAssignmentError('identity_refused');
  const parsed=programAssignmentRequest.safeParse(body);
  if(!parsed.success)throw new ProgramAssignmentError('request_invalid');
  const request:ProgramAssignmentRequest=parsed.data;
  if(CONSUMER_ONLY.has(request.action)&&context.identityPool!=='consumer')throw new ProgramAssignmentError('identity_refused');
  if(WORKFORCE_ONLY.has(request.action)&&context.identityPool!=='workforce')throw new ProgramAssignmentError('identity_refused');
  try{return await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
    {kind:'uuid',value:context.actorPersonId},{kind:'uuid',value:context.organizationId},context.identityPool,context.identitySubject,
    context.purpose,context.environment,context.dataClassification]);
   const result=await tx.query<{data:unknown}>('select clinical_core.program_assignment_request($1::jsonb) as data',[JSON.stringify(request)]);
   const raw=result.rows[0]?.data;
   return parseProgramAssignmentResponse(request,typeof raw==='string'?JSON.parse(raw):raw);
  });}catch(error){
   if(error instanceof ClinicalCoreDatabaseRejection)throw new ProgramAssignmentError(error.category==='conflict'?'conflict':error.category==='request_invalid'?'request_invalid':'identity_refused');
   throw new ProgramAssignmentError('service_unavailable');
  }
 };
}
