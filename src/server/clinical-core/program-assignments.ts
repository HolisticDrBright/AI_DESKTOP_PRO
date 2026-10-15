import {programAssignmentRequest,parseProgramAssignmentResponse,PROGRAM_REFUSAL_REASONS,type ProgramAssignmentRequest,type ProgramAssignmentResponse,type ProgramRefusalReason} from '../../contracts/programAssignments';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';
/**
 * Program assignment adapter. Authorization, safety holds, phase order and the
 * clock all live in SQL; this only carries the request across and refuses a reply
 * that is not bound to what was asked.
 */
export class ProgramAssignmentError extends Error {
 /** `reason` names which program rule refused a conflict, from the closed allow-list the consumer app understands;
  * a conflict the list does not cover stays a bare conflict. Never SQL text, identifiers or raw messages. */
 constructor(readonly category:'request_invalid'|'identity_refused'|'conflict'|'service_unavailable',readonly reason?:ProgramRefusalReason) {super(category);}
}
const CONSUMER_ONLY=new Set(['list','read','accept','complete','check_in','advance','pause','resume','withdraw']);
const WORKFORCE_ONLY=new Set(['assign','status','release','connections','programs','preview']);
type ProgramPhases=Extract<ProgramAssignmentResponse,{action:'read'}>['assignment']['phases'];
/**
 * Consumer purchase is not released, so a stored purchase destination never leaves on either projection that carries
 * phases: a consumer's read and a clinic's preview. The published artifact and its digest are unchanged; only the address
 * is replaced with null on the way out. The production adapter holds the same line behind its database boundary; this
 * is the adapter the isolated qualification program API serves, so it must not be the one that hands an address out.
 */
function withheldDestinations(answer:ProgramAssignmentResponse):ProgramAssignmentResponse{
 const withheld=(phases:ProgramPhases)=>phases.map(phase=>({...phase,items:phase.items.map(item=>item.product?{...item,product:{...item.product,purchaseUrl:null}}:item)}));
 if(answer.action==='read')return {...answer,assignment:{...answer.assignment,phases:withheld(answer.assignment.phases)}};
 if(answer.action==='preview')return {...answer,phases:withheld(answer.phases)};
 return answer;
}
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
   return withheldDestinations(parseProgramAssignmentResponse(request,typeof raw==='string'?JSON.parse(raw):raw));
  });}catch(error){
   if(error instanceof ClinicalCoreDatabaseRejection){
    const reason=error.category==='conflict'&&(PROGRAM_REFUSAL_REASONS as readonly string[]).includes(error.reason??'')?error.reason as ProgramRefusalReason:undefined;
    throw new ProgramAssignmentError(error.category==='conflict'?'conflict':error.category==='request_invalid'?'request_invalid':'identity_refused',reason);
   }
   throw new ProgramAssignmentError('service_unavailable');
  }
 };
}
