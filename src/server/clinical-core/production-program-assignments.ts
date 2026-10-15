import {programAssignmentRequest,parseProgramAssignmentResponse,PROGRAM_REFUSAL_REASONS,type ProgramAssignmentRequest,type ProgramAssignmentResponse,type ProgramRefusalReason} from '../../contracts/programAssignments';
import {productionProgramActivation,DISABLED_PRODUCTION_PROGRAM_ACTIVATION,type ProductionProgramActivation} from '../../contracts/productionProgramActivation';
import {programBoundCompletionRequest,pinnedCompletionOf} from '../../contracts/programCompletion';
import {z} from 'zod';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';

/**
 * Production program assignment adapter: a SEPARATE, default-disabled family beside the synthetic
 * adapter (program-assignments.ts), which keeps its synthetic-only guard untouched.
 *
 * Nothing here is wired into the identity API; the consumer and workforce program routes still refuse
 * outside the synthetic boundary. This module exists so the production path can be reviewed and tested
 * as source before anyone decides to activate it. Activation needs, in order: evidence that parses the
 * activation contract and names the exact schema candidate this adapter was built against; the consumer
 * boundary's own evidence naming that candidate and the boundary candidate (the adapter reaches the database
 * only through the boundary's entry point, which withholds every purchase destination and binds completion to
 * the plan revision the person was shown); a request
 * context bound to the production target; the consumer's current Core entitlement, verified against the
 * billing service for every consumer action; and the database's own activation row, which the API role
 * cannot write. A disabled adapter is not a production capability.
 */
/** SHA-256 of infra/aws-clinical-core/production-candidates/production-program-assignments.sql. A test holds this
 * equal to the file, so a changed candidate cannot be activated against evidence that reviewed another one. */
export const PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256='78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3';
/** SHA-256 of infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql, the BLOCKED
 * successor that is the API role's only way into this family: it withholds every purchase destination from every
 * projection at the database, and decides `complete` against the plan revision the person was shown. */
export const PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256='ca0ce5a62e68638c7c29bd114018344c2755da946d1785f849e11088f8e1122d';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
/** The boundary's own reviewed evidence (program-consumer-boundary-activation/1). The family is never served without it:
 * the parent alone returns stored destinations and completes against a review the person did not see. */
export const productionProgramBoundaryActivation=z.discriminatedUnion('enabled',[
 z.object({contract:z.literal('program-consumer-boundary-activation/1'),enabled:z.literal(false)}).strict(),
 z.object({contract:z.literal('program-consumer-boundary-activation/1'),enabled:z.literal(true),target:z.literal('production-clinical'),
  programCandidateSha256:digest,boundaryCandidateSha256:digest,evidenceSha256:digest,
  reviewedBy:z.string().trim().min(1).max(200),reviewedAt:z.string().datetime({offset:true})}).strict(),
]);
export type ProductionProgramBoundaryActivation=z.infer<typeof productionProgramBoundaryActivation>;
export const DISABLED_PRODUCTION_PROGRAM_BOUNDARY_ACTIVATION:ProductionProgramBoundaryActivation=Object.freeze({contract:'program-consumer-boundary-activation/1',enabled:false});
export function boundaryActivationState(evidence:unknown):ProductionProgramBoundaryActivation{
 const parsed=productionProgramBoundaryActivation.safeParse(evidence??DISABLED_PRODUCTION_PROGRAM_BOUNDARY_ACTIVATION);
 if(!parsed.success)return DISABLED_PRODUCTION_PROGRAM_BOUNDARY_ACTIVATION;
 if(parsed.data.enabled&&(parsed.data.programCandidateSha256!==PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256
  ||parsed.data.boundaryCandidateSha256!==PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256))return DISABLED_PRODUCTION_PROGRAM_BOUNDARY_ACTIVATION;
 return parsed.data;
}
export class ProductionProgramAssignmentError extends Error {
 constructor(readonly category:'activation_refused'|'request_invalid'|'identity_refused'|'consent_refused'|'entitlement_refused'|'conflict'|'service_unavailable',readonly reason?:ProgramRefusalReason){super(category);}
}
type ProgramPhases=Extract<ProgramAssignmentResponse,{action:'read'}>['assignment']['phases'];
const CONSUMER_ONLY=new Set(['list','read','accept','complete','check_in','advance','pause','resume','withdraw']);
const WORKFORCE_ONLY=new Set(['assign','status','release','connections','programs','preview']);
export type ProductionProgramAssignmentDependencies={
 database:ClinicalCoreDatabase;
 /** The operator's activation evidence. Absent or unparseable means disabled. */
 activation?:unknown;
 /** The consumer boundary's own evidence. Absent, unparseable or naming another candidate means disabled. */
 boundaryActivation?:unknown;
 /** Verifies the consumer's current Core entitlement from the authorization the request carried; throws when it
  * cannot be verified as active now. Called for every consumer action, never for a workforce one. */
 verifyConsumerCore:(authorization:string)=>Promise<void>;
};
export function activationState(evidence:unknown):ProductionProgramActivation{
 const parsed=productionProgramActivation.safeParse(evidence??DISABLED_PRODUCTION_PROGRAM_ACTIVATION);
 if(!parsed.success)return DISABLED_PRODUCTION_PROGRAM_ACTIVATION;
 if(parsed.data.enabled&&parsed.data.schemaCandidateSha256!==PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256)return DISABLED_PRODUCTION_PROGRAM_ACTIVATION;
 return parsed.data;
}
export function createProductionProgramAssignments(deps:ProductionProgramAssignmentDependencies){
 const activation=activationState(deps.activation),boundary=boundaryActivationState(deps.boundaryActivation),execute=boundedProgramExecutor(deps);
 return async(context:ClinicalRequestContext,body:unknown,authorization:string):Promise<ProgramAssignmentResponse>=>{
  if(!activation.enabled||!boundary.enabled)throw new ProductionProgramAssignmentError('activation_refused');
  return execute(context,body,authorization);
 };
}
/**
 * The production-shaped program request through the consumer boundary, after activation was decided by the caller: the
 * production adapter above (behind its activation evidence) and the qualification adapter
 * (qualification-program-assignments.ts, behind qualification execution and designated fictional subjects) both run
 * exactly this, so the route and the database function agree on one context and one contract. It never decides activation.
 */
