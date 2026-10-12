if(typeof window!=='undefined')throw new Error('program media multipart ledger is server-only');
import {z} from 'zod';
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {programMediaStorageSchema,programMediaExtension,PROGRAM_MEDIA_FAILURES,type ProgramMediaStorage} from '@/contracts/programMedia';
import {ProgramMediaError} from './program-media-authoring';
import {programMediaPartManifest,programMediaCompositeChecksum} from './program-media-parts';

export const PROGRAM_MEDIA_MULTIPART_LEDGER_CONTRACT='program-media-multipart-ledger/1' as const;
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const checksum=z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const providerId=z.string().min(1).max(1024),objectVersion=providerId.refine(s=>s!=='null');
const partNumber=z.number().int().min(1).max(32),bytes=z.number().int().safe().min(1).max(268435456);
const ref=z.object({artifactId:uuid}).strict(),claim=ref.extend({claimId:uuid});
const partReceipt=z.object({bytes:z.number().int().min(1).max(8388608),checksum,etag:providerId}).strict();
const wholeProof=z.object({objectVersion,checksum:z.string().regex(/^[A-Za-z0-9+/]{43}=-(?:[1-9]|[12][0-9]|3[0-2])$/),sha256:digest,bytes}).strict();
const absenceProof=z.object({complete:z.literal(true),remainingUploads:z.literal(0),remainingVersions:z.literal(0),
 checkedAt:z.string().datetime({offset:true}),objectKey:z.string().min(1).max(512)}).strict();
const command=<O extends string,S extends z.ZodType>(operation:O,parameters:S)=>z.object({operation:z.literal(operation),parameters}).strict();
export const programMediaMultipartCommand=z.discriminatedUnion('operation',[
 command('start',ref.extend({manifest:programMediaPartManifest,writerClaimId:uuid})),
 command('status',ref),command('cancel',ref),
 command('admitCreation',claim),command('recordUpload',claim.extend({uploadId:providerId})),
 command('admitPart',claim.extend({partNumber})),command('recordPart',claim.extend({partNumber,receipt:partReceipt})),
 command('admitCompletion',claim),command('recordCompletion',claim.extend({objectVersion,checksum:wholeProof.shape.checksum})),
 command('settleAttempt',claim.extend({outcome:z.enum(['uncertain','not_sent','failed_before_mutation'])})),
 command('commit',ref.extend({proof:wholeProof})),command('certifyAbort',ref.extend({proof:absenceProof})),
]);
export type ProgramMediaMultipartCommand=z.infer<typeof programMediaMultipartCommand>;
export const programMediaMultipartSessionSchema=z.object({
 artifactId:uuid,clinic:uuid,programId:uuid,actorId:uuid,writerClaimId:uuid,kind:z.literal('video'),
 contentType:z.enum(['video/mp4','video/webm']),sha256:digest,totalBytes:bytes,objectKey:z.string().min(1).max(512),
 acceptBefore:z.string().datetime({offset:true}),manifest:programMediaPartManifest,checksum:wholeProof.shape.checksum,
 uploadId:providerId.nullable(),objectVersion:objectVersion.nullable(),
 state:z.enum(['prepared','creation_admitted','uploading','completion_admitted','verifying','abort_requested','committed','aborted']),
 parts:z.array(partReceipt.extend({partNumber,sha256:digest})).max(32),
 pending:z.array(z.object({claimId:uuid,kind:z.enum(['creation','part','completion']),partNumber:partNumber.nullable(),state:z.enum(['open','uncertain'])}).strict()).max(34),
}).strict();
export type ProgramMediaMultipartSession=z.infer<typeof programMediaMultipartSessionSchema>;
const response=z.object({session:programMediaMultipartSessionSchema,admitted:z.boolean()}).strict();
const envelope=z.discriminatedUnion('ok',[
 z.object({contractVersion:z.literal(PROGRAM_MEDIA_MULTIPART_LEDGER_CONTRACT),ok:z.literal(true),data:z.unknown()}).strict(),
 z.object({contractVersion:z.literal(PROGRAM_MEDIA_MULTIPART_LEDGER_CONTRACT),ok:z.literal(false),error:z.enum(PROGRAM_MEDIA_FAILURES)}).strict(),
]);

/** Internal restricted ledger port, not a browser command or installed route.
 * Provider calls require admitted:true on the FIRST durable response. A replay
 * or uncertain intent must be observed/reconciled, never blindly reissued.
 * Receipt/proof commands are qualified-host-only observations, not client
 * declarations. This source does not perform provider I/O or verify a stream. */
