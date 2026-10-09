import {createHash} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {GetObjectCommand,S3Client} from '@aws-sdk/client-s3';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {listLabInventory} from './lab-job-inventory';
import {sanitizeStoredResult} from './aws-lab-analysis-api';
import {ownedVoiceDeletionScope} from './owned-voice-deletion';
import type {VoiceJob} from './voice-jobs';

/** Owner-authorized readers for the two stores the personal-storage export could not reach: the lab
 * processing store (jobs, sanitized results, source documents) and the voice transcription store (jobs,
 * transcripts). Every read runs under the owner's own verified identity inside an export pass; a row that
 * does not carry exactly this owner's subject, person and organization is skipped and counted, never
 * exported.
 *
 * Bytes are bounded by what is actually read, not by stored metadata: every object is streamed with a
 * hard limit and destroyed on overflow, a declared size must match the object's ContentLength and the
 * bytes received, and the digest must match before content is inlined. A document that fails any of
 * these is listed with the reason, never with content. Each page materialises at most
 * `CROSS_STORE_PAGE_INLINE_BUDGET` raw bytes; a page that would exceed it stops after the last whole
 * item and returns a cursor that resumes inside the same listing page, so a job with many documents is
 * never held in memory at once. Reads are live: every item carries `readAt`, and the coverage statement
 * says the store sections are per-item live reads rather than one snapshot. Nothing here writes, deletes
 * or lists other owners. */
export type CrossStoreExportSection='labs'|'voice';
export type CrossStoreExportPage={items:Record<string,unknown>[];nextCursor:string|null;skipped:number};
export type CrossStoreExportReader={configured:(section:CrossStoreExportSection)=>boolean;
  read:(context:ProductionClinicalRequestContext,section:CrossStoreExportSection,cursor:string|null,signal:AbortSignal)=>Promise<CrossStoreExportPage>};
export const CROSS_STORE_INLINE_DOCUMENT_BOUND=6*1024*1024;
export const CROSS_STORE_TRANSCRIPT_BOUND=2*1024*1024;
export const CROSS_STORE_PAGE_INLINE_BUDGET=8*1024*1024;
export const CROSS_STORE_CONSISTENCY='live_read_per_item' as const;
const VOICE_OUTPUT_PREFIX='personal-voice/output/';
const TABLE=/^[A-Za-z0-9_.-]{3,255}$/,BUCKET=/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,REGION=/^[a-z]{2}-[a-z]+-[1-9]$/;
const CURSOR=/^[A-Za-z0-9_-]{1,1200}$/;
type Clients={db:DynamoDBDocumentClient;s3:S3Client};
type Bounded={bytes:Uint8Array}|{omitted:'object_missing'|'exceeds_inline_bound'|'length_mismatch'|'body_unreadable'};
const fail=():never=>{throw new Error('cross_store_export_invalid');};
const aborted=():never=>{const e=new Error('cross_store_export_aborted');e.name='AbortError';throw e;};
const encodeCursor=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
function decodeCursor<T>(cursor:string,keys:string[]):T{
  if(!CURSOR.test(cursor))fail();
  let parsed:unknown;try{parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail();}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed as object).sort().join(',')!==keys.slice().sort().join(','))fail();
  return parsed as T;
}
/** Streams a body up to `limit` bytes. `expected` (the caller's declared size) must equal the object's ContentLength when
 * the store reports one and the bytes actually received; the stream is destroyed the moment either bound is passed. */