export function boundedProgramExecutor(deps:Pick<ProductionProgramAssignmentDependencies,'database'|'verifyConsumerCore'>){
 return async(context:ClinicalRequestContext,body:unknown,authorization:string):Promise<ProgramAssignmentResponse>=>{
  // The production target only: a synthetic context is the wrong target for this family, as a production one is for the other.
  if(context.environment!=='production-clinical'||context.dataClassification!=='clinical_phi'||!('productionBound' in context)||context.productionBound!==true
   ||context.purpose!=='clinical_data')throw new ProductionProgramAssignmentError('identity_refused');
  // A completion names the plan revision of the review the person was shown (program-bound-completion/1); the pinned
  // completion without one is refused here and again by the boundary. Every other action is the pinned request.
  const completing=typeof body==='object'&&body!==null&&(body as {action?:unknown}).action==='complete';
  const bound=completing?programBoundCompletionRequest.safeParse(body):null;
  const parsed=completing?null:programAssignmentRequest.safeParse(body);
  if(bound?bound.success!==true:parsed?.success!==true)throw new ProductionProgramAssignmentError('request_invalid');
  const sent:unknown=bound?.success?bound.data:parsed?.data;
  const request:ProgramAssignmentRequest=bound?.success?pinnedCompletionOf(bound.data):parsed!.data!;
  if(CONSUMER_ONLY.has(request.action)&&context.identityPool!=='consumer')throw new ProductionProgramAssignmentError('identity_refused');
  if(WORKFORCE_ONLY.has(request.action)&&context.identityPool!=='workforce')throw new ProductionProgramAssignmentError('identity_refused');
  if(context.identityPool==='consumer'){
   // Programs are a Core surface. The entitlement is checked now, against the billing service, for this request;
   // a cached or expired answer is not current access.
   try{await deps.verifyConsumerCore(authorization);}catch{throw new ProductionProgramAssignmentError('entitlement_refused');}
  }
  try{return await deps.database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
    {kind:'uuid',value:context.actorPersonId},{kind:'uuid',value:context.organizationId},context.identityPool,context.identitySubject,
    context.purpose,context.environment,context.dataClassification]);
   const result=await tx.query<{data:unknown}>('select clinical_core.production_program_bounded_request($1::jsonb) as data',[JSON.stringify(sent)]);
   const raw=result.rows[0]?.data;
   const answer=parseProgramAssignmentResponse(request,typeof raw==='string'?JSON.parse(raw):raw);
   // The boundary already withheld every destination; this is the second lock, on both projections that carry phases.
   // Consumer purchase is not released: the authored artifact and its digest stay intact, its destination never leaves.
   const withheld=(phases:ProgramPhases)=>phases.map(phase=>({...phase,items:phase.items.map(item=>item.product?{...item,product:{...item.product,purchaseUrl:null}}:item)}));
   if(answer.action==='read')return {...answer,assignment:{...answer.assignment,phases:withheld(answer.assignment.phases)}};
   if(answer.action==='preview')return {...answer,phases:withheld(answer.phases)};
   return answer;
  });}catch(error){
   if(error instanceof ClinicalCoreDatabaseRejection){
    const reason=error.category==='conflict'&&(PROGRAM_REFUSAL_REASONS as readonly string[]).includes(error.reason??'')?error.reason as ProgramRefusalReason:undefined;
    throw new ProductionProgramAssignmentError(error.category==='conflict'?'conflict':error.category==='request_invalid'?'request_invalid'
     :error.category==='consent_required'?'consent_refused':'identity_refused',reason);
   }
   throw new ProductionProgramAssignmentError('service_unavailable');
  }
 };
}
