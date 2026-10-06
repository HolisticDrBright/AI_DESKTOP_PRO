import { z } from 'zod';
import { careMessage, careThread } from './careMessages';
const cursor = z.string().regex(/^[1-9][0-9]{0,17}$/);
export const careMessageExportRequest = z.object({ action: z.literal('export'),
  section: z.enum(['threads', 'messages', 'settlements']), before: cursor.optional() }).strict();
export type CareMessageExportRequest = z.infer<typeof careMessageExportRequest>;
const common = { contract: z.literal('care-message-export/1'), nextBefore: cursor.nullable(),
  coverage: z.literal('retained_in_app_messages_live_pages') };
export const careMessageExportResponse = z.discriminatedUnion('section', [
  z.object({ ...common, section: z.literal('threads'), records: z.array(careThread).max(30) }).strict(),
  z.object({ ...common, section: z.literal('messages'), records: z.array(careMessage.extend({ threadId: z.string().uuid() })).max(30) }).strict(),
  z.object({ ...common, section: z.literal('settlements'), records: z.array(z.object({ sequence: cursor, requestId: z.string().uuid(),
    connectionId: z.string().uuid(), status: z.literal('cancelled'), settledAt: z.string().datetime({ offset: true }) }).strict()).max(30) }).strict(),
]);
export type CareMessageExportResponse = z.infer<typeof careMessageExportResponse>;
export function parseCareMessageExportResponse(input: CareMessageExportRequest, value: unknown): CareMessageExportResponse {
  const result = careMessageExportResponse.parse(value);
  if (result.section !== input.section || Buffer.byteLength(JSON.stringify(result), 'utf8') > 262144
    || result.nextBefore !== null && result.nextBefore !== result.records.at(-1)?.sequence) throw new Error('message_export_response_mismatch');
  let before = BigInt(input.before ?? '9223372036854775807');
  for (const record of result.records) {
    const sequence = BigInt(record.sequence);
    if (sequence >= before) throw new Error('message_export_response_mismatch');
    before = sequence;
  }
  return result;
}
