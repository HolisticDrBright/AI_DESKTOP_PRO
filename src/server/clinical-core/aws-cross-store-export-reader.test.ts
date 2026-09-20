import {describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createAwsCrossStoreExportReader,CROSS_STORE_INLINE_DOCUMENT_BOUND} from './aws-cross-store-export-reader';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {voiceOwner} from './owned-voice-authorization';

// Fictional DynamoDB and S3 clients: these pin what the export reads, what it refuses to export and how documents are inlined.
const owner='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222',sub='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
const context:ProductionClinicalRequestContext={actorPersonId:owner,organizationId:org,identityPool:'consumer',identitySubject:sub,purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const job='55555555-5555-4555-8555-555555555555',job2='66666666-6666-4666-8666-666666666666';
const body=(bytes:Uint8Array)=>({transformToByteArray:async()=>bytes});
const pdf=Buffer.from('%PDF-1.4 FICTIONAL'),digest=createHash('sha256').update(pdf).digest('base64');
function labClients(rows:Record<string,Record<string,unknown>>,objects:Record<string,Uint8Array>){
  const db={send:vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    if(command.constructor.name==='QueryCommand')return {Items:Object.values(rows).map(r=>({inventoryOwner:(command.input.ExpressionAttributeValues as Record<string,string>)[':owner'],inventoryOrder:`${r.createdAt}#${String(r.pk).slice(4)}`,pk:r.pk}))};
    if(command.constructor.name==='GetCommand')return {Item:rows[String((command.input.Key as {pk:string}).pk)]};
    throw new Error('unexpected:'+command.constructor.name);
  })};
  const s3={send:vi.fn(async(command:{input:{Bucket:string;Key:string}})=>{const o=objects[command.input.Key];if(!o){const e=new Error('missing');e.name='NoSuchKey';throw e;}return {Body:body(o)};})};
  return {db,s3};
}
const labRow=(pk:string,patch:Record<string,unknown>={})=>({pk,ownerSub:sub,organizationId:org,personId:owner,createdAt:'2026-09-20T10:00:00.000Z',expiresAt:Math.floor(Date.now()/1000)+86400,state:'completed',progressPercent:100,
  result:{biomarkers:[{id:'b1',name:'Ferritin',value:30}],summary:'FICTIONAL'},documents:[{clientDocumentId:'77777777-7777-4777-8777-777777777777',fileName:'fictional.pdf',contentType:'application/pdf',byteSize:pdf.byteLength,checksumSHA256:digest,objectKey:'lab/'+pk+'/fictional.pdf'}],...patch});
