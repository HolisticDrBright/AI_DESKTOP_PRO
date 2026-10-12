import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {ProgramMediaError} from './program-media-authoring';
import {createProgramMediaControlHandler,PROGRAM_MEDIA_HTTP_CONTRACT} from './program-media-http';

const id=(n:number)=>`75000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const command={operation:'prepare',request:{commandId:id(1),programId:id(2),kind:'video',contentType:'video/mp4',bytes:268435456,sha256:'a'.repeat(64),fileName:'teaching.mp4'}};
const reservation={...command.request,artifactId:id(3),clinic:id(4),objectKey:`program-media/${id(4)}/${id(2)}/${id(3)}/${'a'.repeat(64)}.mp4`,state:'reserved',acceptBefore:'2099-01-01T00:00:00Z',createdAt:'2026-10-11T00:00:00Z',replayed:false,failure:null};
const reply=(()=>{const {fileName:_,...r}=reservation;return r;})();
function request(body:unknown=command,headers:Record<string,string|undefined>={},url='https://desktop.example.test/api/live/programs/media/control'){
 const supplied=Object.fromEntries(Object.entries(headers).filter(([,value])=>value!==undefined));
 return new Request(url,{method:'POST',headers:{host:'desktop.example.test',origin:'https://desktop.example.test','content-type':'application/json',...supplied},body:JSON.stringify(body)});
}
function fixture(options:{enabled?:boolean;timeoutMs?:number}={enabled:true}){
 const execute=vi.fn<(value:unknown,signal:AbortSignal)=>Promise<unknown>>(async()=>reply),sourceForRequest=vi.fn(async()=>({execute}));
 const handler=createProgramMediaControlHandler({sourceForRequest,...options});
 return {handler,execute,sourceForRequest};
}
async function expectFailure(response:Response,status:number,code:string){
 expect(response.status).toBe(status);expect(await response.json()).toEqual({contractVersion:PROGRAM_MEDIA_HTTP_CONTRACT,ok:false,error:{code}});
 expect(response.headers.get('cache-control')).toContain('no-store');
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('bounded educational-media control HTTP source',()=>{
 it('is default-off before authentication or any body read',async()=>{
  const f=fixture({});await expectFailure(await f.handler(request()),503,'program_media_disabled');expect(f.sourceForRequest).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
 });
 it('admits a 256 MiB video reservation as metadata, not a buffered video upload',async()=>{
  const f=fixture(),response=await f.handler(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({contractVersion:PROGRAM_MEDIA_HTTP_CONTRACT,ok:true,data:reply});
  expect(f.execute.mock.calls[0]).toHaveLength(2);expect(f.execute.mock.calls[0][0]).toEqual(command);expect(f.sourceForRequest).toHaveBeenCalledOnce();
 });
 it.each([
  {origin:'https://other.example.test'},{origin:'null'},{host:'wrong.example.test'},{'sec-fetch-site':'cross-site'},
  {origin:'https://desktop.example.test/path'},{origin:'http://desktop.example.test'},
 ])('refuses foreign browser admission before authentication %j',async(headers)=>{
  const f=fixture();await expectFailure(await f.handler(request(command,headers)),403,'access_refused');expect(f.sourceForRequest).not.toHaveBeenCalled();
 });
 it('does not trust forwarded host and rejects absent Origin',async()=>{
  const f=fixture();await expectFailure(await f.handler(request(command,{host:'other.example.test','x-forwarded-host':'desktop.example.test'})),403,'access_refused');
  const missing=request();missing.headers.delete('origin');await expectFailure(await f.handler(missing),403,'access_refused');expect(f.sourceForRequest).not.toHaveBeenCalled();
 });
 it.each(['?actor=other','?operation=retire','?'])('refuses query-bearing control URLs %s',async(suffix)=>{
  const f=fixture();await expectFailure(await f.handler(request(command,{},'https://desktop.example.test/api/live/programs/media/control'+suffix)),400,'request_invalid');expect(f.sourceForRequest).not.toHaveBeenCalled();
 });
 it('refuses other paths and methods without body processing',async()=>{
  const f=fixture();await expectFailure(await f.handler(request(command,{},'https://desktop.example.test/api/live/programs/media/retire')),404,'not_found');
  const r=new Request('https://desktop.example.test/api/live/programs/media/control',{method:'GET',headers:{host:'desktop.example.test',origin:'https://desktop.example.test'}});
  const out=await f.handler(r);await expectFailure(out,405,'request_invalid');expect(out.headers.get('allow')).toBe('POST');expect(f.sourceForRequest).not.toHaveBeenCalled();
 });
 it.each([{'content-type':'text/plain'},{'content-type':'application/json; charset=latin1'},{'content-encoding':'gzip'}])('refuses ambiguous body formats %j',async(headers)=>{
  const f=fixture();await expectFailure(await f.handler(request(command,headers)),415,'request_invalid');expect(f.sourceForRequest).not.toHaveBeenCalled();
 });
 it('authorizes through the trusted host before consuming a body and sanitizes denial text',async()=>{
  const f=fixture();f.sourceForRequest.mockRejectedValueOnce(new ProgramMediaError('access_refused'));
  await expectFailure(await f.handler(request()),403,'access_refused');expect(f.execute).not.toHaveBeenCalled();
  f.sourceForRequest.mockRejectedValueOnce(new Error('PRIVATE SESSION TOKEN'));await expectFailure(await f.handler(request()),503,'service_unavailable');
 });
 it.each([{...command,actorPersonId:id(9)},{...command,activation:{enabled:true}},{operation:'admit',request:{artifactId:id(3),bytes:1,sha256:'a'.repeat(64)}},{...command,request:{...command.request,bytes:268435457}}])('rejects authority fields, inline uploads and invalid metadata %j',async(value)=>{
  const f=fixture();await expectFailure(await f.handler(request(value)),400,'request_invalid');expect(f.execute).not.toHaveBeenCalled();
 });
 it.each(['0','-1','1.5','9007199254740992','1048577'])('bounds declared length before authentication %s',async(length)=>{
  const f=fixture();await expectFailure(await f.handler(request(command,{'content-length':length})),400,'request_invalid');expect(f.sourceForRequest).not.toHaveBeenCalled();
 });
 it('rejects invalid UTF8, malformed JSON, lying lengths and unknown-length overflow',async()=>{
  for(const r of [
   new Request(request(),{body:new Uint8Array([255,254])}),
   new Request(request(),{body:'{'}),request(command,{'content-length':'1'}),
   new Request(request(),{body:new Uint8Array(1048577)}),
  ]){const f=fixture();await expectFailure(await f.handler(r),400,'request_invalid');expect(f.execute).not.toHaveBeenCalled();}
 });
 it('retains supplied UTF8 text with an exact digest and rejects a wrong-artifact reply',async()=>{
  const f=fixture(),text='Fictional lesson: 食事 🌿';
  const body={operation:'attachText',request:{artifactId:id(3),expectedVersion:2,slot:'transcript',text,source:'supplied_by_author',format:'plain'}};
  const artifact={artifactId:id(3),clinic:id(4),programId:id(2),kind:'video',contentType:'video/mp4',bytes:reply.bytes,sha256:reply.sha256,objectKey:reply.objectKey,version:3,state:'ready',objectVersion:'v1',committedAt:'2026-10-11T00:00:00Z',retiredAt:null,failure:null,caption:null,transcript:{text,sha256:createHash('sha256').update(text).digest('hex'),source:'supplied_by_author',format:'plain'}};
  f.execute.mockResolvedValueOnce(artifact as never);const ok=await f.handler(request(body));expect(ok.status).toBe(200);expect((await ok.json()).data.transcript.text).toBe(text);
  f.execute.mockResolvedValueOnce({...artifact,artifactId:id(9)} as never);await expectFailure(await f.handler(request(body)),503,'service_unavailable');
 });
 it('never echoes provider fields, arbitrary errors or an invalid success shape',async()=>{
  for(const data of [{...reply,secret:'PRIVATE KEY'},{...reply,sha256:'b'.repeat(64)},null]){
   const f=fixture();f.execute.mockResolvedValueOnce(data as never);await expectFailure(await f.handler(request()),503,'service_unavailable');
  }
  const f=fixture();f.execute.mockRejectedValueOnce(new Error('PRIVATE RECORD'));await expectFailure(await f.handler(request()),503,'service_unavailable');
 });
 it('bounds authentication and execution even when a trusted callback ignores abort',async()=>{
  vi.useFakeTimers();for(const stage of ['host','execute']){
   const f=fixture({enabled:true,timeoutMs:100});
   if(stage==='host')f.sourceForRequest.mockImplementationOnce(()=>new Promise(()=>{}));else f.execute.mockImplementationOnce(()=>new Promise(()=>{}));
   const pending=f.handler(request());await vi.advanceTimersByTimeAsync(100);await expectFailure(await pending,503,'service_unavailable');
  }expect(vi.getTimerCount()).toBe(0);
 });
 it('cancels a stalled body without waiting for its cancel callback',async()=>{
  vi.useFakeTimers();const cancel=vi.fn(()=>new Promise<void>(()=>{}));
  const body=new ReadableStream<Uint8Array>({pull:()=>new Promise<void>(()=>{}),cancel},{highWaterMark:0});
  const r=new Request(request(),{body,duplex:'half'} as RequestInit),f=fixture({enabled:true,timeoutMs:100});
  const pending=f.handler(r);await vi.advanceTimersByTimeAsync(100);await expectFailure(await pending,503,'service_unavailable');expect(cancel).toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
 });
 it('refuses already-aborted requests and clears request listeners after success',async()=>{
  const c=new AbortController();c.abort();const f=fixture();await expectFailure(await f.handler(new Request(request(),{signal:c.signal})),403,'access_refused');expect(f.sourceForRequest).not.toHaveBeenCalled();
  const good=request(),remove=vi.spyOn(good.signal,'removeEventListener');await f.handler(good);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
 });
 it('validates publish, preview, retired-reference and cleanup replies by their own contracts',async()=>{
  const reference={contractVersion:'program-media-reference/1',artifactId:id(3),version:2,sha256:reply.sha256,kind:reply.kind,contentType:reply.contentType,bytes:reply.bytes,
   origin:{clinic:id(4),programId:id(2)},url:'https://lessons.example.test/'+reply.objectKey,publishedAt:'2026-10-11T00:00:00Z',caption:null,transcript:null};
  const cases=[
   {command:{operation:'publish',request:{artifactId:id(3),expectedVersion:2}},data:reference},
   {command:{operation:'preview',request:{artifactId:id(3)}},data:{artifactId:id(3),version:2,state:'ready',kind:'video',contentType:'video/mp4',bytes:reply.bytes,sha256:reply.sha256,
    previewToken:'fictional-preview-token',previewUntil:'2099-01-01T00:00:00Z',historical:false}},
   {command:{operation:'describeReference',request:reference},data:{reference,current:false,historical:true}},
   {command:{operation:'cleanupOrphans',request:{programId:id(2)}},data:{programId:id(2),checkedAt:'2026-10-11T00:00:00Z',actions:[],proofs:[]}},
  ];
  for(const c of cases){const f=fixture();f.execute.mockResolvedValueOnce(c.data);const r=await f.handler(request(c.command));expect(r.status).toBe(200);expect((await r.json()).data).toEqual(c.data);}
  const mismatch=fixture();mismatch.execute.mockResolvedValueOnce({...reference,version:3});await expectFailure(await mismatch.handler(request(cases[0].command)),503,'service_unavailable');
  const cleanup=fixture();cleanup.execute.mockResolvedValueOnce({...cases[3].data,programId:id(9)});await expectFailure(await cleanup.handler(request(cases[3].command)),503,'service_unavailable');
 });
 it('keeps all refusal categories closed, with no invented successful empty state',async()=>{
  for(const [code,status] of [['not_found',404],['conflict',409],['reservation_expired',409],['storage_unverified',503],['text_source_refused',422]] as const){
   const f=fixture();f.execute.mockRejectedValueOnce(new ProgramMediaError(code));await expectFailure(await f.handler(request()),status,code);
  }
 });
 it('captures the trusted resolver at construction rather than allowing mutable host replacement',async()=>{
  const execute=vi.fn(async()=>reply),original=vi.fn(async()=>({execute})),replacement=vi.fn(async()=>{throw new Error('OTHER ACCOUNT');});
  const input={enabled:true,sourceForRequest:original},handler=createProgramMediaControlHandler(input);input.sourceForRequest=replacement;
  expect((await handler(request())).status).toBe(200);expect(original).toHaveBeenCalledOnce();expect(replacement).not.toHaveBeenCalled();
 });
});
