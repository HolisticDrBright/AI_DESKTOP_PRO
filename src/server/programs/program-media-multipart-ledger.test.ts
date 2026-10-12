import {describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {ClinicalCoreDatabase} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {createProgramMediaMultipartLedger,PROGRAM_MEDIA_MULTIPART_LEDGER_CONTRACT} from './program-media-multipart-ledger';
import {programMediaCompositeChecksum} from './program-media-parts';
const id=(n:number)=>'73000000-0000-4000-8000-'+String(n).padStart(12,'0');
const context={actorPersonId:id(1),organizationId:id(2),identityPool:'workforce',identitySubject:'syn_multipart_reader',
 purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false} as ClinicalRequestContext;
const storage={purpose:'educational_media' as const,phiAllowed:false as const,dedicated:true as const,bucket:'alp-synthetic-lessons',
 expectedBucketOwner:'588966314750',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/'+id(99),
 maxImageBytes:16777216,maxVideoBytes:268435456,publicOrigin:'https://lessons.example.test/'};
const digest=createHash('sha256').update('fictional bytes').digest('hex');
const manifest={totalBytes:4,parts:[{partNumber:1,bytes:4,sha256:digest}]};
const session={artifactId:id(3),clinic:context.organizationId,programId:id(4),actorId:context.actorPersonId,writerClaimId:id(5),
 kind:'video',contentType:'video/mp4',sha256:digest,totalBytes:4,objectKey:'program-media/'+context.organizationId+'/'+id(4)+'/'+id(3)+'/'+digest+'.mp4',
 acceptBefore:'2026-10-11T00:15:00Z',manifest,checksum:programMediaCompositeChecksum(manifest),uploadId:null,objectVersion:null,
 state:'prepared',parts:[],pending:[]};
function setup(result:unknown={session,admitted:false}){
 const query=vi.fn(async(sql:string,_parameters?:readonly unknown[])=>sql.includes('set_request_context')?{rows:[]}:
  {rows:[{data:{contractVersion:PROGRAM_MEDIA_MULTIPART_LEDGER_CONTRACT,ok:true,data:result}}]});
 const committed=vi.fn(),database:ClinicalCoreDatabase={transaction:async work=>{const answer=await work({query} as never);committed();return answer;}};
 return {query,committed,database,ledger:createProgramMediaMultipartLedger(database,{evidenceSha256:'a'.repeat(64),storage},{enabled:true,evidenceSha256:'b'.repeat(64)})};
}
describe('multipart source admission and transactional reply binding',()=>{
 it('accepts the WebM format already admitted by the governed media contract',async()=>{
  const s=setup({session:{...session,contentType:'video/webm',objectKey:session.objectKey.replace(/\.mp4$/,'.webm')},admitted:false});
  expect((await s.ledger.execute(context,{operation:'status',parameters:{artifactId:session.artifactId}})).session.contentType).toBe('video/webm');
  expect(s.committed).toHaveBeenCalledTimes(1);
 });
 it('refuses activation, PHI, consumer context and browser authority before database access',async()=>{
  const s=setup();
  await expect(createProgramMediaMultipartLedger(s.database).execute(context,{operation:'status',parameters:{artifactId:session.artifactId}})).rejects.toThrow('program_media_disabled');
  for(const c of [{...context,containsPhi:true},{...context,identityPool:'consumer'},{...context,environment:'production'}]){
   await expect(s.ledger.execute(c as ClinicalRequestContext,{operation:'status',parameters:{artifactId:session.artifactId}})).rejects.toThrow('access_refused');
  }
  for(const command of [{operation:'status',parameters:{artifactId:session.artifactId,owner:context.actorPersonId}},
   {operation:'status',parameters:{artifactId:session.artifactId},release:{approved:true}},
   {operation:'admitPart',parameters:{artifactId:session.artifactId,claimId:randomUUID(),partNumber:33}}]){
   await expect(s.ledger.execute(context,command)).rejects.toThrow('request_invalid');
  }
  expect(s.query).not.toHaveBeenCalled();
 });
 it.each([
  {actorId:id(8)},{clinic:id(8)},{artifactId:id(8)},{objectKey:'unrelated-key'},
  {checksum:digest},{totalBytes:2},{parts:[{partNumber:2,bytes:4,sha256:digest,checksum:Buffer.from(digest,'hex').toString('base64'),etag:'fictional'}]},
  {pending:[{claimId:id(7),kind:'part',partNumber:2,state:'open'}]},
 ])('refuses substituted or inconsistent session fields before commit: %j',async(change)=>{
  const s=setup({session:{...session,...change},admitted:false});
  await expect(s.ledger.execute(context,{operation:'status',parameters:{artifactId:session.artifactId}})).rejects.toThrow('service_unavailable');
  expect(s.committed).not.toHaveBeenCalled();
 });
 it('binds write acknowledgment to the actual admitted claim and exact provider receipt',async()=>{
  const claimId=id(6),s=setup({session:{...session,state:'creation_admitted',
   pending:[{claimId:id(8),kind:'creation',partNumber:null,state:'open'}]},admitted:true});
  await expect(s.ledger.execute(context,{operation:'admitCreation',parameters:{artifactId:session.artifactId,claimId}})).rejects.toThrow('service_unavailable');
  const wrong=setup({session:{...session,state:'uploading',uploadId:'other-upload'},admitted:false});
  await expect(wrong.ledger.execute(context,{operation:'recordUpload',parameters:{artifactId:session.artifactId,claimId,uploadId:'exact-upload'}})).rejects.toThrow('service_unavailable');
  expect(s.committed).not.toHaveBeenCalled();expect(wrong.committed).not.toHaveBeenCalled();
 });
 it.each([
  {operation:'admitCreation',state:'creation_admitted',kind:'completion',partNumber:null},
  {operation:'admitCreation',state:'creation_admitted',kind:'part',partNumber:1},
  {operation:'admitCreation',state:'uploading',kind:'creation',partNumber:null},
  {operation:'admitPart',state:'uploading',kind:'creation',partNumber:null},
  {operation:'admitPart',state:'prepared',kind:'part',partNumber:1},
  {operation:'admitCompletion',state:'completion_admitted',kind:'creation',partNumber:null},
 ])('refuses an admitted claim for a different operation or upload stage: %j',async({operation,state,kind,partNumber})=>{
  const claimId=id(6),s=setup({session:{...session,state,
   pending:[{claimId,kind,partNumber,state:'open'}]},admitted:true});
  await expect(s.ledger.execute(context,{operation,parameters:{artifactId:session.artifactId,claimId,
   ...(operation==='admitPart'?{partNumber:1}:{})}})).rejects.toThrow('service_unavailable');
  expect(s.committed).not.toHaveBeenCalled();
 });
 it('refuses a newly admitted start whose reply is not a new prepared upload',async()=>{
  const s=setup({session:{...session,state:'uploading',uploadId:'previous-upload'},admitted:true});
  await expect(s.ledger.execute(context,{operation:'start',parameters:{artifactId:session.artifactId,
   writerClaimId:session.writerClaimId,manifest}})).rejects.toThrow('service_unavailable');
  expect(s.committed).not.toHaveBeenCalled();
 });
 it('accepts correctly bound first admissions at each upload stage',async()=>{
  const claimId=id(6),part={partNumber:1,bytes:4,sha256:digest,checksum:Buffer.from(digest,'hex').toString('base64'),etag:'fictional-part'};
  for(const [operation,state,kind,uploadId,parts] of [
   ['admitCreation','creation_admitted','creation',null,[]],
   ['admitPart','uploading','part','fictional-upload',[]],
   ['admitCompletion','completion_admitted','completion','fictional-upload',[part]],
  ] as const){
   const s=setup({session:{...session,state,uploadId,parts,
    pending:[{claimId,kind,partNumber:kind==='part'?1:null,state:'open'}]},admitted:true});
   expect((await s.ledger.execute(context,{operation,parameters:{artifactId:session.artifactId,claimId,
    ...(operation==='admitPart'?{partNumber:1}:{})}})).admitted).toBe(true);
   expect(s.committed).toHaveBeenCalledTimes(1);
  }
  const s=setup({session,admitted:true});
  expect((await s.ledger.execute(context,{operation:'start',parameters:{artifactId:session.artifactId,
   writerClaimId:session.writerClaimId,manifest}})).admitted).toBe(true);
 });
 it('captures context, command and reviewed release before any asynchronous resolution',async()=>{
  const s=setup(),c={...context},input={operation:'status',parameters:{artifactId:session.artifactId}};
  const pending=s.ledger.execute(c,input);
  c.actorPersonId=id(8);input.parameters.artifactId=id(8);
  expect((await pending).session.artifactId).toBe(session.artifactId);
  expect(s.committed).toHaveBeenCalledTimes(1);
  const sent=JSON.parse(s.query.mock.calls[1][1]![0] as string);
  expect(sent.parameters.artifactId).toBe(session.artifactId);expect(sent.multipartEvidenceSha256).toBe('b'.repeat(64));
 });
});
