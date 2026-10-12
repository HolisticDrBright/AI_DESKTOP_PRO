if(typeof window!=='undefined')throw new Error('program media parts is server-only');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {readBoundedRequestBody,BoundedBodyError} from '@/server/bounded-request-body';
import {ProgramMediaError} from './program-media-authoring';

import { PROGRAM_MEDIA_PART_BYTES, PROGRAM_MEDIA_MAX_VIDEO_BYTES, programMediaPartManifest } from '@/contracts/programMediaUpload';
export { PROGRAM_MEDIA_PART_BYTES, PROGRAM_MEDIA_MAX_VIDEO_BYTES, programMediaPartManifest } from '@/contracts/programMediaUpload';
export type { ProgramMediaPartManifest } from '@/contracts/programMediaUpload';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const total=z.number().int().safe().min(1).max(PROGRAM_MEDIA_MAX_VIDEO_BYTES);
const part=z.object({partNumber:z.number().int().min(1).max(32),bytes:z.number().int().min(1).max(PROGRAM_MEDIA_PART_BYTES),sha256:digest}).strict();
const admission=z.object({totalBytes:total,partNumber:part.shape.partNumber,sha256:digest}).strict()
 .refine(a=>a.partNumber<=Math.ceil(a.totalBytes/PROGRAM_MEDIA_PART_BYTES));

/** Exact ordered recipe. Non-final parts are 8 MiB (above S3's 5 MiB
 * minimum); the last may be smaller. This preserves the 256 MiB video ceiling,
 * not a substituted image-size maximum or an unbounded server allocation. */
export function programMediaCompositeChecksum(value:unknown):string{
 const manifest=programMediaPartManifest.parse(value);
 return createHash('sha256').update(Buffer.concat(manifest.parts.map(p=>Buffer.from(p.sha256,'hex')))).digest('base64')+'-'+manifest.parts.length;
}

/** Admission MUST come from current durable authority before this function is
 * called. This is only a bounded, integrity-checked body reader, not admission,
 * a native multipart ledger, provider write, or completed upload. Browser fields
 * must never substitute for the persisted immutable part recipe. The composite
 * checksum above is NOT the SHA256 of the whole file: readback/whole-object
 * verification is still required before the existing media commit contract. */
export async function readProgramMediaPart(request:Request,value:unknown,signal:AbortSignal,timeoutMs=10_000):Promise<Uint8Array>{
 const parsed=admission.safeParse(value);
 if(!parsed.success||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10_000)throw new ProgramMediaError('request_invalid');
 if(!(signal instanceof AbortSignal)||signal.aborted||request.signal.aborted)throw new ProgramMediaError('access_refused');
 const a=Object.freeze({...parsed.data}),expected=Math.min(PROGRAM_MEDIA_PART_BYTES,a.totalBytes-(a.partNumber-1)*PROGRAM_MEDIA_PART_BYTES);
 if(request.headers.get('content-type')!=='application/octet-stream'||request.headers.get('x-alp-part-sha256')!==a.sha256
  ||(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity'))throw new ProgramMediaError('request_invalid');
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==expected))throw new ProgramMediaError('request_invalid');
 try{
  const bytes=new Uint8Array(await readBoundedRequestBody({body:request.body,headers:request.headers,signal:AbortSignal.any([signal,request.signal])},expected,timeoutMs));
  if(signal.aborted||request.signal.aborted)throw new ProgramMediaError('access_refused');
  if(bytes.byteLength!==expected||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw new ProgramMediaError('request_invalid');
  return bytes;
 }catch(error){
  if(error instanceof ProgramMediaError)throw error;
  throw new ProgramMediaError(error instanceof BoundedBodyError&&error.reason==='interrupted'?'access_refused':'request_invalid');
 }
}
