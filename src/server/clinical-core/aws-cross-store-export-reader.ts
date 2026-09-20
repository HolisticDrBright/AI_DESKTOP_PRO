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
 * exported. Documents are inlined base64 up to a bound and otherwise listed with the reason, so the copy
 * is honest about what it holds. Nothing here writes, deletes or lists other owners. */
export type CrossStoreExportSection='labs'|'voice';
export type CrossStoreExportPage={items:Record<string,unknown>[];nextCursor:string|null;skipped:number};
export type CrossStoreExportReader={configured:(section:CrossStoreExportSection)=>boolean;
  read:(context:ProductionClinicalRequestContext,section:CrossStoreExportSection,cursor:string|null,signal:AbortSignal)=>Promise<CrossStoreExportPage>};
export const CROSS_STORE_INLINE_DOCUMENT_BOUND=6*1024*1024;
const VOICE_OUTPUT_PREFIX='personal-voice/output/';
const TABLE=/^[A-Za-z0-9_.-]{3,255}$/,BUCKET=/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,REGION=/^[a-z]{2}-[a-z]+-[1-9]$/;
type Clients={db:DynamoDBDocumentClient;s3:S3Client};
const fail=():never=>{throw new Error('cross_store_export_invalid');};
async function bytesOf(body:unknown):Promise<Uint8Array>{
  if(!body||typeof body!=='object'||typeof (body as {transformToByteArray?:unknown}).transformToByteArray!=='function')fail();
  return (body as {transformToByteArray:()=>Promise<Uint8Array>}).transformToByteArray();
}
export function createAwsCrossStoreExportReader(config:{labs?:{table:string;bucket:string};voice?:{table:string;bucket:string};region:string},clients?:Partial<Clients>):CrossStoreExportReader{
  if(!REGION.test(config.region))fail();
  for(const store of [config.labs,config.voice])if(store&&(!TABLE.test(store.table)||!BUCKET.test(store.bucket)))fail();
  let made:Clients|undefined;
  const aws=()=>made??=({db:clients?.db??DynamoDBDocumentClient.from(new DynamoDBClient({region:config.region})),s3:clients?.s3??new S3Client({region:config.region})});
  const object=async(bucket:string,key:string,signal:AbortSignal):Promise<Uint8Array|null>=>{
    try{const out=await aws().s3.send(new GetObjectCommand({Bucket:bucket,Key:key,ExpectedBucketOwner:undefined}),{abortSignal:signal});return bytesOf(out.Body);}
    catch(error){if(error instanceof Error&&['NoSuchKey','NotFound'].includes(error.name))return null;throw error;}
  };
  async function labs(context:ProductionClinicalRequestContext,cursor:string|null,signal:AbortSignal):Promise<CrossStoreExportPage>{
    const store=config.labs!,scope={ownerSub:context.identitySubject,organizationId:context.organizationId,personId:context.actorPersonId};
    const page=await listLabInventory(aws().db,store.table,scope,cursor??undefined);
    const items:Record<string,unknown>[]=[];let skipped=0;
    for(const job of page.jobs){
      const row=(await aws().db.send(new GetCommand({TableName:store.table,Key:{pk:'job#'+job.jobId},ConsistentRead:true}),{abortSignal:signal})).Item as Record<string,unknown>|undefined;
      if(!row||row.ownerSub!==scope.ownerSub||String(row.personId).toLowerCase()!==scope.personId.toLowerCase()||String(row.organizationId).toLowerCase()!==scope.organizationId.toLowerCase()){skipped++;continue;}
      const documents:Record<string,unknown>[]=[];
      for(const d of (Array.isArray(row.documents)?row.documents as Record<string,unknown>[]:[])){
        const meta={clientDocumentId:String(d.clientDocumentId),fileName:typeof d.fileName==='string'?d.fileName:null,contentType:String(d.contentType),byteSize:Number(d.byteSize),checksumSHA256:String(d.checksumSHA256)};
        if(typeof d.objectKey!=='string'){documents.push({...meta,content:null,omitted:'object_key_missing'});continue;}
        if(!Number.isSafeInteger(meta.byteSize)||meta.byteSize>CROSS_STORE_INLINE_DOCUMENT_BOUND){documents.push({...meta,content:null,omitted:'exceeds_inline_bound'});continue;}
        const bytes=await object(store.bucket,d.objectKey,signal);
        if(!bytes){documents.push({...meta,content:null,omitted:'object_missing'});continue;}
        const digest=createHash('sha256').update(bytes).digest('base64');
        if(digest!==meta.checksumSHA256){documents.push({...meta,content:null,omitted:'digest_mismatch'});continue;}
        documents.push({...meta,encoding:'base64',content:Buffer.from(bytes).toString('base64')});
      }
      items.push({kind:'lab_job',jobId:job.jobId,createdAt:job.createdAt,state:job.state,progressPercent:job.progressPercent,
        ...(job.panelId?{panelId:job.panelId}:{}),...(job.publication?{publication:job.publication}:{}),
        result:row.result===undefined||row.result===null?null:sanitizeStoredResult(row.result),documents});
    }
    return {items,nextCursor:page.nextCursor,skipped};
  }
  async function voice(context:ProductionClinicalRequestContext,cursor:string|null,signal:AbortSignal):Promise<CrossStoreExportPage>{
    const store=config.voice!;
    let after:{id:string}|undefined;
    if(cursor!==null){if(!/^[A-Za-z0-9_-]{1,600}$/.test(cursor))fail();const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!parsed||typeof parsed.id!=='string'||Object.keys(parsed).length!==1)fail();after=parsed;}
    const result=await aws().db.send(new ScanCommand({TableName:store.table,ConsistentRead:true,Limit:25,FilterExpression:'#authorization.#person = :owner',
      ExpressionAttributeNames:{'#authorization':'authorization','#person':'personId'},ExpressionAttributeValues:{':owner':context.actorPersonId},...(after?{ExclusiveStartKey:after}:{})}),{abortSignal:signal});
    const items:Record<string,unknown>[]=[];let skipped=0;
    for(const row of (result.Items??[]) as (VoiceJob&Record<string,unknown>)[]){
      let binding:ReturnType<typeof ownedVoiceDeletionScope>;
      try{binding=ownedVoiceDeletionScope(row);}catch{skipped++;continue;}
      if(binding.personId.toLowerCase()!==context.actorPersonId.toLowerCase()||binding.ownerSub!==context.identitySubject||binding.organizationId.toLowerCase()!==context.organizationId.toLowerCase()){skipped++;continue;}
      let transcript:string|null=null,omitted:string|undefined;
      if(row.state==='ready'){
        const bytes=await object(store.bucket,`${VOICE_OUTPUT_PREFIX}${row.id}.json`,signal);
        if(!bytes)omitted='object_missing';
        else{try{const doc=JSON.parse(Buffer.from(bytes).toString('utf8')) as {results?:{transcripts?:{transcript?:string}[]}};transcript=doc.results?.transcripts?.[0]?.transcript??null;if(transcript===null)omitted='transcript_absent';}catch{omitted='provider_output_invalid';}}
      }else omitted=row.state==='cleaned'?'removed_by_retention':'not_ready';
      items.push({kind:'voice_job',jobId:row.id,state:row.state,format:row.format,createdAt:new Date(Number(row.createdAt)*1000).toISOString(),transcript,...(omitted?{omitted}:{})});
    }
    const next=result.LastEvaluatedKey?{id:String((result.LastEvaluatedKey as {id?:unknown}).id)}:null;
    if(next&&(!next.id||JSON.stringify(next)===JSON.stringify(after)))fail();
    return {items,nextCursor:next?Buffer.from(JSON.stringify(next)).toString('base64url'):null,skipped};
  }
  return {configured:section=>Boolean(config[section]),
    read:async(context,section,cursor,signal)=>{if(!config[section])fail();return section==='labs'?labs(context,cursor,signal):voice(context,cursor,signal);}};
}
