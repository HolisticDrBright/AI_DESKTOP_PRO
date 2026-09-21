import {describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createAwsCrossStoreExportReader,readBoundedObject,CROSS_STORE_INLINE_DOCUMENT_BOUND,CROSS_STORE_TRANSCRIPT_BOUND} from './aws-cross-store-export-reader';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {voiceOwner} from './owned-voice-authorization';

// Fictional DynamoDB and S3 clients with streamed bodies: these pin what the export reads, what it refuses to export,
// how bytes are bounded by what is actually received, and how a page resumes inside a listing.
const owner='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222',sub='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
const context:ProductionClinicalRequestContext={actorPersonId:owner,organizationId:org,identityPool:'consumer',identitySubject:sub,purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const job=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const doc=(n:string)=>`${n}7777777-7777-4777-8777-777777777777`;
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('base64');
const pdf=Buffer.from('%PDF-1.4 FICTIONAL');
/** A body that records whether it was destroyed and how many chunks were handed out. */
function stream(bytes:Uint8Array,chunk=64*1024,onServe?:(served:number)=>void){
  const parts:Uint8Array[]=[];for(let i=0;i<bytes.byteLength;i+=chunk)parts.push(bytes.subarray(i,Math.min(i+chunk,bytes.byteLength)));
  const state={destroyed:false,served:0};
  const body=new Readable({read(){const next=parts.shift();if(next){state.served++;onServe?.(state.served);this.push(Buffer.from(next));}else this.push(null);}});
  const original=body.destroy.bind(body);body.destroy=((e?:Error)=>{state.destroyed=true;return original(e);}) as typeof body.destroy;
  return {body,state};
}
type Obj={bytes:Uint8Array;contentLength?:number|null;serve?:Uint8Array};
function clients(rows:Record<string,Record<string,unknown>>,objects:Record<string,Obj>,voiceRows:Record<string,unknown>[]=[],voiceObjects:Record<string,Obj>={}){
  const streams:Record<string,ReturnType<typeof stream>['state']>={};
  let scans=0;
  const db={send:vi.fn(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
    const name=command.constructor.name;
    if(name==='QueryCommand')return {Items:Object.values(rows).map(r=>({inventoryOwner:(command.input.ExpressionAttributeValues as Record<string,string>)[':owner'],inventoryOrder:`${r.createdAt}#${String(r.pk).slice(4)}`,pk:r.pk}))};
    if(name==='GetCommand')return {Item:rows[String((command.input.Key as {pk:string}).pk)]};
    if(name==='ScanCommand'){scans++;const after=command.input.ExclusiveStartKey as {id:string}|undefined;const start=after?voiceRows.findIndex(r=>r.id===after.id)+1:0;const page=voiceRows.slice(start,start+25);
      return {Items:page,...(start+25<voiceRows.length?{LastEvaluatedKey:{id:page.at(-1)!.id}}:{})};}
    throw new Error('unexpected:'+name);
  })};
  const s3={send:vi.fn(async(command:{input:{Bucket:string;Key:string}})=>{
    const o=objects[command.input.Key]??voiceObjects[command.input.Key];
    if(!o){const e=new Error('missing');e.name='NoSuchKey';throw e;}
    const s=stream(o.serve??o.bytes);streams[command.input.Key]=s.state;
    return {Body:s.body,...(o.contentLength===null?{}:{ContentLength:o.contentLength??(o.serve??o.bytes).byteLength})};
  })};
  return {db,s3,streams,scanCount:()=>scans};
}
const labRow=(pk:string,documents:Record<string,unknown>[],patch:Record<string,unknown>={})=>({pk,ownerSub:sub,organizationId:org,personId:owner,createdAt:'2026-09-20T10:00:00.000Z',expiresAt:Math.floor(Date.now()/1000)+86400,state:'completed',progressPercent:100,
  result:{biomarkers:[{id:'b1',name:'Ferritin',value:30}],summary:'FICTIONAL'},documents,...patch});
