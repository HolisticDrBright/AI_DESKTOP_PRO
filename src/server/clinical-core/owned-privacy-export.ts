import { createHash } from 'node:crypto';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { clinicalUuid, type ClinicalCoreTransaction } from './database';
import { OwnedStorageError, OWNED_STORAGE_SCOPES } from './owned-consumer-records';
import { OWNED_COLLECTIONS, ownedPayloadLimit } from './owned-lab-observations';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECTIONS=['records','consents'] as const;
export type PrivacyExportSection=typeof SECTIONS[number];
type After={key:string;revision:number;recordId?:string};
type Run=<T>(context:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>Promise<T>;

// Machine-readable coverage is part of every manifest, not hidden in a footer.
export const PERSONAL_EXPORT_COVERAGE={
  completeAccountExport:false,
  included:['personal_record_versions_including_tombstones','personal_storage_consent_history'],
  excluded:['clinic_records_and_messages','lab_processing_jobs_and_documents','chat_and_voice_transcripts',
    'identity_and_billing','other_device_local_caches_and_recovery_archives','backups_and_security_audit_logs'],
} as const;

/**
 * The segmented records read (BLOCKED source candidate infra/aws-clinical-core/source-candidates/owned-privacy-export-segments.sql,
 * docs/privacy-export-oversized-records-2026-10-17.md).
 *
 * The deployed reader, clinical_core.read_owned_privacy_export, bounds a page to 24 KiB of item JSON (the RDS Data API
 * limits a result row to 64 KiB) and refuses the page when one record alone does not fit. A saved lab analysis may be
 * 256 KiB, so one such record withholds the owner's whole personal-storage copy.
 *
 * `blocked` (the default): records pages come from the deployed reader exactly as before. `qualification`: records pages
 * are reassembled from clinical_core.read_owned_privacy_export_segments, which exists only once the candidate is applied;
 * each record is verified for size and digest and returned whole, under PRIVACY_EXPORT_PAGE_BYTES, in the unchanged
 * personal-storage-export/1 page. Consents are read by the deployed function either way. Moving it is Codex work after
 * the candidate is applied and qualified; with it moved and the candidate absent every records page fails.
 */
export const PRIVACY_EXPORT_SEGMENTED_READ_RELEASE: "blocked" | "qualification" = "blocked";
export const PRIVACY_EXPORT_SEGMENTS_SHA256="06a99fd76881cd2ed194d12f0761fb5264124d4063797ce84afa89622bda8cfa";
export const PRIVACY_EXPORT_SEGMENTS_ROLLBACK_SHA256="bff3f1844e272f5a826cf490c992b3ddb11b183752d11749fef56ac27869aecc";
/** prosrc SHA-256: the candidate's function, and the two deployed parents it refuses to apply without. */
export const PRIVACY_EXPORT_SEGMENTS_PROSRC={
  segments:"e8dd247406a6469916e617af2651aa2c68412445d1c08a69e679c6e6657e432a",
  read:"8b12c598486a6de88a98a8c8c877e3fd5163260e532a126974fae4bd6a9fa5a1",
  actor:"d716d99f9ed0e710b4c34ee11af53613a090d63904487a20c2ff8ec24aa02fd9",
} as const;
/** The candidate's fixed segment: raw payload octets per segment (20,480 characters once base64-encoded). */
export const PRIVACY_EXPORT_SEGMENT_BYTES=15360;
/** Whole records per page in the segmented path: at most this much item JSON, except that a page always holds one record.
 * V2 bounds a response to 2 MiB; the largest record is 256 KiB. */
export const PRIVACY_EXPORT_PAGE_BYTES=1024*1024;
// The deployed reader's own tolerance for one payload (unchanged); lab analyses are stored up to ownedPayloadLimit.
const PAYLOAD_TOLERANCE_BYTES=32768;
const RECORD_OVERHEAD_BYTES=512;
// Each call returns at least one segment of at most 15 KiB or the page ends, so a page of at most 100 records needs far
// fewer; this bounds a server that keeps answering without finishing.
const MAX_SEGMENT_CALLS=512;
const SEGMENT_KEYS=['collection','recordId','revision','deleted','consentRevision','receivedAt','payloadBytes','payloadSha256','segment','segmentCount','data'];
type RecordItem={collection:string;recordId:string;revision:number;payload:Record<string,unknown>;deleted:boolean;consentRevision:number;receivedAt:string};
type Segment=Omit<RecordItem,'payload'>&{payloadBytes:number;payloadSha256:string;segment:number;segmentCount:number;bytes:Buffer};

export function createOwnedPrivacyExport(run:Run,options:{segmentedRead?:'blocked'|'qualification'}={}){
  const segmentedRead=options.segmentedRead??PRIVACY_EXPORT_SEGMENTED_READ_RELEASE;
  if(segmentedRead!=='blocked'&&segmentedRead!=='qualification')throw new Error('privacy_export_segmented_read_invalid');
  return {
    async startPrivacyExport(context:ProductionClinicalRequestContext,input:{requestId:string}){
      exact(input,['requestId']);if(!UUID.test(input.requestId))invalid();
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.start_owned_privacy_export($1) as result',[clinicalUuid(input.requestId)]);
        const value=object(result.rows[0]?.result);
        if(!UUID.test(String(value.exportId))||!date(value.asOf)||!date(value.expiresAt)
          ||Date.parse(value.expiresAt as string)<=Date.parse(value.asOf as string)
          ||!count(value.recordCount)||!count(value.consentCount))unavailable();
        return {version:'personal-storage-export/1' as const,exportId:value.exportId as string,asOf:value.asOf as string,
          expiresAt:value.expiresAt as string,recordCount:value.recordCount as number,consentCount:value.consentCount as number,
          coverage:PERSONAL_EXPORT_COVERAGE};
      });
    },
    async readPrivacyExport(context:ProductionClinicalRequestContext,input:{exportId:string;section:PrivacyExportSection;limit:number;cursor?:string}){
      exact(input,['exportId','section','limit','cursor']);
      if(!UUID.test(input.exportId)||!SECTIONS.includes(input.section)||!Number.isInteger(input.limit)||input.limit<1||input.limit>100)invalid();
      let after:After|null=null;
      if(input.cursor!==undefined)after=decodeCursor(input.cursor,input.exportId,input.section);
      if(segmentedRead==='qualification'&&input.section==='records'){
        return run(context,async tx=>{
          const page=await readSegmentedRecords(tx,input.exportId,input.limit,after);
          return {exportId:input.exportId,asOf:page.asOf,section:input.section,items:page.items,nextCursor:page.next?encodeCursor(input.exportId,input.section,page.next):null};
        });
      }
      return run(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.read_owned_privacy_export($1,$2,$3::integer,$4::jsonb) as result',
          [clinicalUuid(input.exportId),input.section,input.limit,after===null?null:JSON.stringify(after)]);
        const value=object(result.rows[0]?.result);
        if(value.exportId!==input.exportId||value.section!==input.section||!date(value.asOf)||!Array.isArray(value.items)||value.items.length>input.limit)unavailable();
        const items=value.items.map(raw=>{
          const r=object(raw);
          if(!revision(r.revision))unavailable();
          if(input.section==='records'){
            if(!OWNED_COLLECTIONS.includes(r.collection as typeof OWNED_COLLECTIONS[number])||!UUID.test(String(r.recordId))
              ||typeof r.deleted!=='boolean'||!revision(r.consentRevision)||!date(r.receivedAt))unavailable();
            // Export retained history verbatim, not current-schema validation:
            // otherwise schema evolution could make old records unexportable.
            const payload=object(r.payload);
            if(Buffer.byteLength(JSON.stringify(payload),'utf8')>PAYLOAD_TOLERANCE_BYTES || (r.deleted&&Object.keys(payload).length))unavailable();
            return {collection:r.collection as string,recordId:r.recordId as string,revision:r.revision as number,
              payload,deleted:r.deleted,consentRevision:r.consentRevision as number,receivedAt:r.receivedAt as string};
          }
          if(!OWNED_STORAGE_SCOPES.includes(r.scope as typeof OWNED_STORAGE_SCOPES[number])||!['granted','revoked'].includes(String(r.status))
            ||typeof r.releaseVersion!=='string'||r.releaseVersion.length>80||!date(r.recordedAt))unavailable();
          return {scope:r.scope as string,revision:r.revision as number,status:r.status as 'granted'|'revoked',releaseVersion:r.releaseVersion,recordedAt:r.recordedAt as string};
        });
        let next:After|null=null;
        if(value.next!==null){try{next=validateAfter(value.next,input.section);}catch{unavailable();}}
        // Never accept an unbound or non-progressing DB cursor.
        const keyFor=(r:typeof items[number]):After=>input.section==='records'
          ?{key:r.collection!,recordId:r.recordId!,revision:r.revision}:{key:r.scope!,revision:r.revision};
        const keys=items.map(keyFor);
        for(let i=0;i<keys.length;i++)if((i===0?after:keys[i-1])&&compare((i===0?after:keys[i-1])!,keys[i])>=0)unavailable();
        if(next&&(!items.length||JSON.stringify(next)!==JSON.stringify(keys.at(-1))))unavailable();
        return {exportId:input.exportId,asOf:value.asOf as string,section:input.section,items,
          nextCursor:next?encodeCursor(input.exportId,input.section,next):null};
      });
    },
  };
}

