import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { clinicalUuid, type ClinicalCoreTransaction } from './database';
import { OwnedStorageError, OWNED_STORAGE_SCOPES } from './owned-consumer-records';
import { OWNED_COLLECTIONS } from './owned-lab-observations';

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

export function createOwnedPrivacyExport(run:Run){
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
      if(input.cursor!==undefined){
        if(typeof input.cursor!=='string'||!/^[A-Za-z0-9_-]{20,600}$/.test(input.cursor))invalid();
        try{
          const decoded=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          exact(decoded,['exportId','section','after']);
          if(decoded.exportId!==input.exportId||decoded.section!==input.section)invalid();
          after=validateAfter(decoded.after,input.section);
        }catch{invalid();}
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
            if(Buffer.byteLength(JSON.stringify(payload),'utf8')>32768 || (r.deleted&&Object.keys(payload).length))unavailable();
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
          nextCursor:next?Buffer.from(JSON.stringify({exportId:input.exportId,section:input.section,after:next})).toString('base64url'):null};
      });
    },
  };
}
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
