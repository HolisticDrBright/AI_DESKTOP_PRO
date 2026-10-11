import {programAssignmentRequest,parseProgramAssignmentResponse,PROGRAM_REFUSAL_REASONS,type ProgramAssignmentRequest,type ProgramAssignmentResponse,type ProgramRefusalReason} from '../../contracts/programAssignments';
import {productionProgramActivation,DISABLED_PRODUCTION_PROGRAM_ACTIVATION,type ProductionProgramActivation} from '../../contracts/productionProgramActivation';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ClinicalRequestContext} from './aws-identity-consent';

/**
 * Production program assignment adapter: a SEPARATE, default-disabled family beside the synthetic
 * adapter (program-assignments.ts), which keeps its synthetic-only guard untouched.
 *
 * Nothing here is wired into the identity API; the consumer and workforce program routes still refuse
 * outside the synthetic boundary. This module exists so the production path can be reviewed and tested
 * as source before anyone decides to activate it. Activation needs, in order: evidence that parses the
 * activation contract and names the exact schema candidate this adapter was built against; a request
 * context bound to the production target; the consumer's current Core entitlement, verified against the
 * billing service for every consumer action; and the database's own activation row, which the API role
 * cannot write. A disabled adapter is not a production capability.
 */
/** SHA-256 of infra/aws-clinical-core/production-candidates/production-program-assignments.sql. A test holds this
 * equal to the file, so a changed candidate cannot be activated against evidence that reviewed another one. */
export const PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256='bb1c06a134069ab30fdf6b181e5a87d047310f4ef7c61b613129a6baa52213a1';
export class ProductionProgramAssignmentError extends Error {
 constructor(readonly category:'activation_refused'|'request_invalid'|'identity_refused'|'consent_refused'|'entitlement_refused'|'conflict'|'service_unavailable',readonly reason?:ProgramRefusalReason){super(category);}
}
const CONSUMER_ONLY=new Set(['list','read','accept','complete','check_in','advance','pause','resume','withdraw']);
const WORKFORCE_ONLY=new Set(['assign','status','release','connections','programs','preview']);
export type ProductionProgramAssignmentDependencies={
 database:ClinicalCoreDatabase;
 /** The operator's activation evidence. Absent or unparseable means disabled. */
 activation?:unknown;
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
 const activation=activationState(deps.activation);
 return async(context:ClinicalRequestContext,body:unknown,authorization:string):Promise<ProgramAssignmentResponse>=>{
  if(!activation.enabled)throw new ProductionProgramAssignmentError('activation_refused');
  // The production target only: a synthetic context is the wrong target for this family, as a production one is for the other.
  if(context.environment!=='production-clinical'||context.dataClassification!=='clinical_phi'||!('productionBound' in context)||context.productionBound!==true
   ||context.purpose!=='clinical_data')throw new ProductionProgramAssignmentError('identity_refused');
  const parsed=programAssignmentRequest.safeParse(body);
  if(!parsed.success)throw new ProductionProgramAssignmentError('request_invalid');
  const request:ProgramAssignmentRequest=parsed.data;
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
   const result=await tx.query<{data:unknown}>('select clinical_core.production_program_assignment_request($1::jsonb) as data',[JSON.stringify(request)]);
   const raw=result.rows[0]?.data;
   return parseProgramAssignmentResponse(request,typeof raw==='string'?JSON.parse(raw):raw);
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