/**
 * Whether the DEPLOYED records reader refuses the page after `cursor` only because the next record alone exceeds its page
 * bound. That reader answers privacy_export_request_invalid for every refusal, so the cause is deduced from its own rules,
 * with no new SQL: for a cursor this module accepts (the same checks the function applies), the function refuses a
 * records page only when the snapshot is not the caller's, has lapsed, or its first row does not fit the page. A limit-1
 * records page at the same cursor is refused again in all three cases; a consents page of the same snapshot, whose rows
 * are bounded far below the page, is read in the third alone. Anything else (an unacceptable cursor, a transient failure,
 * a records page that reads) answers false, and the caller keeps its existing behaviour. Each read is audited as usual.
 */
export async function deployedRecordExceedsPage(run:Run,context:ProductionClinicalRequestContext,input:{exportId:string;cursor:string|null}):Promise<boolean>{
  if(!UUID.test(input.exportId))return false;
  let after:After|null=null;
  if(input.cursor!==null){try{after=decodeCursor(input.cursor,input.exportId,'records');}catch{return false;}}
  const outcome=async(section:PrivacyExportSection,cursor:After|null):Promise<'read'|'refused'|'failed'>=>{
    try{
      await run(context,tx=>tx.query('select clinical_core.read_owned_privacy_export($1,$2,1,$3::jsonb) as result',
        [clinicalUuid(input.exportId),section,cursor===null?null:JSON.stringify(cursor)]));
      return 'read';
    }catch(error){return error instanceof OwnedStorageError&&error.code==='request_invalid'?'refused':'failed';}
  };
  if(await outcome('records',after)!=='refused')return false;
  return await outcome('consents',null)==='read';
}

