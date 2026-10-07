import {z} from 'zod';
import {careDataEraseReceipt,careDataEraseScope,parseCareDataResponse} from './careDataLifecycle';

const uuid=z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const when=z.string().datetime({offset:true});
export const careErasureRecoveryRequest=z.discriminatedUnion('action',[
 z.object({action:z.literal('prepare_erasure'),requestId:uuid,scope:careDataEraseScope}).strict(),
 z.object({action:z.literal('discover_erasure_requests'),limit:z.number().int().min(1).max(100).optional(),after:uuid.optional()}).strict(),
]);
export type CareErasureRecoveryRequest=z.infer<typeof careErasureRecoveryRequest>;
const entry=z.object({requestId:uuid,scope:careDataEraseScope,outcome:z.enum(['prepared','erased','cancelled']),
 receipt:careDataEraseReceipt.nullable(),intentRegistered:z.boolean(),registeredAt:when.nullable(),completedAt:when.nullable()}).strict();
export const careErasureRecoveryResponse=z.discriminatedUnion('action',[
 z.object({action:z.literal('prepare_erasure'),requestId:uuid,scope:careDataEraseScope,
  outcome:z.enum(['prepared','erased','cancelled']),receipt:careDataEraseReceipt.nullable()}).strict(),
 z.object({action:z.literal('discover_erasure_requests'),items:z.array(entry).max(100),next:uuid.nullable(),
  legacyUncorrelatedErasureCount:z.number().int().min(0),
  coverage:z.literal('committed_owner_records_not_global_clearance')}).strict(),
]);
export type CareErasureRecoveryResponse=z.infer<typeof careErasureRecoveryResponse>;
export function parseCareErasureRecoveryResponse(input:CareErasureRecoveryRequest,value:unknown):CareErasureRecoveryResponse{
 const result=careErasureRecoveryResponse.parse(value);
 const mismatch=()=>{throw new Error('care_erasure_recovery_response_mismatch');};
 if(result.action!==input.action)mismatch();
 const receipt=(v:{scope:'domain'|'account_closure';outcome:string;receipt:z.infer<typeof careDataEraseReceipt>|null})=>{
 if((v.outcome==='erased')!==(v.receipt!==null))mismatch();
  if(v.receipt){
   parseCareDataResponse({action:'erase',scope:v.scope},v.receipt);
   const r=v.receipt;
   const pairs=[[r.settlementsRetained,r.retainedReason],[r.threadsRetained,r.threadsRetainedReason],
    [r.packetsRetained,r.packetsRetainedReason],[r.signaturesRetained,r.signaturesRetainedReason],
    [r.disputesRetained,r.disputesRetainedReason]] as const;
   if(pairs.some(([count,reason])=>(count>0)!==(reason!==null))
    ||(r.scope==='domain'&&[r.settlementsErased,r.packetsErased,r.signaturesErased,
      r.disputesErased,r.consultRequestsErased].some(count=>count!==0))
    ||(r.scope==='account_closure'&&[r.settlementsRetained,r.packetsRetained,
      r.signaturesRetained,r.disputesRetained].some(count=>count!==0)))mismatch();
  }
 };
 if(result.action==='prepare_erasure'&&input.action==='prepare_erasure'){
  if(result.requestId!==input.requestId||result.scope!==input.scope)mismatch();
  receipt(result);
 }
 if(result.action==='discover_erasure_requests'&&input.action==='discover_erasure_requests'){
  if(result.items.length>(input.limit??50))mismatch();
  let previous=input.after;
  for(const item of result.items){
   if(previous&&item.requestId<=previous)mismatch();previous=item.requestId;
   if(item.intentRegistered!==(item.registeredAt!==null)
    ||(item.outcome==='prepared')!==(item.completedAt===null)
    ||(item.outcome==='prepared'&&!item.intentRegistered))mismatch();
   receipt(item);
  }
  if(result.next&&(result.items.length!==(input.limit??50)||result.next!==previous))mismatch();
 }
 return result;
}
