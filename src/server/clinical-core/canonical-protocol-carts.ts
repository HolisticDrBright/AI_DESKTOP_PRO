import {z} from 'zod';
import {protocolCartRequest,parseProtocolCartResponse,type ProtocolCartResponse} from '../../contracts/protocolCarts';
import {clinicalUuid,type ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {ProtocolCartError} from './protocol-carts';

/** Source-only qualification port. The future handler must independently verify
 * the actual account/target, migration, artifact and designated fictional MFA
 * identities. This configuration is not observed activation evidence. There is
 * no route wired to it and the candidate SQL is outside every released ledger.
 * Canonical storage uses production-shaped identity/context; that is not PHI
 * permission. Production execution deliberately cannot be constructed here. */
const configuration=z.object({execution:z.literal('qualification'),account:z.literal('588966314750'),
 phiAllowed:z.literal(false)}).strict();
export function createCanonicalProtocolCartWorkforce(database:ClinicalCoreDatabase,rawConfiguration:unknown){
 if(!configuration.safeParse(rawConfiguration).success)throw new ProtocolCartError('identity_refused');
 return async(context:ProductionClinicalRequestContext,body:unknown):Promise<ProtocolCartResponse>=>{
  if(context.identityPool!=='workforce'||context.environment!=='production-clinical'||context.purpose!=='clinical_data'
   ||!context.productionBound)throw new ProtocolCartError('identity_refused');
  const parsed=protocolCartRequest.safeParse(body);
  if(!parsed.success)throw new ProtocolCartError('request_invalid');
  try{return await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
    clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,
    context.purpose,context.environment,context.dataClassification]);
   const raw=(await tx.query<{data:unknown}>('select clinical_core.canonical_protocol_cart_workforce($1::jsonb) as data',
    [JSON.stringify(parsed.data)])).rows[0]?.data;
   return parseProtocolCartResponse(parsed.data,typeof raw==='string'?JSON.parse(raw):raw);
  });}catch{throw new ProtocolCartError('operation_refused');}
 };
}