/** Reassembles whole records from the candidate's segments, verifying each record's size and digest, under the page's
 * item limit and byte budget. The page's cursor stays the record cursor: it names the last whole record returned. */
async function readSegmentedRecords(tx:ClinicalCoreTransaction,exportId:string,limit:number,after:After|null):Promise<{asOf:string;items:RecordItem[];next:After|null}>{
  const items:RecordItem[]=[];let itemBytes=0,asOf:string|null=null,more=false;
  let position:(After&{segment?:number})|null=after,previous:After|null=after;
  let open:{first:Segment;parts:Buffer[]}|null=null;
  for(let call=0;;call++){
    if(call>=MAX_SEGMENT_CALLS)unavailable();
    const result=await tx.query<{result:unknown}>('select clinical_core.read_owned_privacy_export_segments($1,$2::integer,$3::jsonb) as result',
      [clinicalUuid(exportId),100,position===null?null:JSON.stringify(position)]);
    const value=object(result.rows[0]?.result);
    if(value.exportId!==exportId||value.section!=='records'||!date(value.asOf)||(asOf!==null&&value.asOf!==asOf)
      ||value.segmentBytes!==PRIVACY_EXPORT_SEGMENT_BYTES||!Array.isArray(value.items)||value.items.length>100)unavailable();
    asOf=value.asOf as string;
    const segments=value.items.map(segment);
    for(const s of segments){
      if(open){
        if(!sameVersion(open.first,s)||s.segment!==open.parts.length)unavailable();
      }else{
        if(s.segment!==0)unavailable();
        const key={key:s.collection,recordId:s.recordId,revision:s.revision};
        if(previous&&compare(previous,key)>=0)unavailable();
        // Whole records only: stop before a record that would pass the item limit or the byte budget, never before the first.
        if(items.length>=limit||(items.length>0&&itemBytes+s.payloadBytes+RECORD_OVERHEAD_BYTES>PRIVACY_EXPORT_PAGE_BYTES)){more=true;break;}
        open={first:s,parts:[]};
      }
      open.parts.push(s.bytes);
      if(open.parts.length===open.first.segmentCount){
        const item=reassemble(open.first,open.parts);
        items.push(item);itemBytes+=Buffer.byteLength(JSON.stringify(item),'utf8');
        previous={key:item.collection,recordId:item.recordId,revision:item.revision};open=null;
      }
    }
    if(more)break;
    // Every segment of the call was used: the service's cursor must name the last one, or be absent when nothing follows.
    if(value.next===null){if(open)unavailable();break;}
    const next=segmentAfter(value.next),last=segments.at(-1);
    if(!last||next.key!==last.collection||next.recordId!==last.recordId||next.revision!==last.revision||next.segment!==last.segment)unavailable();
    position=next;
    if(!open&&items.length>=limit){more=true;break;}
  }
  return {asOf:asOf!,items,next:more?previous:null};
}
function segment(raw:unknown):Segment{
  const s=object(raw);
  if(Object.keys(s).length!==SEGMENT_KEYS.length||Object.keys(s).some(k=>!SEGMENT_KEYS.includes(k)))unavailable();
  if(!OWNED_COLLECTIONS.includes(s.collection as typeof OWNED_COLLECTIONS[number])||!UUID.test(String(s.recordId))||!revision(s.revision)
    ||typeof s.deleted!=='boolean'||!revision(s.consentRevision)||!date(s.receivedAt))unavailable();
  const bound=Math.max(PAYLOAD_TOLERANCE_BYTES,ownedPayloadLimit(s.collection as string));
  if(!count(s.payloadBytes)||(s.payloadBytes as number)<2||(s.payloadBytes as number)>bound
    ||typeof s.payloadSha256!=='string'||!/^[a-f0-9]{64}$/.test(s.payloadSha256))unavailable();
  const segments=Math.ceil((s.payloadBytes as number)/PRIVACY_EXPORT_SEGMENT_BYTES);
  if(s.segmentCount!==segments||!count(s.segment)||(s.segment as number)>=segments)unavailable();
  // Strict base64: no line breaks, padding only at the end, and the bytes re-encode to exactly the text received.
  if(typeof s.data!=='string'||s.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(s.data))unavailable();
  const bytes=Buffer.from(s.data,'base64');
  if(bytes.toString('base64')!==s.data
    ||bytes.byteLength!==Math.min(PRIVACY_EXPORT_SEGMENT_BYTES,(s.payloadBytes as number)-(s.segment as number)*PRIVACY_EXPORT_SEGMENT_BYTES))unavailable();
  return {collection:s.collection as string,recordId:s.recordId as string,revision:s.revision as number,deleted:s.deleted,
    consentRevision:s.consentRevision as number,receivedAt:s.receivedAt as string,payloadBytes:s.payloadBytes as number,
    payloadSha256:s.payloadSha256,segment:s.segment as number,segmentCount:segments,bytes};
}
const sameVersion=(a:Segment,b:Segment)=>a.collection===b.collection&&a.recordId===b.recordId&&a.revision===b.revision&&a.deleted===b.deleted
  &&a.consentRevision===b.consentRevision&&a.receivedAt===b.receivedAt&&a.payloadBytes===b.payloadBytes&&a.payloadSha256===b.payloadSha256
  &&a.segmentCount===b.segmentCount;
