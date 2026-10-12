import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {ClinicalCoreDatabase} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {createFictionalProgramMediaStore} from './program-media-fictional';
import {createProgramMediaNativeRequestSource} from './program-media-native-request';
import type {AwsProgramMediaStoreConfiguration} from './aws-program-media-store';

const seam=vi.hoisted(()=>({open:vi.fn(),close:vi.fn()}));
vi.mock('./aws-program-media-store',()=>({createAwsProgramMediaStoreSource:seam.open}));
const id=(n:number)=>'73000000-0000-4000-8000-'+String(n).padStart(12,'0');
const context={actorPersonId:id(1),organizationId:id(2),identityPool:'workforce',identitySubject:'syn_media_request_actor',purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false} as ClinicalRequestContext;
const storage={purpose:'educational_media' as const,phiAllowed:false as const,dedicated:true as const,bucket:'alp-synthetic-lessons',expectedBucketOwner:'588966314750',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/'+id(9),maxImageBytes:1024,maxVideoBytes:2048,publicOrigin:'https://lessons.example.test/'};
const bytes=new TextEncoder().encode('Fictional native request bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
const request={operation:'prepare' as const,request:{commandId:id(5),programId:id(4),kind:'image' as const,contentType:'image/png' as const,bytes:bytes.length,sha256,fileName:'lesson.png'}};
const artifact={artifactId:id(3),clinic:id(2),programId:id(4),kind:'image',contentType:'image/png',bytes:bytes.length,sha256,objectKey:'program-media/'+id(2)+'/'+id(4)+'/'+id(3)+'/'+sha256+'.png',version:1,state:'reserved',objectVersion:null,committedAt:null,retiredAt:null,failure:null,caption:null,transcript:null};
function fixture(options:{enabled?:boolean;digest?:string;configDigest?:string;configStorage?:typeof storage;storeStorage?:typeof storage;scope?:{clinic:string;programId:string};allowed?:boolean;actor?:ClinicalRequestContext}={}){
 const operations:string[]=[];
 const database:ClinicalCoreDatabase={transaction:work=>work({query:async <T>(sql:string,parameters?:unknown[])=>{
  if(sql.includes('set_request_context'))return {rows:[]};
  const {operation,parameters:p}=JSON.parse(String(parameters?.[0]));operations.push(operation);
  let data:unknown;
  if(operation==='configuration')data={contractVersion:'program-media-native-ledger/1',evidenceSha256:options.configDigest??'a'.repeat(64),storage:options.configStorage??storage};
  else if(operation==='authorize')data=options.allowed??true;
  else if(operation==='reserve')data={...p.reservation,replayed:false};
  else if(operation==='artifact')data=artifact;
  else if(operation==='reservation')data={artifactId:artifact.artifactId,clinic:artifact.clinic,programId:artifact.programId,kind:artifact.kind,contentType:artifact.contentType,bytes:artifact.bytes,sha256:artifact.sha256,objectKey:artifact.objectKey,commandId:id(5),state:'reserved',acceptBefore:'2099-01-01T00:00:00Z',createdAt:'2026-10-11T00:00:00Z',replayed:false,failure:null};
  else if(operation==='beginWriter')data=true;
  else if(operation==='commit')data={...artifact,state:'ready',version:2,objectVersion:p.objectVersion,committedAt:new Date().toISOString()};
  else data=null;
  return {rows:[{data:{contractVersion:'program-media-native-ledger/1',ok:true,data}}] as T[]};
 }})};
 const resolveContext=vi.fn(async()=>({...options.actor??context}));
 const credentialsForProgram=vi.fn(async(scope:{clinic:string;programId:string})=>({storage:options.storeStorage??storage,scope:options.scope??scope,expectedRoleArn:'arn:aws:iam::588966314750:role/alp-educational-media-worker',credentials:{accessKeyId:'ASIA'+'A'.repeat(16),secretAccessKey:'x'.repeat(40),sessionToken:'fictional-session',expiration:new Date(Date.now()+3_600_000)},forbiddenBuckets:['alp-recording-store'],forbiddenKmsKeyArns:['arn:aws:kms:us-east-2:588966314750:key/'+id(8)]} satisfies AwsProgramMediaStoreConfiguration));
 const source=createProgramMediaNativeRequestSource({database,storage,resolveContext,credentialsForProgram,activation:options.enabled===undefined?undefined:{enabled:options.enabled,evidenceSha256:options.digest??'a'.repeat(64)}});
 return {source,operations,resolveContext,credentialsForProgram};
}
beforeEach(()=>{vi.clearAllMocks();seam.open.mockResolvedValue({store:createFictionalProgramMediaStore({kmsKeyArn:storage.kmsKeyArn}),close:seam.close});});
describe('closed per-request native media source over fictional transport',()=>{
 it('is off by default without any context, DB, secret or store observation',async()=>{
  const f=fixture();await expect(f.source.execute(request,new AbortController().signal)).rejects.toThrow('program_media_disabled');
  expect(f.operations).toEqual([]);expect(f.resolveContext).not.toHaveBeenCalled();expect(f.credentialsForProgram).not.toHaveBeenCalled();expect(seam.open).not.toHaveBeenCalled();
 });
 it.each([
  {context}, {storage}, {activation:{enabled:true}}, {identityPool:'workforce'},
 ])('rejects browser-supplied authority fields %j',async(extra)=>{
  const f=fixture({enabled:true});await expect(f.source.execute({...request,...extra},new AbortController().signal)).rejects.toThrow('request_invalid');expect(f.operations).toEqual([]);
 });
 it('requires current DB evidence and every reviewed store binding before credentials',async()=>{
  for(const options of [{configDigest:'b'.repeat(64)},{digest:'not-reviewed'},{configStorage:{...storage,bucket:'other-lessons'}},{configStorage:{...storage,maxImageBytes:512}}]){
   const f=fixture({enabled:true,...options});await expect(f.source.execute(request,new AbortController().signal)).rejects.toThrow('storage_unverified');expect(f.credentialsForProgram).not.toHaveBeenCalled();
  }
 });
 it('refuses current authority loss and never calls the store',async()=>{
  const f=fixture({enabled:true,allowed:false});await expect(f.source.execute(request,new AbortController().signal)).rejects.toThrow('access_refused');expect(f.credentialsForProgram).not.toHaveBeenCalled();
  const consumer=fixture({enabled:true,actor:{...context,identityPool:'consumer'}});await expect(consumer.source.execute(request,new AbortController().signal)).rejects.toThrow('access_refused');expect(consumer.operations).toEqual([]);
 });
 it.each([{clinic:id(6),programId:id(4)},{clinic:id(2),programId:id(6)}])('refuses wrong credential scope %j',async(scope)=>{
  const f=fixture({enabled:true,scope});await expect(f.source.execute(request,new AbortController().signal)).rejects.toThrow('storage_unverified');expect(seam.open).not.toHaveBeenCalled();
 });
 it('refuses a credentials store that differs from the reviewed one',async()=>{
  const f=fixture({enabled:true,storeStorage:{...storage,bucket:'other-lessons'}});await expect(f.source.execute(request,new AbortController().signal)).rejects.toThrow('storage_unverified');expect(seam.open).not.toHaveBeenCalled();
 });
 it('captures the command before awaiting authentication and closes one provider source',async()=>{
  const f=fixture({enabled:true}),mutable=structuredClone(request);
  f.resolveContext.mockImplementation(async()=>{mutable.request.programId=id(6);return {...context};});
  const result=await f.source.execute(mutable,new AbortController().signal);expect(result).toMatchObject({programId:id(4)});
  expect(f.credentialsForProgram.mock.calls[0][0]).toEqual({clinic:id(2),programId:id(4)});expect(seam.close).toHaveBeenCalledOnce();
 });
 it('keeps provider/context errors opaque and releases an opened source on failure',async()=>{
  const f=fixture({enabled:true});f.resolveContext.mockRejectedValueOnce(new Error('sensitive provider text'));
  await expect(f.source.execute(request,new AbortController().signal)).rejects.toThrow(/^service_unavailable$/);
  const opened=fixture({enabled:true});await expect(opened.source.execute({operation:'preview',request:{artifactId:id(3)}},new AbortController().signal)).rejects.toThrow();expect(seam.close).toHaveBeenCalledOnce();
 });
 it('captures Node Buffer upload bytes before asynchronous authentication',async()=>{
  const f=fixture({enabled:true}),mutable=Buffer.from(bytes);
  f.resolveContext.mockImplementation(async()=>{mutable.fill(0);return {...context};});
  const result=await f.source.execute({operation:'admit',request:{artifactId:id(3),sha256,bytes:bytes.length}},new AbortController().signal,mutable);
  expect(result).toMatchObject({state:'ready',sha256});expect(seam.close).toHaveBeenCalledOnce();
 });
 it('refuses cancellation before work and between context and credentials',async()=>{
  const f=fixture({enabled:true}),controller=new AbortController();controller.abort();await expect(f.source.execute(request,controller.signal)).rejects.toThrow('access_refused');expect(f.operations).toEqual([]);
  const next=fixture({enabled:true}),later=new AbortController();next.resolveContext.mockImplementation(async()=>{later.abort();return context;});await expect(next.source.execute(request,later.signal)).rejects.toThrow('access_refused');expect(next.operations).toEqual([]);
 });
 it('checks declared and actual byte bounds before copying or credential admission',async()=>{
  for(const [command,data] of [[{operation:'admit',request:{artifactId:id(3),sha256,bytes:2049}},new Uint8Array(2049)],[{operation:'admit',request:{artifactId:id(3),sha256,bytes:bytes.length+1}},bytes],[{...request,request:{...request.request,bytes:1025}},undefined]] as const){
   const f=fixture({enabled:true});await expect(f.source.execute(command,new AbortController().signal,data)).rejects.toThrow('request_invalid');expect(f.credentialsForProgram).not.toHaveBeenCalled();expect(f.operations).toEqual([]);
  }
 });
});
