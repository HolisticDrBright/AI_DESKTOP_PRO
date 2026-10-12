import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readProgramMediaPart,programMediaPartManifest,PROGRAM_MEDIA_PART_BYTES,programMediaCompositeChecksum} from './program-media-parts';

const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bytes=new TextEncoder().encode('fictional final teaching-video part');
const admission={totalBytes:bytes.length,partNumber:1,sha256:hash(bytes)};
function request(body:BodyInit=bytes,headers:Record<string,string|undefined>={}){
 const supplied=Object.fromEntries(Object.entries(headers).filter(([,value])=>value!==undefined));
 return new Request('https://desktop.example.test/media/part',{method:'POST',headers:{'content-type':'application/octet-stream','x-alp-part-sha256':admission.sha256,...supplied},body});
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('bounded multipart input and checksum recipes',()=>{
 it('reads the exact admitted last-part bytes without requiring ContentLength',async()=>{
  const result=await readProgramMediaPart(request(),admission,new AbortController().signal);expect(result).toEqual(bytes);
 });
 it.each([{totalBytes:0},{totalBytes:268435457},{partNumber:0},{partNumber:2},{partNumber:33},{sha256:'bad'},{uploadId:'browser authority'}])('rejects malformed admission before body reads %j',async(extra)=>{
  await expect(readProgramMediaPart(request(),{...admission,...extra},new AbortController().signal)).rejects.toThrow('request_invalid');
 });
 it.each([{'content-type':'video/mp4'},{'content-encoding':'gzip'},{'x-alp-part-sha256':'b'.repeat(64)},{'content-length':'-1'},{'content-length':'1'}])('refuses mismatched wire metadata %j',async(headers)=>{
  await expect(readProgramMediaPart(request(bytes,headers),admission,new AbortController().signal)).rejects.toThrow('request_invalid');
 });
 it('refuses missing digest, changed bytes, truncated and oversized actual bytes',async()=>{
  const missing=request();missing.headers.delete('x-alp-part-sha256');await expect(readProgramMediaPart(missing,admission,new AbortController().signal)).rejects.toThrow('request_invalid');
  for(const body of [new Uint8Array(bytes.length),bytes.subarray(0,bytes.length-1),new Uint8Array(bytes.length+1)])await expect(readProgramMediaPart(request(body),admission,new AbortController().signal)).rejects.toThrow('request_invalid');
 });
 it('supports the full declared 256 MiB ceiling as 32 bounded 8 MiB parts',()=>{
  const parts=Array.from({length:32},(_,i)=>({partNumber:i+1,bytes:PROGRAM_MEDIA_PART_BYTES,sha256:'a'.repeat(64)}));
  expect(programMediaPartManifest.parse({totalBytes:268435456,parts})).toEqual({totalBytes:268435456,parts});
 });
 it('reads a full non-final 8 MiB part, not the entire larger video',async()=>{
  const part=new Uint8Array(PROGRAM_MEDIA_PART_BYTES),sha256=hash(part);
  const result=await readProgramMediaPart(request(part,{'x-alp-part-sha256':sha256}),{totalBytes:268435456,partNumber:1,sha256},new AbortController().signal);expect(result.byteLength).toBe(PROGRAM_MEDIA_PART_BYTES);
 });
 it.each([
  {parts:[{partNumber:2,bytes:1,sha256:'a'.repeat(64)}]},
  {parts:[{partNumber:1,bytes:1,sha256:'a'.repeat(64)},{partNumber:1,bytes:1,sha256:'b'.repeat(64)}]},
  {parts:[]},{parts:[{partNumber:1,bytes:0,sha256:'a'.repeat(64)}]},
 ])('refuses incomplete, out-of-order or duplicate manifest parts %j',({parts})=>{
  expect(programMediaPartManifest.safeParse({totalBytes:1,parts}).success).toBe(false);
 });
 it('computes the exact S3 composite shape, never mislabels it as whole-file SHA256',()=>{
  const a=Buffer.from('a'.repeat(64),'hex'),b=Buffer.from('b'.repeat(64),'hex');
  const manifest={totalBytes:PROGRAM_MEDIA_PART_BYTES+1,parts:[{partNumber:1,bytes:PROGRAM_MEDIA_PART_BYTES,sha256:a.toString('hex')},{partNumber:2,bytes:1,sha256:b.toString('hex')}]};
  expect(programMediaCompositeChecksum(manifest)).toBe(createHash('sha256').update(Buffer.concat([a,b])).digest('base64')+'-2');
  expect(()=>programMediaCompositeChecksum({...manifest,parts:[...manifest.parts].reverse()})).toThrow();
 });
 it('honors body deadline and abort without forwarding partial bytes',async()=>{
  vi.useFakeTimers();const cancel=vi.fn(()=>new Promise<void>(()=>{}));
  const body=new ReadableStream<Uint8Array>({pull:()=>new Promise<void>(()=>{}),cancel},{highWaterMark:0});
  const r=new Request(request(),{body,duplex:'half'} as RequestInit);
  const pending=expect(readProgramMediaPart(r,admission,new AbortController().signal,100)).rejects.toThrow('access_refused');await vi.advanceTimersByTimeAsync(100);await pending;expect(cancel).toHaveBeenCalled();
  const c=new AbortController();c.abort();await expect(readProgramMediaPart(request(),admission,c.signal)).rejects.toThrow('access_refused');
 });
});
