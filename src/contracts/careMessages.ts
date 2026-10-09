import { z } from 'zod';
export const MESSAGE_ACK = 'care-messages/1' as const;
const cursor = z.string().regex(/^[1-9][0-9]{0,17}$/);
export const careMessageRequest = z.discriminatedUnion('action', [
  z.object({action:z.literal('list'),before:cursor.optional()}).strict(),
  z.object({action:z.literal('read'),threadId:z.string().uuid(),before:cursor.optional()}).strict(),
  z.object({action:z.literal('receipt'),requestId:z.string().uuid(),connectionId:z.string().uuid()}).strict(),
  // Settling is a decision, not a lookup: it either reports the delivery that
  // happened or makes the request permanently inadmissible.
  z.object({action:z.literal('settle'),requestId:z.string().uuid(),connectionId:z.string().uuid()}).strict(),
  z.object({action:z.literal('send'),requestId:z.string().uuid(),connectionId:z.string().uuid(),
    threadId:z.string().uuid().optional(),subject:z.string().trim().min(1).max(120).optional(),
    body:z.string().trim().min(1).max(4000),acknowledgement:z.literal(MESSAGE_ACK)}).strict(),
]);
export type CareMessageRequest=z.infer<typeof careMessageRequest>;
export const careThread=z.object({threadId:z.string().uuid(),connectionId:z.string().uuid(),patientRecordId:z.string().uuid(),
  sequence:cursor,subject:z.string().min(1).max(120),createdAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true})}).strict();
export const careMessage=z.object({messageId:z.string().uuid(),sequence:cursor,body:z.string().max(4000),
  sender:z.enum(['consumer','workforce']),createdAt:z.string().datetime({offset:true})}).strict();
export const careMessageResponse=z.union([
 z.object({action:z.literal('list'),threads:z.array(careThread).max(30),nextBefore:cursor.nullable()}).strict(),
 z.object({action:z.literal('read'),thread:careThread,messages:z.array(careMessage).max(50),nextBefore:cursor.nullable()}).strict(),
 z.object({action:z.literal('send'),threadId:z.string().uuid(),messageId:z.string().uuid(),duplicate:z.boolean(),
   status:z.literal('stored'),receivedAt:z.string().datetime({offset:true})}).strict(),
 z.object({action:z.literal('receipt'),requestId:z.string().uuid(),connectionId:z.string().uuid(),status:z.literal('committed'),threadId:z.string().uuid(),messageId:z.string().uuid()}).strict(),
 z.object({action:z.literal('receipt'),requestId:z.string().uuid(),connectionId:z.string().uuid(),status:z.literal('unresolved')}).strict(),
 z.object({action:z.literal('receipt'),requestId:z.string().uuid(),connectionId:z.string().uuid(),status:z.literal('cancelled')}).strict(),
 z.object({action:z.literal('settle'),requestId:z.string().uuid(),connectionId:z.string().uuid(),status:z.literal('committed'),threadId:z.string().uuid(),messageId:z.string().uuid()}).strict(),
 z.object({action:z.literal('settle'),requestId:z.string().uuid(),connectionId:z.string().uuid(),status:z.literal('cancelled')}).strict(),
 // Delivered, but through a link the owner can no longer read. Stating that is
 // honest; naming the thread would disclose an inaccessible clinic's record.
 z.object({action:z.literal('settle'),requestId:z.string().uuid(),connectionId:z.string().uuid(),status:z.literal('withheld')}).strict(),
]);
export type CareMessageResponse=z.infer<typeof careMessageResponse>;
export function parseCareMessageResponse(input:CareMessageRequest,value:unknown):CareMessageResponse{
 const result=careMessageResponse.parse(value);
 if(result.action!==input.action
  ||(input.action==='read'&&result.action==='read'&&result.thread.threadId!==input.threadId)
  ||(input.action==='receipt'&&result.action==='receipt'&&(result.requestId!==input.requestId||result.connectionId!==input.connectionId))
  ||(input.action==='settle'&&result.action==='settle'&&(result.requestId!==input.requestId||result.connectionId!==input.connectionId))
  ||(input.action==='send'&&input.threadId&&result.action==='send'&&result.threadId!==input.threadId))
  throw new Error('message_response_mismatch');
 return result;
}