/** The stored octets, checked for length and digest, decoded as strict UTF-8 and parsed: the same payload object the
 * deployed reader returns for a record it can page. */
function reassemble(first:Segment,parts:Buffer[]):RecordItem{
  const bytes=Buffer.concat(parts);
  if(bytes.byteLength!==first.payloadBytes||createHash('sha256').update(bytes).digest('hex')!==first.payloadSha256)unavailable();
  let payload:unknown;
  try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{unavailable();}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||(first.deleted&&Object.keys(payload).length))unavailable();
  return {collection:first.collection,recordId:first.recordId,revision:first.revision,payload:payload as Record<string,unknown>,
    deleted:first.deleted,consentRevision:first.consentRevision,receivedAt:first.receivedAt};
}
function segmentAfter(raw:unknown):After&{segment:number}{
  try{
    exact(raw,['key','recordId','revision','segment']);
    const v=raw as Record<string,unknown>;
    const record=validateAfter({key:v.key,recordId:v.recordId,revision:v.revision},'records');
    if(!count(v.segment)||(v.segment as number)>65535)invalid();
    return {...record,segment:v.segment as number};
  }catch{unavailable();}
}
function decodeCursor(cursor:unknown,exportId:string,section:PrivacyExportSection):After{
  if(typeof cursor!=='string'||!/^[A-Za-z0-9_-]{20,600}$/.test(cursor))invalid();
  try{
    const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    exact(decoded,['exportId','section','after']);
    if(decoded.exportId!==exportId||decoded.section!==section)invalid();
    return validateAfter(decoded.after,section);
  }catch{invalid();}
}
const encodeCursor=(exportId:string,section:PrivacyExportSection,after:After)=>Buffer.from(JSON.stringify({exportId,section,after})).toString('base64url');
function compare(a:After,b:After){return a.key<b.key?-1:a.key>b.key?1:(a.recordId??'')<(b.recordId??'')?-1:(a.recordId??'')>(b.recordId??'')?1:a.revision-b.revision;}
function validateAfter(raw:unknown,section:PrivacyExportSection):After{
  exact(raw,section==='records'?['key','recordId','revision']:['key','revision']);
  const v=raw as Record<string,unknown>;
  if(typeof v.key!=='string'||!revision(v.revision))invalid();
  if(section==='records'){
    if(!OWNED_COLLECTIONS.includes(v.key as typeof OWNED_COLLECTIONS[number])||typeof v.recordId!=='string'||!UUID.test(v.recordId))invalid();
    return {key:v.key,recordId:v.recordId,revision:v.revision as number};
  }
  if(!OWNED_STORAGE_SCOPES.includes(v.key as typeof OWNED_STORAGE_SCOPES[number]))invalid();
  return {key:v.key,revision:v.revision as number};
}
function date(v:unknown){return typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));}
function count(v:unknown){return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;}
function revision(v:unknown){return count(v)&&(v as number)>0&&(v as number)<2_147_483_647;}
function exact(v:unknown,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))invalid();}
function object(raw:unknown):Record<string,unknown>{try{const v=typeof raw==='string'?JSON.parse(raw):raw;if(!v||typeof v!=='object'||Array.isArray(v))unavailable();return v;}catch{unavailable();}}
function invalid():never{throw new OwnedStorageError('request_invalid');}
function unavailable():never{throw new OwnedStorageError('storage_unavailable');}