export async function readBoundedObject(output:{Body?:unknown;ContentLength?:number},options:{limit:number;expected:number|null;signal:AbortSignal}):Promise<Bounded>{
  const {limit,expected,signal}=options;
  const body=output.Body as (AsyncIterable<Uint8Array>&{destroy?:(error?:Error)=>void})|undefined;
  if(!body||typeof body!=='object'||typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]!=='function')return {omitted:'body_unreadable'};
  const destroy=()=>{try{body.destroy?.();}catch{/* already closed */}};
  if(typeof output.ContentLength==='number'){
    if(!Number.isSafeInteger(output.ContentLength)||output.ContentLength<0){destroy();return {omitted:'length_mismatch'};}
    if(output.ContentLength>limit){destroy();return {omitted:'exceeds_inline_bound'};}
    if(expected!==null&&output.ContentLength!==expected){destroy();return {omitted:'length_mismatch'};}
  }
  const ceiling=expected===null?limit:Math.min(limit,expected);
  const chunks:Uint8Array[]=[];let total=0;
  const onAbort=()=>destroy();
  if(signal.aborted){destroy();aborted();}
  signal.addEventListener('abort',onAbort,{once:true});
  try{
    for await(const chunk of body){
      if(signal.aborted){destroy();aborted();}
      const part=chunk instanceof Uint8Array?chunk:Buffer.from(chunk as string);
      total+=part.byteLength;
      if(total>ceiling){destroy();return {omitted:total>limit||expected===null?'exceeds_inline_bound':'length_mismatch'};}
      chunks.push(part);
    }
  }catch(error){
    // A body destroyed by the abort listener ends the iteration with a premature-close error: report the abort, not the stream.
    if(signal.aborted)aborted();
    throw error;
  }finally{signal.removeEventListener('abort',onAbort);}
  if(signal.aborted)aborted();
  if(expected!==null&&total!==expected)return {omitted:'length_mismatch'};
  return {bytes:Buffer.concat(chunks)};
}
export function createAwsCrossStoreExportReader(config:{labs?:{table:string;bucket:string};voice?:{table:string;bucket:string};region:string;pageInlineBudget?:number},clients?:Partial<Clients>):CrossStoreExportReader{
  if(!REGION.test(config.region))fail();
  for(const store of [config.labs,config.voice])if(store&&(!TABLE.test(store.table)||!BUCKET.test(store.bucket)))fail();
  const budget=config.pageInlineBudget??CROSS_STORE_PAGE_INLINE_BUDGET;
  if(!Number.isSafeInteger(budget)||budget<CROSS_STORE_INLINE_DOCUMENT_BOUND)fail();
  let made:Clients|undefined;
  const aws=()=>made??=({db:clients?.db??DynamoDBDocumentClient.from(new DynamoDBClient({region:config.region})),s3:clients?.s3??new S3Client({region:config.region})});
  const object=async(bucket:string,key:string,limit:number,expected:number|null,signal:AbortSignal):Promise<Bounded>=>{
    let out:{Body?:unknown;ContentLength?:number};
    try{out=await aws().s3.send(new GetObjectCommand({Bucket:bucket,Key:key}),{abortSignal:signal});}
    catch(error){if(error instanceof Error&&['NoSuchKey','NotFound'].includes(error.name))return {omitted:'object_missing'};throw error;}
    return readBoundedObject(out,{limit,expected,signal});
  };
  const now=()=>new Date().toISOString();
  type LabCursor={listing:string|null;afterJob:string|null;afterDocument:string|null};
  async function labs(context:ProductionClinicalRequestContext,cursor:string|null,signal:AbortSignal):Promise<CrossStoreExportPage>{
    const store=config.labs!,scope={ownerSub:context.identitySubject,organizationId:context.organizationId,personId:context.actorPersonId};
    const position:LabCursor=cursor===null?{listing:null,afterJob:null,afterDocument:null}:decodeCursor<LabCursor>(cursor,['listing','afterJob','afterDocument']);
    if((position.listing!==null&&typeof position.listing!=='string')||(position.afterJob!==null&&typeof position.afterJob!=='string')||(position.afterDocument!==null&&typeof position.afterDocument!=='string'))fail();
    const page=await listLabInventory(aws().db,store.table,scope,position.listing??undefined);
    const items:Record<string,unknown>[]=[];let skipped=0,materialised=0;
    // Resume inside this listing page after the named job (and document). A job no longer on the page (a concurrent
    // listing change) restarts the page from its beginning: a repeated job item is possible then, a lost one is not.
    let jobStart=0,resumeDocumentsOf:string|null=null;
    if(position.afterJob!==null){
      const at=page.jobs.findIndex(j=>j.jobId===position.afterJob);
      if(at>=0){jobStart=at+1;if(position.afterDocument!==null||position.afterDocument===null){resumeDocumentsOf=position.afterJob;jobStart=at;}}
    }
    for(let jobIndex=jobStart;jobIndex<page.jobs.length;jobIndex++){
      const job=page.jobs[jobIndex];
      const row=(await aws().db.send(new GetCommand({TableName:store.table,Key:{pk:'job#'+job.jobId},ConsistentRead:true}),{abortSignal:signal})).Item as Record<string,unknown>|undefined;
      if(!row||row.ownerSub!==scope.ownerSub||String(row.personId).toLowerCase()!==scope.personId.toLowerCase()||String(row.organizationId).toLowerCase()!==scope.organizationId.toLowerCase()){skipped++;continue;}
      const documents=(Array.isArray(row.documents)?row.documents as Record<string,unknown>[]:[]);
      let documentStart=0;
      if(resumeDocumentsOf===job.jobId){
        resumeDocumentsOf=null;
        if(position.afterDocument!==null){const at=documents.findIndex(d=>d.clientDocumentId===position.afterDocument);documentStart=at>=0?at+1:0;}
      }else{
        items.push({kind:'lab_job',jobId:job.jobId,createdAt:job.createdAt,state:job.state,progressPercent:job.progressPercent,
          ...(job.panelId?{panelId:job.panelId}:{}),...(job.publication?{publication:job.publication}:{}),
          result:row.result===undefined||row.result===null?null:sanitizeStoredResult(row.result),documentCount:documents.length,readAt:now()});
      }
      for(let documentIndex=documentStart;documentIndex<documents.length;documentIndex++){
        const d=documents[documentIndex];
        const meta={clientDocumentId:String(d.clientDocumentId),fileName:typeof d.fileName==='string'?d.fileName:null,contentType:String(d.contentType),
          byteSize:typeof d.byteSize==='number'?d.byteSize:null,checksumSHA256:String(d.checksumSHA256)};
        const declared=meta.byteSize;
        const emit=(extra:Record<string,unknown>)=>items.push({kind:'lab_document',jobId:job.jobId,...meta,...extra,readAt:now()});
        if(declared===null||!Number.isSafeInteger(declared)||declared<1){emit({content:null,omitted:'size_metadata_invalid'});continue;}
        if(declared>CROSS_STORE_INLINE_DOCUMENT_BOUND){emit({content:null,omitted:'exceeds_inline_bound'});continue;}
        if(typeof d.objectKey!=='string'){emit({content:null,omitted:'object_key_missing'});continue;}
        // The page budget is checked before a document is read, on its declared size; an over-declaration is caught by the read.
        if(items.length>0&&materialised+declared>budget)
          return {items,skipped,nextCursor:encodeCursor({listing:position.listing,afterJob:job.jobId,afterDocument:documentIndex===0?null:String(documents[documentIndex-1].clientDocumentId)} satisfies LabCursor)};
        const read=await object(store.bucket,d.objectKey,CROSS_STORE_INLINE_DOCUMENT_BOUND,declared,signal);
        if('omitted' in read){emit({content:null,omitted:read.omitted});continue;}
        materialised+=read.bytes.byteLength;
        const digest=createHash('sha256').update(read.bytes).digest('base64');
        if(digest!==meta.checksumSHA256){emit({content:null,omitted:'digest_mismatch'});continue;}
        emit({encoding:'base64',content:Buffer.from(read.bytes).toString('base64')});
      }
    }
    return {items,skipped,nextCursor:page.nextCursor?encodeCursor({listing:page.nextCursor,afterJob:null,afterDocument:null} satisfies LabCursor):null};
  }
  type VoiceCursor={scan:{id:string}|null;afterJob:string|null};
  async function voice(context:ProductionClinicalRequestContext,cursor:string|null,signal:AbortSignal):Promise<CrossStoreExportPage>{
    const store=config.voice!;
    const position:VoiceCursor=cursor===null?{scan:null,afterJob:null}:decodeCursor<VoiceCursor>(cursor,['scan','afterJob']);
    if((position.scan!==null&&(typeof position.scan!=='object'||typeof position.scan.id!=='string'||Object.keys(position.scan).length!==1))||(position.afterJob!==null&&typeof position.afterJob!=='string'))fail();
    const result=await aws().db.send(new ScanCommand({TableName:store.table,ConsistentRead:true,Limit:25,FilterExpression:'#authorization.#person = :owner',
      ExpressionAttributeNames:{'#authorization':'authorization','#person':'personId'},ExpressionAttributeValues:{':owner':context.actorPersonId},...(position.scan?{ExclusiveStartKey:position.scan}:{})}),{abortSignal:signal});
    const rows=(result.Items??[]) as (VoiceJob&Record<string,unknown>)[];
    const items:Record<string,unknown>[]=[];let skipped=0,materialised=0;
    let start=0;
    if(position.afterJob!==null){const at=rows.findIndex(r=>r.id===position.afterJob);start=at>=0?at+1:0;}
    for(let index=start;index<rows.length;index++){
      const row=rows[index];
      let binding:ReturnType<typeof ownedVoiceDeletionScope>;
      try{binding=ownedVoiceDeletionScope(row);}catch{skipped++;continue;}
      if(binding.personId.toLowerCase()!==context.actorPersonId.toLowerCase()||binding.ownerSub!==context.identitySubject||binding.organizationId.toLowerCase()!==context.organizationId.toLowerCase()){skipped++;continue;}
      let transcript:string|null=null,omitted:string|undefined;
      if(row.state==='ready'){
        if(items.length>0&&materialised+CROSS_STORE_TRANSCRIPT_BOUND>budget)
          return {items,skipped,nextCursor:encodeCursor({scan:position.scan,afterJob:rows[index-1].id} satisfies VoiceCursor)};
        const read=await object(store.bucket,`${VOICE_OUTPUT_PREFIX}${row.id}.json`,CROSS_STORE_TRANSCRIPT_BOUND,null,signal);
        if('omitted' in read)omitted=read.omitted;
        else{
          materialised+=read.bytes.byteLength;
          try{const doc=JSON.parse(Buffer.from(read.bytes).toString('utf8')) as {results?:{transcripts?:{transcript?:string}[]}};transcript=doc.results?.transcripts?.[0]?.transcript??null;if(transcript===null)omitted='transcript_absent';}
          catch{omitted='provider_output_invalid';}
        }
      }else omitted=row.state==='cleaned'?'removed_by_retention':'not_ready';
      items.push({kind:'voice_job',jobId:row.id,state:row.state,format:row.format,createdAt:new Date(Number(row.createdAt)*1000).toISOString(),transcript,...(omitted?{omitted}:{}),readAt:now()});
    }
    const next=result.LastEvaluatedKey?{id:String((result.LastEvaluatedKey as {id?:unknown}).id)}:null;
    if(next&&(!next.id||JSON.stringify(next)===JSON.stringify(position.scan)))fail();
    return {items,skipped,nextCursor:next?encodeCursor({scan:next,afterJob:null} satisfies VoiceCursor):null};
  }
  return {configured:section=>Boolean(config[section]),
    read:async(context,section,cursor,signal)=>{if(!config[section])fail();return section==='labs'?labs(context,cursor,signal):voice(context,cursor,signal);}};
}