const document=(id:string,bytes:Uint8Array,key:string,patch:Record<string,unknown>={})=>({clientDocumentId:id,fileName:'fictional.pdf',contentType:'application/pdf',byteSize:bytes.byteLength,checksumSHA256:digest(bytes),objectKey:key,...patch});
const reader=(c:ReturnType<typeof clients>,extra:Record<string,unknown>={})=>createAwsCrossStoreExportReader({labs:{table:'fictional-lab-jobs',bucket:'fictional-lab-documents'},voice:{table:'fictional-voice-jobs',bucket:'fictional-transcription'},region:'us-east-2',...extra} as never,{db:c.db as never,s3:c.s3 as never});
const signal=()=>new AbortController().signal;
describe('bounded object reads',()=>{
  it('reads exactly up to the limit, and refuses anything longer than declared, longer than the limit, or shorter than declared, destroying the stream',async()=>{
    const exact=Buffer.alloc(CROSS_STORE_INLINE_DOCUMENT_BOUND,7);
    const ok=stream(exact);
    const read=await readBoundedObject({Body:ok.body,ContentLength:exact.byteLength},{limit:CROSS_STORE_INLINE_DOCUMENT_BOUND,expected:exact.byteLength,signal:signal()});
    expect('bytes' in read&&Buffer.from(read.bytes).equals(exact)).toBe(true);expect(ok.state.served).toBe(CROSS_STORE_INLINE_DOCUMENT_BOUND/(64*1024));
    // Declared as one byte, ContentLength says 6 MiB + 1: refused before any byte is read.
    const big=stream(Buffer.alloc(CROSS_STORE_INLINE_DOCUMENT_BOUND+1,1));
    expect(await readBoundedObject({Body:big.body,ContentLength:CROSS_STORE_INLINE_DOCUMENT_BOUND+1},{limit:CROSS_STORE_INLINE_DOCUMENT_BOUND,expected:1,signal:signal()})).toEqual({omitted:'exceeds_inline_bound'});
    expect(big.state.destroyed).toBe(true);expect(big.state.served).toBe(0);
    // No ContentLength and a stream longer than declared: stopped at the declaration, not at the end of the object.
    const over=stream(Buffer.alloc(3*1024*1024,2));
    expect(await readBoundedObject({Body:over.body},{limit:CROSS_STORE_INLINE_DOCUMENT_BOUND,expected:1024,signal:signal()})).toEqual({omitted:'length_mismatch'});
    expect(over.state.destroyed).toBe(true);expect(over.state.served).toBeLessThanOrEqual(2);
    // No ContentLength, no declaration, stream over the limit: stopped at the limit.
    const huge=stream(Buffer.alloc(CROSS_STORE_INLINE_DOCUMENT_BOUND+64*1024,3));
    expect(await readBoundedObject({Body:huge.body},{limit:CROSS_STORE_INLINE_DOCUMENT_BOUND,expected:null,signal:signal()})).toEqual({omitted:'exceeds_inline_bound'});
    expect(huge.state.destroyed).toBe(true);expect(huge.state.served).toBeLessThanOrEqual(CROSS_STORE_INLINE_DOCUMENT_BOUND/(64*1024)+1);
    // ContentLength disagrees with the declaration, or the bytes fall short of it.
    expect(await readBoundedObject({Body:stream(pdf).body,ContentLength:pdf.byteLength+1},{limit:1024,expected:pdf.byteLength,signal:signal()})).toEqual({omitted:'length_mismatch'});
    expect(await readBoundedObject({Body:stream(pdf).body},{limit:1024,expected:pdf.byteLength+5,signal:signal()})).toEqual({omitted:'length_mismatch'});
    expect(await readBoundedObject({Body:stream(pdf).body,ContentLength:-1},{limit:1024,expected:null,signal:signal()})).toEqual({omitted:'length_mismatch'});
    expect(await readBoundedObject({Body:{transformToByteArray:async()=>pdf}},{limit:1024,expected:null,signal:signal()})).toEqual({omitted:'body_unreadable'});
  });
  it('stops and destroys the stream when the caller aborts mid-read',async()=>{
    const controller=new AbortController();
    const s=stream(Buffer.alloc(1024*1024,4),1024,served=>{if(served===3)controller.abort();});
    await expect(readBoundedObject({Body:s.body},{limit:CROSS_STORE_INLINE_DOCUMENT_BOUND,expected:null,signal:controller.signal})).rejects.toThrow('cross_store_export_aborted');
    expect(s.state.destroyed).toBe(true);expect(s.state.served).toBeLessThan(1024);
    const pre=new AbortController();pre.abort();
    await expect(readBoundedObject({Body:stream(pdf).body},{limit:1024,expected:null,signal:pre.signal})).rejects.toThrow('cross_store_export_aborted');
  });
});
describe('owner-authorized cross-store export reader',()=>{
  it('exports the owner\'s lab jobs as a job item followed by digest-checked document items with read times, and never rows of other owners',async()=>{
    const rows={['job#'+job('5')]:labRow('job#'+job('5'),[document(doc('a'),pdf,'a.pdf')]),['job#'+job('6')]:labRow('job#'+job('6'),[],{ownerSub:'someone-else-subject',personId:other})};
    const c=clients(rows,{'a.pdf':{bytes:pdf}});
    const page=await reader(c).read(context,'labs',null,signal());
    expect(page.nextCursor).toBeNull();expect(page.skipped).toBe(0);
    expect(page.items).toEqual([
      expect.objectContaining({kind:'lab_job',jobId:job('5'),state:'completed',result:{biomarkers:[{id:'b1',name:'Ferritin',value:30}],summary:'FICTIONAL'},documentCount:1}),
      expect.objectContaining({kind:'lab_document',jobId:job('5'),clientDocumentId:doc('a'),fileName:'fictional.pdf',byteSize:pdf.byteLength,encoding:'base64',content:pdf.toString('base64')})]);
    for(const item of page.items)expect(Date.parse(String(item.readAt))).toBeGreaterThan(0);
    expect(JSON.stringify(page.items)).not.toMatch(/objectKey|ownerSub|someone-else/);
    await expect(createAwsCrossStoreExportReader({labs:{table:'fictional-lab-jobs',bucket:'fictional-lab-documents'},region:'us-east-2'},{db:c.db as never,s3:c.s3 as never}).read(context,'voice',null,signal())).rejects.toThrow('cross_store_export_invalid');
  });
  it('lists a document without content when its metadata, object, length or digest is wrong, naming the reason and fetching nothing it need not',async()=>{
    const altered=Buffer.from('%PDF-1.4 ALTERED');
    const bound=Buffer.alloc(CROSS_STORE_INLINE_DOCUMENT_BOUND,9);
    const rows={['job#'+job('5')]:labRow('job#'+job('5'),[
      document(doc('a'),pdf,'missing.pdf'),
      document(doc('b'),pdf,'altered.pdf',{byteSize:altered.byteLength}),
      document(doc('c'),pdf,'huge.pdf',{byteSize:CROSS_STORE_INLINE_DOCUMENT_BOUND+1}),
      document(doc('d'),pdf,'nokey.pdf',{objectKey:undefined}),
      document(doc('e'),pdf,'lying.pdf',{byteSize:1}),
      document(doc('f'),pdf,'short.pdf',{byteSize:pdf.byteLength+3}),
      document(doc('1'),pdf,'negative.pdf',{byteSize:-5}),
      document(doc('2'),pdf,'zero.pdf',{byteSize:0}),
      document(doc('3'),pdf,'float.pdf',{byteSize:1.5}),
      document(doc('4'),bound,'bound.pdf')])};
    const c=clients(rows,{'altered.pdf':{bytes:altered},'huge.pdf':{bytes:pdf},'lying.pdf':{bytes:Buffer.alloc(CROSS_STORE_INLINE_DOCUMENT_BOUND+1,1),contentLength:null},'short.pdf':{bytes:pdf,contentLength:null},'bound.pdf':{bytes:bound}});
    const page=await reader(c).read(context,'labs',null,signal());
    const documents=page.items.filter(i=>i.kind==='lab_document') as {clientDocumentId:string;omitted?:string;content:unknown}[];
    expect(documents.map(d=>[d.clientDocumentId.slice(0,1),d.omitted??'ok',d.content===null])).toEqual([
      ['a','object_missing',true],['b','digest_mismatch',true],['c','exceeds_inline_bound',true],['d','object_key_missing',true],
      ['e','length_mismatch',true],['f','length_mismatch',true],['1','size_metadata_invalid',true],['2','size_metadata_invalid',true],['3','size_metadata_invalid',true],['4','ok',false]]);
    // Over-declared and keyless documents are never fetched (five objects requested); the lying object was cut off at its one declared byte.
    expect(c.s3.send).toHaveBeenCalledTimes(5);
    expect(c.streams['lying.pdf'].destroyed).toBe(true);expect(c.streams['lying.pdf'].served).toBeLessThanOrEqual(1);
    expect((documents[9] as {content:string}).content).toBe(bound.toString('base64'));
  });
  it('bounds the bytes materialised per page and resumes inside the listing without duplicating or losing a document',async()=>{
    const three=Buffer.alloc(3*1024*1024,5);
    const rows={['job#'+job('5')]:labRow('job#'+job('5'),[document(doc('a'),three,'a.pdf'),document(doc('b'),three,'b.pdf')]),['job#'+job('6')]:labRow('job#'+job('6'),[document(doc('c'),three,'c.pdf'),document(doc('d'),pdf,'d.pdf')])};
    const c=clients(rows,{'a.pdf':{bytes:three},'b.pdf':{bytes:three},'c.pdf':{bytes:three},'d.pdf':{bytes:pdf}});
    const r=reader(c,{pageInlineBudget:8*1024*1024});
    const first=await r.read(context,'labs',null,signal());
    expect(first.items.map(i=>[i.kind,String((i as {clientDocumentId?:string}).clientDocumentId??'').slice(0,1)])).toEqual([['lab_job',''],['lab_document','a'],['lab_document','b'],['lab_job','']]);
    expect(first.nextCursor).toBeTruthy();
    const second=await r.read(context,'labs',first.nextCursor,signal());
    expect(second.items.map(i=>[i.kind,String((i as {clientDocumentId?:string}).clientDocumentId??'').slice(0,1)])).toEqual([['lab_document','c'],['lab_document','d']]);
    expect(second.nextCursor).toBeNull();
    // A resume cursor that names a document resumes after it; one that names a job with no document resumes at its first document.
    const resumeAfterC=Buffer.from(JSON.stringify({listing:null,afterJob:job('6'),afterDocument:doc('c')})).toString('base64url');
    expect((await r.read(context,'labs',resumeAfterC,signal())).items.map(i=>String((i as {clientDocumentId?:string}).clientDocumentId).slice(0,1))).toEqual(['d']);
    await expect(r.read(context,'labs','not base64url!',signal())).rejects.toThrow('cross_store_export_invalid');
    await expect(r.read(context,'labs',Buffer.from('{"listing":null}').toString('base64url'),signal())).rejects.toThrow('cross_store_export_invalid');
  });
  it('exports the owner\'s voice jobs with bounded transcripts, states why one is absent, pages by scan key and by budget, and skips foreign rows',async()=>{
    const authorization={version:'owned-voice/1',personId:owner,organizationId:org,identitySubject:sub};
    const mine=(id:string,state='ready')=>({id,owner:voiceOwner({actorPersonId:owner,organizationId:org,identitySubject:sub}),inputHash:'b'.repeat(64),format:'wav',state,cancelled:false,createdAt:1_758_000_000,readableUntil:0,consentVersion:'v',consentAcceptedAt:0,nextWork:0,authorization});
    const foreign={...mine('d'.repeat(64)),owner:voiceOwner({actorPersonId:other,organizationId:org,identitySubject:'x-'.repeat(8)}),authorization:{...authorization,personId:other,identitySubject:'x-'.repeat(8)}};
    const transcript=(text:string)=>Buffer.from(JSON.stringify({results:{transcripts:[{transcript:text}]}}));
    const ready=mine('a'.repeat(64)),queued=mine('c'.repeat(64),'queued'),cleaned=mine('e'.repeat(64),'cleaned'),big=mine('f'.repeat(64)),broken=mine('1'.repeat(64));
    const c=clients({},{},[ready,queued,foreign,cleaned,big,broken],{
      ['personal-voice/output/'+ready.id+'.json']:{bytes:transcript('FICTIONAL TRANSCRIPT')},
      ['personal-voice/output/'+big.id+'.json']:{bytes:Buffer.alloc(CROSS_STORE_TRANSCRIPT_BOUND+1,1)},
      ['personal-voice/output/'+broken.id+'.json']:{bytes:Buffer.from('not json')}});
    const page=await reader(c).read(context,'voice',null,signal());
    expect(page.skipped).toBe(1);expect(page.nextCursor).toBeNull();
    expect(page.items.map(i=>[String(i.jobId).slice(0,1),i.transcript,i.omitted])).toEqual([['a','FICTIONAL TRANSCRIPT',undefined],['c',null,'not_ready'],['e',null,'removed_by_retention'],['f',null,'exceeds_inline_bound'],['1',null,'provider_output_invalid']]);
    expect(page.items.every(i=>Date.parse(String(i.readAt))>0)).toBe(true);
    // Scan paging: 30 ready jobs cross a scan page boundary; budget paging: five 2 MiB transcripts do not fit one 8 MiB page.
    const many=Array.from({length:30},(_,i)=>mine(i.toString(16).padStart(64,'0')));
    const objects=Object.fromEntries(many.map(m=>['personal-voice/output/'+m.id+'.json',{bytes:transcript('T'+m.id.slice(-2))}]));
    const cm=clients({},{},many,objects);
    const p1=await reader(cm).read(context,'voice',null,signal());expect(p1.items).toHaveLength(25);expect(p1.nextCursor).toBeTruthy();
    const p2=await reader(cm).read(context,'voice',p1.nextCursor,signal());expect(p2.items).toHaveLength(5);expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items,...p2.items].map(i=>i.jobId)).size).toBe(30);
    const fat=Array.from({length:5},(_,i)=>mine((i+2).toString(16).padStart(64,'0')));
    const cf=clients({},{},fat,Object.fromEntries(fat.map(m=>['personal-voice/output/'+m.id+'.json',{bytes:Buffer.alloc(CROSS_STORE_TRANSCRIPT_BOUND,1)}])));
    const rf=reader(cf,{pageInlineBudget:8*1024*1024});
    const b1=await rf.read(context,'voice',null,signal());expect(b1.items).toHaveLength(4);expect(b1.nextCursor).toBeTruthy();
    const b2=await rf.read(context,'voice',b1.nextCursor,signal());expect(b2.items).toHaveLength(1);expect(b2.nextCursor).toBeNull();
    expect(cf.scanCount()).toBe(2);
    await expect(reader(cf).read(context,'voice','not base64url!',signal())).rejects.toThrow('cross_store_export_invalid');
  });
  it('refuses malformed store configuration and a page budget below one document before any client is created',()=>{
    expect(()=>createAwsCrossStoreExportReader({labs:{table:'x',bucket:'Bad Bucket'},region:'us-east-2'})).toThrow('cross_store_export_invalid');
    expect(()=>createAwsCrossStoreExportReader({voice:{table:'fictional',bucket:'fictional-bucket'},region:'nowhere'})).toThrow('cross_store_export_invalid');
    expect(()=>createAwsCrossStoreExportReader({region:'us-east-2',pageInlineBudget:1024})).toThrow('cross_store_export_invalid');
    expect(createAwsCrossStoreExportReader({region:'us-east-2'}).configured('labs')).toBe(false);
  });
});
