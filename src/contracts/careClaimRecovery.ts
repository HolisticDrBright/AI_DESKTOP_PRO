import {z} from 'zod';
// PostgreSQL renders UUIDs in lowercase. Normalize before correlation, and
// reject nil/non-RFC request identities consistently in both boundaries.
const uuid=z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .transform(value=>value.toLowerCase());
const connection=z.object({connectionId:uuid,patientRecordId:uuid,state:z.literal('verified'),
  verifiedAt:z.string().datetime({offset:true}),version:z.number().int().min(1).max(999999999)}).strict();
export const careClaimRequest=z.discriminatedUnion('action',[
  z.object({action:z.literal('claim'),requestId:uuid,token:z.string().trim().max(24)
    .transform(value=>value.toUpperCase().replaceAll('-','')).pipe(z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$/))}).strict(),
  z.object({action:z.literal('receipt'),requestId:uuid}).strict(),
  z.object({action:z.literal('settle'),requestId:uuid}).strict(),
]);
export type CareClaimRequest=z.infer<typeof careClaimRequest>;
const response=z.discriminatedUnion('status',[
  z.object({requestId:uuid,status:z.literal('committed'),connection}).strict(),
  z.object({requestId:uuid,status:z.literal('cancelled')}).strict(),
  z.object({requestId:uuid,status:z.literal('unresolved')}).strict(),
  z.object({requestId:uuid,status:z.literal('withheld')}).strict(),
]);
export type CareClaimResponse=z.infer<typeof response>;
export function parseCareClaimResponse(request:CareClaimRequest,value:unknown):CareClaimResponse{
  const result=response.parse(value);
  if(result.requestId!==request.requestId||(request.action==='claim'&&!['committed','withheld'].includes(result.status))
    ||request.action==='settle'&&result.status==='unresolved')throw new Error('care_claim_response_invalid');
  return result;
}