export function createProgramMediaMultipartLedger(
 database:ClinicalCoreDatabase,
 reviewedRelease?:{evidenceSha256:string;storage:ProgramMediaStorage},
 activation?:{enabled:boolean;evidenceSha256:string},
){
 const release=reviewedRelease?z.object({evidenceSha256:digest,storage:programMediaStorageSchema}).strict().parse(reviewedRelease):null;
 const enabled=activation?.enabled===true;
 const evidence=digest.safeParse(activation?.evidenceSha256);
 async function execute(context:ClinicalRequestContext,value:unknown){
  if(!enabled||!release||!evidence.success)throw new ProgramMediaError('program_media_disabled');
  const c=Object.freeze({...context});
  if(c.identityPool!=='workforce'||c.environment!=='synthetic-staging'||c.dataClassification!=='synthetic_only'
   ||c.containsPhi!==false||c.realPatientData!==false||c.purpose!=='clinical_data'
   ||!uuid.safeParse(c.actorPersonId).success||!uuid.safeParse(c.organizationId).success
   ||!z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).safeParse(c.identitySubject).success)throw new ProgramMediaError('access_refused');
  const parsed=programMediaMultipartCommand.safeParse(value);
  if(!parsed.success)throw new ProgramMediaError('request_invalid');
  const input=parsed.data,request=JSON.stringify({...input,release,multipartEvidenceSha256:evidence.data});
  try{return await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
    [clinicalUuid(c.actorPersonId),clinicalUuid(c.organizationId),c.identityPool,c.identitySubject,c.purpose,c.environment,c.dataClassification]);
   const rows=await tx.query<{data:unknown}>('select clinical_core.program_media_multipart_request($1::jsonb) as data',[request]);
   if(rows.rows.length!==1)throw new Error('invalid_reply');
   const raw=rows.rows[0].data,answer=envelope.parse(typeof raw==='string'?JSON.parse(raw):raw);
   if(!answer.ok)throw new ProgramMediaError(answer.error);
   const result=response.parse(answer.data),s=result.session;
   const extension=programMediaExtension(s.kind,s.contentType);
   if(s.artifactId!==input.parameters.artifactId||s.clinic!==c.organizationId||s.actorId!==c.actorPersonId
    ||s.totalBytes!==s.manifest.totalBytes||s.totalBytes>release.storage.maxVideoBytes
    ||s.checksum!==programMediaCompositeChecksum(s.manifest)||!extension
    ||s.objectKey!=='program-media/'+s.clinic+'/'+s.programId+'/'+s.artifactId+'/'+s.sha256+'.'+extension
    ||(result.admitted&&!['start','admitCreation','admitPart','admitCompletion'].includes(input.operation))
    ||(input.operation==='start'&&(JSON.stringify(s.manifest)!==JSON.stringify(input.parameters.manifest)
     ||(result.admitted&&s.writerClaimId!==input.parameters.writerClaimId))))throw new Error('invalid_reply');
   const numbered=new Set<number>(),pending=new Set<string>(),claims=new Set<string>();
   for(const part of s.parts){
    const expected=s.manifest.parts[part.partNumber-1];
    if(numbered.has(part.partNumber)||!expected||part.bytes!==expected.bytes||part.sha256!==expected.sha256
     ||part.checksum!==Buffer.from(expected.sha256,'hex').toString('base64'))throw new Error('invalid_reply');
    numbered.add(part.partNumber);
   }
   for(const attempt of s.pending){
    const key=attempt.kind+':'+attempt.partNumber;
    if(pending.has(key)||claims.has(attempt.claimId)||(attempt.kind==='part')!==(attempt.partNumber!==null)
     ||(attempt.partNumber!==null&&!s.manifest.parts[attempt.partNumber-1]))throw new Error('invalid_reply');
    pending.add(key);
    claims.add(attempt.claimId);
   }
   if(['verifying','committed'].includes(s.state)&&(s.pending.length>0||s.parts.length!==s.manifest.parts.length||s.objectVersion===null))throw new Error('invalid_reply');
   if((input.operation==='recordUpload'&&s.uploadId!==input.parameters.uploadId)
    ||(input.operation==='recordCompletion'&&(s.objectVersion!==input.parameters.objectVersion||s.checksum!==input.parameters.checksum))
    ||(input.operation==='commit'&&(s.state!=='committed'||s.objectVersion!==input.parameters.proof.objectVersion
     ||s.sha256!==input.parameters.proof.sha256||s.totalBytes!==input.parameters.proof.bytes||s.checksum!==input.parameters.proof.checksum))
    ||(input.operation==='cancel'&&!['abort_requested','aborted'].includes(s.state))
    ||(input.operation==='certifyAbort'&&s.state!=='aborted'))throw new Error('invalid_reply');
   if(input.operation==='recordPart'){
    const {partNumber,claimId,receipt}=input.parameters,part=s.parts.find(p=>p.partNumber===partNumber);
    if(!part||part.bytes!==receipt.bytes||part.checksum!==receipt.checksum||part.etag!==receipt.etag
     ||s.pending.some(p=>p.claimId===claimId))throw new Error('invalid_reply');
   }
   if(result.admitted&&input.operation==='start'&&(s.state!=='prepared'||s.uploadId!==null
    ||s.objectVersion!==null||s.parts.length!==0||s.pending.length!==0))throw new Error('invalid_reply');
   if(result.admitted&&['admitCreation','admitPart','admitCompletion'].includes(input.operation)){
    if(!('claimId' in input.parameters))throw new Error('invalid_reply');
    const claimId=input.parameters.claimId;
    const kind=input.operation==='admitCreation'?'creation':input.operation==='admitPart'?'part':'completion';
    const expectedPart=input.operation==='admitPart'?input.parameters.partNumber:null;
    const expectedState=input.operation==='admitCreation'?'creation_admitted':input.operation==='admitPart'?'uploading':'completion_admitted';
    if(s.state!==expectedState||!s.pending.some(p=>p.claimId===claimId&&p.kind===kind
     &&p.partNumber===expectedPart&&p.state==='open')||s.objectVersion!==null
     ||(input.operation==='admitCreation'&&(s.uploadId!==null||s.parts.length!==0||s.pending.length!==1))
     ||(input.operation!=='admitCreation'&&s.uploadId===null)
     ||(input.operation==='admitPart'&&s.parts.some(p=>p.partNumber===expectedPart))
     ||(input.operation==='admitCompletion'&&(s.parts.length!==s.manifest.parts.length||s.pending.length!==1)))throw new Error('invalid_reply');
   }
   return result;
  });}catch(error){
   if(error instanceof ProgramMediaError)throw error;
   if(error instanceof ClinicalCoreDatabaseRejection&&error.category==='identity_refused')throw new ProgramMediaError('access_refused');
   if(error instanceof Error&&error.message==='request_context_refused')throw new ProgramMediaError('access_refused');
   throw new ProgramMediaError('service_unavailable');
  }
 }
 return Object.freeze({execute});
}