describe('owner-authorized cross-store export reader',()=>{
  it('exports the owner\'s lab jobs with sanitized results and inlined, digest-checked documents, and skips rows of other owners',async()=>{
    const rows={['job#'+job]:labRow('job#'+job),['job#'+job2]:labRow('job#'+job2,{ownerSub:'someone-else-subject',personId:other})};
    const {db,s3}=labClients(rows,{['lab/job#'+job+'/fictional.pdf']:pdf});
    const reader=createAwsCrossStoreExportReader({labs:{table:'fictional-lab-jobs',bucket:'fictional-lab-documents'},region:'us-east-2'},{db:db as never,s3:s3 as never});
    expect(reader.configured('labs')).toBe(true);expect(reader.configured('voice')).toBe(false);
    const page=await reader.read(context,'labs',null,new AbortController().signal);
    // The inventory listing already drops rows that are not this owner's; nothing of the other owner reaches the export.
    expect(page.skipped).toBe(0);expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({kind:'lab_job',jobId:job,state:'completed',result:{summary:'FICTIONAL'},documents:[{clientDocumentId:'77777777-7777-4777-8777-777777777777',fileName:'fictional.pdf',contentType:'application/pdf',byteSize:pdf.byteLength,encoding:'base64',content:pdf.toString('base64')}]});
    // The stored object key, owner subject and other rows never leave the store.
    expect(JSON.stringify(page.items)).not.toMatch(/objectKey|ownerSub|someone-else/);
    await expect(reader.read(context,'voice',null,new AbortController().signal)).rejects.toThrow('cross_store_export_invalid');
  });
  it('lists a document without content when it is missing, altered or over the inline bound, naming the reason',async()=>{
    const altered=Buffer.from('%PDF-1.4 ALTERED');
    const rows={['job#'+job]:labRow('job#'+job,{documents:[
      {clientDocumentId:'a7777777-7777-4777-8777-777777777777',contentType:'application/pdf',byteSize:pdf.byteLength,checksumSHA256:digest,objectKey:'missing.pdf'},
      {clientDocumentId:'b7777777-7777-4777-8777-777777777777',contentType:'application/pdf',byteSize:altered.byteLength,checksumSHA256:digest,objectKey:'altered.pdf'},
      {clientDocumentId:'c7777777-7777-4777-8777-777777777777',contentType:'application/pdf',byteSize:CROSS_STORE_INLINE_DOCUMENT_BOUND+1,checksumSHA256:digest,objectKey:'huge.pdf'},
      {clientDocumentId:'d7777777-7777-4777-8777-777777777777',contentType:'application/pdf',byteSize:pdf.byteLength,checksumSHA256:digest}]})};
    const {db,s3}=labClients(rows,{'altered.pdf':altered,'huge.pdf':pdf});
    const reader=createAwsCrossStoreExportReader({labs:{table:'fictional-lab-jobs',bucket:'fictional-lab-documents'},region:'us-east-2'},{db:db as never,s3:s3 as never});
    const page=await reader.read(context,'labs',null,new AbortController().signal);
    expect((page.items[0].documents as {omitted?:string;content:unknown}[]).map(d=>[d.omitted,d.content])).toEqual([['object_missing',null],['digest_mismatch',null],['exceeds_inline_bound',null],['object_key_missing',null]]);
    expect(s3.send).toHaveBeenCalledTimes(2); // the oversized and keyless documents are never fetched
  });
  it('exports the owner\'s voice jobs with transcripts read from the output object, states why one is absent, and pages by scan key',async()=>{
    const authorization={version:'owned-voice/1',personId:owner,organizationId:org,identitySubject:sub};
    const ready={id:'a'.repeat(64),owner:voiceOwner({actorPersonId:owner,organizationId:org,identitySubject:sub}),inputHash:'b'.repeat(64),format:'wav',state:'ready',cancelled:false,createdAt:1_758_000_000,readableUntil:0,consentVersion:'v',consentAcceptedAt:0,nextWork:0,authorization};
    const foreignAuthorization={...authorization,personId:other,identitySubject:'x-'.repeat(8)};
    const queued={...ready,id:'c'.repeat(64),state:'queued'},foreign={...ready,id:'d'.repeat(64),owner:voiceOwner({actorPersonId:other,organizationId:org,identitySubject:'x-'.repeat(8)}),authorization:foreignAuthorization};
    let scans=0;
    const db={send:vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
      if(command.constructor.name!=='ScanCommand')throw new Error('unexpected');
      scans++;return scans===1?{Items:[ready,queued],LastEvaluatedKey:{id:queued.id}}:{Items:[foreign]};
    })};
    const s3={send:vi.fn(async(command:{input:{Key:string}})=>{
      if(command.input.Key==='personal-voice/output/'+ready.id+'.json')return {Body:body(Buffer.from(JSON.stringify({results:{transcripts:[{transcript:'FICTIONAL TRANSCRIPT'}]}})))};
      const e=new Error('missing');e.name='NoSuchKey';throw e;
    })};
    const reader=createAwsCrossStoreExportReader({voice:{table:'fictional-voice-jobs',bucket:'fictional-transcription'},region:'us-east-2'},{db:db as never,s3:s3 as never});
    const first=await reader.read(context,'voice',null,new AbortController().signal);
    expect(first.items).toEqual([{kind:'voice_job',jobId:ready.id,state:'ready',format:'wav',createdAt:'2025-09-16T05:20:00.000Z',transcript:'FICTIONAL TRANSCRIPT'},
      {kind:'voice_job',jobId:queued.id,state:'queued',format:'wav',createdAt:'2025-09-16T05:20:00.000Z',transcript:null,omitted:'not_ready'}]);
    expect(first.nextCursor).toBeTruthy();
    const second=await reader.read(context,'voice',first.nextCursor,new AbortController().signal);
    expect(second).toEqual({items:[],nextCursor:null,skipped:1});
    expect((db.send.mock.calls[1][0] as {input:{ExclusiveStartKey:unknown}}).input.ExclusiveStartKey).toEqual({id:queued.id});
    await expect(reader.read(context,'voice','not base64url!',new AbortController().signal)).rejects.toThrow('cross_store_export_invalid');
  });
  it('refuses malformed store configuration before any client is created',()=>{
    expect(()=>createAwsCrossStoreExportReader({labs:{table:'x',bucket:'Bad Bucket'},region:'us-east-2'})).toThrow('cross_store_export_invalid');
    expect(()=>createAwsCrossStoreExportReader({voice:{table:'fictional',bucket:'fictional-bucket'},region:'nowhere'})).toThrow('cross_store_export_invalid');
    expect(createAwsCrossStoreExportReader({region:'us-east-2'}).configured('labs')).toBe(false);
  });
});
