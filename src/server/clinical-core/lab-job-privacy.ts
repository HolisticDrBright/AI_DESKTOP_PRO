import {createHash} from 'node:crypto';
import {z} from 'zod';

export const LAB_PRIVACY_VERSION='lab-processing-copy/1';
const uuid=z.string().uuid(),date=z.string().datetime();
const document=z.object({clientDocumentId:uuid,fileName:z.string().min(1).max(180).regex(/^[^\\/\u0000-\u001f]+\.(?:pdf|jpe?g|png)$/i),
  contentType:z.enum(['application/pdf','image/jpeg','image/png']),byteSize:z.number().int().min(1).max(25*1024*1024),
  checksumSHA256:z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),objectKey:z.string().min(1).max(1024)}).strict();
const rowSchema=z.object({pk:z.string(),ownerSub:z.string(),organizationId:uuid,personId:uuid,
  dataClassification:z.enum(['synthetic_only','personal_health_record']).optional(),state:z.enum(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','completed','needs_review','failed','deleting']),
  createdAt:date,updatedAt:date,expiresAt:z.number().int().positive(),documents:z.array(document).max(30),
  passesCompleted:z.number().int().min(0).max(5),progressPercent:z.number().int().min(0).max(100),attempt:z.number().int().nonnegative(),
  failureCategory:z.string().max(100).nullable(),result:z.unknown(),
}).passthrough();
type Scope={ownerSub:string;organizationId:string;personId:string};
type Head={ContentLength?:number;ContentType?:string;Metadata?:Record<string,string>;ChecksumSHA256?:string;ServerSideEncryption?:string;SSEKMSKeyId?:string;VersionId?:string;ETag?:string;DeleteMarker?:boolean};
export type LabPrivacyDeps={
  classification:'synthetic_only'|'personal_health_record';prefix:'synthetic-labs'|'personal-labs';kmsKeyArn:string;
  read:(id:string)=>Promise<Record<string,unknown>|undefined>;
  head:(key:string)=>Promise<Head>;
  sign:(input:{key:string;versionId:string;etag:string;contentType:string;downloadName:string;seconds:number})=>Promise<string>;
  revalidate:()=>Promise<void>;now?:()=>number;
};
export class LabPrivacyError extends Error{
  constructor(readonly code:'lab_privacy_not_found'|'lab_privacy_changed'|'lab_privacy_invalid'|'lab_document_unavailable',readonly status:number){super(code);}
}
function fail(code:LabPrivacyError['code'],status:number):never{throw new LabPrivacyError(code,status);}
const copyFields=['panelId','sourcePanel','sourcePanelSha256','sourceContextSha256','structuredBiomarkers','patientContext','longitudinalContext',
  'rangeReleaseSha256','recoveryRequest','delivery','deliveryAcknowledgment','deliveryTransfers'] as const;
/** Read-only owner copy, not a result-delivery claim, plan adoption or processor.
 * Current AI consent and Core entitlement are intentionally NOT dependencies.
 * Production caller still enforces deployment gates and active database identity.
 * It reads one retained Dynamo row consistently; it is not an all-account export. */
export function createLabJobPrivacy(deps:LabPrivacyDeps){
  if((deps.classification==='personal_health_record')!==(deps.prefix==='personal-labs'))throw new Error('lab_privacy_namespace_invalid');
  const now=deps.now??Date.now;
  async function read(scope:Scope,id:string){
    if(!uuid.safeParse(id).success)fail('lab_privacy_invalid',400);
    await deps.revalidate();const raw=await deps.read(id);
    if(!raw||raw.ownerSub!==scope.ownerSub||raw.personId!==scope.personId||raw.organizationId!==scope.organizationId
      ||(raw.dataClassification??'synthetic_only')!==deps.classification)fail('lab_privacy_not_found',404);
    const valid=rowSchema.safeParse(raw);if(!valid.success||valid.data.pk!=='job#'+id)fail('lab_privacy_invalid',503);
    const row=valid.data;
    if(row.state==='deleting')fail('lab_privacy_changed',409);
    if(new Set(row.documents.map(d=>d.clientDocumentId)).size!==row.documents.length)fail('lab_privacy_invalid',503);
    for(const d of row.documents){
      const exact=`${deps.prefix}/${scope.organizationId}/${scope.ownerSub}/${id}/${d.clientDocumentId}/${d.fileName}`;
      if(d.objectKey!==exact)fail('lab_privacy_invalid',503);
    }
    await deps.revalidate();return row;
  }
  return {
    async copy(scope:Scope,id:string){
      const row=await read(scope,id);
      const record={jobId:id,state:row.state,createdAt:row.createdAt,updatedAt:row.updatedAt,processingExpiresAt:row.expiresAt,
        passesCompleted:row.passesCompleted,progressPercent:row.progressPercent,attempt:row.attempt,failureCategory:row.failureCategory,
        result:row.result??null,documents:row.documents.map(d=>({clientDocumentId:d.clientDocumentId,fileName:d.fileName,contentType:d.contentType,
          byteSize:d.byteSize,...(d.checksumSHA256?{checksumSHA256:d.checksumSHA256}:{})})),
        ...Object.fromEntries(copyFields.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]))};
      // Whitelist record-level clinical fields; never spread Dynamo internals,
      // authorization, workflow lease tokens, S3 keys or presigned credentials.
      const json=JSON.stringify(record);if(Buffer.byteLength(json)>512*1024)fail('lab_privacy_invalid',503);
      return {contractVersion:LAB_PRIVACY_VERSION,capturedAt:new Date(now()).toISOString(),
        coverage:{completeAccountExport:false,consistency:'single_retained_job_read',
          included:['selected_job_inputs_result_document_metadata_delivery_metadata'],
          excluded:['original_document_bytes','intermediate_worker_artifacts','other_jobs_and_unindexed_history','deleted_or_expired_objects','clinic_and_other_account_stores']},
        record,recordSha256:createHash('sha256').update(json).digest('hex')};
    },
    async document(scope:Scope,id:string,documentId:string){
      if(!uuid.safeParse(documentId).success)fail('lab_privacy_invalid',400);
      const row=await read(scope,id),d=row.documents.find(d=>d.clientDocumentId===documentId);
      if(!d)fail('lab_privacy_not_found',404);
      // Legacy documents without a source checksum need separate recovery; do
      // not manufacture integrity or sign an ambiguous/unversioned object.
      if(!d.checksumSHA256)fail('lab_document_unavailable',409);
      let head:Head;
      try{head=await deps.head(d.objectKey);}catch{fail('lab_document_unavailable',503);}
      if(head.DeleteMarker||head.ContentLength!==d.byteSize||head.ContentType!==d.contentType
        ||head.ChecksumSHA256!==d.checksumSHA256||head.Metadata?.['job-id']!==id||head.Metadata?.['document-id']!==documentId
        ||head.ServerSideEncryption!=='aws:kms'||head.SSEKMSKeyId!==deps.kmsKeyArn
        ||typeof head.VersionId!=='string'||!head.VersionId||head.VersionId==='null'||head.VersionId.length>1024
        ||typeof head.ETag!=='string'||!/^"[a-f0-9-]+"$/i.test(head.ETag))fail('lab_document_unavailable',409);
      const final=await read(scope,id);
      if(JSON.stringify(final)!==JSON.stringify(row))fail('lab_privacy_changed',409);
      const extension=d.contentType==='application/pdf'?'pdf':d.contentType==='image/png'?'png':'jpg';
      const downloadName=`alp-lab-document-${documentId}.${extension}`;
      const issuedAt=now();
      const downloadUrl=await deps.sign({key:d.objectKey,versionId:head.VersionId,etag:head.ETag,contentType:d.contentType,downloadName,seconds:60});
      if(JSON.stringify(await read(scope,id))!==JSON.stringify(row)||now()>=issuedAt+60_000)fail('lab_privacy_changed',409);
      return {contractVersion:'lab-document-download/1',jobId:id,documentId,downloadName,downloadUrl,
        method:'GET',requiredHeaders:{'if-match':head.ETag},byteSize:d.byteSize,contentType:d.contentType,
        checksumSHA256:d.checksumSHA256,expiresAt:new Date(issuedAt+60_000).toISOString()};
    },
  };
}
