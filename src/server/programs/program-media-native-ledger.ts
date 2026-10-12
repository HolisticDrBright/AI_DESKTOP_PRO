if(typeof window!=='undefined')throw new Error('program media native ledger is server-only');
import {z} from 'zod';
import {clinicalUuid,type ClinicalCoreDatabase,ClinicalCoreDatabaseRejection} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {PROGRAM_MEDIA_FAILURES,programMediaReservation,programMediaArtifact,programMediaText,programMediaReference,programMediaStorageSchema,programMediaExtension,
 type ProgramMediaArtifact,type ProgramMediaReservation} from '@/contracts/programMedia';
import {ProgramMediaError,type ProgramMediaLedger} from './program-media-authoring';

export const PROGRAM_MEDIA_NATIVE_LEDGER_CONTRACT='program-media-native-ledger/1' as const;
const uuid=z.string().uuid();
const versionNumber=z.number().int().safe().positive();
const envelope=z.discriminatedUnion('ok',[
 z.object({contractVersion:z.literal(PROGRAM_MEDIA_NATIVE_LEDGER_CONTRACT),ok:z.literal(true),data:z.unknown()}).strict(),
 z.object({contractVersion:z.literal(PROGRAM_MEDIA_NATIVE_LEDGER_CONTRACT),ok:z.literal(false),error:z.enum(PROGRAM_MEDIA_FAILURES)}).strict(),
]);
const config=z.object({contractVersion:z.literal(PROGRAM_MEDIA_NATIVE_LEDGER_CONTRACT),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),storage:programMediaStorageSchema}).strict();
const proof=z.object({artifactId:uuid,claimId:uuid,objectKey:z.string().min(1).max(512),checkedAt:z.string().datetime({offset:true}),
 complete:z.literal(true),remainingVersions:z.literal(0),removedVersions:z.array(z.string().min(1).max(1024)).max(1000)}).strict();
function input<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{
 const parsed=schema.safeParse(value);if(!parsed.success)throw new ProgramMediaError('request_invalid');return parsed.data;
}
function bound<T extends ProgramMediaArtifact|ProgramMediaReservation>(row:T,c:ClinicalRequestContext,id?:string,program?:string):T{
 const ext=programMediaExtension(row.kind,row.contentType);
 if(row.clinic!==c.organizationId||(id!==undefined&&row.artifactId!==id)||(program!==undefined&&row.programId!==program)
  ||!ext||row.objectKey!==`program-media/${row.clinic}/${row.programId}/${row.artifactId}/${row.sha256}.${ext}`
  ||row.bytes>(row.kind==='image'?16_777_216:268_435_456))throw new Error('invalid_reply');
 return row;
}

/** Complete, uninstalled SQL-backed source for the BLOCKED native candidate.
 * Every operation sets verified context and rechecks current DB authority in
 * one short restricted-role transaction. No store I/O runs inside it. Reply
 * shape AND owner/artifact binding are checked before transaction commit.
 * No credential or role is inferred from a previous positive permission. */
export function createProgramMediaNativeLedger(database:ClinicalCoreDatabase,reviewedRelease?:{evidenceSha256:string;storage:z.infer<typeof programMediaStorageSchema>}){
 const release=reviewedRelease?config.omit({contractVersion:true}).parse(reviewedRelease):null;
 async function call<T>(context:ClinicalRequestContext,operation:string,parameters:Record<string,unknown>,decode:(value:unknown,c:ClinicalRequestContext)=>T):Promise<T>{
  const c=Object.freeze({...context});
  if(c.identityPool!=='workforce'||c.environment!=='synthetic-staging'||c.dataClassification!=='synthetic_only'
   ||c.containsPhi!==false||c.realPatientData!==false||c.purpose!=='clinical_data')throw new ProgramMediaError('access_refused');
  const actor=uuid.safeParse(c.actorPersonId),org=uuid.safeParse(c.organizationId);
  const subject=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).safeParse(c.identitySubject);
  if(!actor.success||!org.success||!subject.success)throw new ProgramMediaError('access_refused');
  if(operation!=='configuration'&&!release)throw new ProgramMediaError('program_media_disabled');
  const request=JSON.stringify({operation,parameters,release});
  try{return await database.transaction(async tx=>{
   await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
    [clinicalUuid(actor.data),clinicalUuid(org.data),c.identityPool,subject.data,c.purpose,c.environment,c.dataClassification]);
   const rows=await tx.query<{data:unknown}>('select clinical_core.program_media_request($1::jsonb) as data',[request]);
   if(rows.rows.length!==1)throw new Error('invalid_reply');
   const raw=rows.rows[0].data;
   const answer=envelope.parse(typeof raw==='string'?JSON.parse(raw):raw);
   if(!answer.ok)throw new ProgramMediaError(answer.error);
   return decode(answer.data,c);
  });}catch(error){
   if(error instanceof ProgramMediaError)throw error;
   if(error instanceof ClinicalCoreDatabaseRejection&&error.category==='identity_refused')throw new ProgramMediaError('access_refused');
   if(error instanceof Error&&error.message==='request_context_refused')throw new ProgramMediaError('access_refused');
   throw new ProgramMediaError('service_unavailable');
  }
 }
 const readBoolean=(c:ClinicalRequestContext,op:string,p:Record<string,unknown>)=>call(c,op,p,value=>z.boolean().parse(value));
 const readArtifact=(c:ClinicalRequestContext,op:string,p:Record<string,unknown>,id:string)=>call(c,op,p,(value,ctx)=>bound(programMediaArtifact.parse(value),ctx,id));
 const execute=async(c:ClinicalRequestContext,op:string,p:Record<string,unknown>)=>{await call(c,op,p,value=>z.null().parse(value));};
 const ledger:ProgramMediaLedger&{configuration(c:ClinicalRequestContext):Promise<z.infer<typeof config>>}={
  configuration:c=>call(c,'configuration',{},value=>config.parse(value)),
  authorize:(c,programId)=>readBoolean(c,'authorize',{programId:input(uuid,programId)}),
  reserve:async(c,r)=>{
   const {replayed:_,...reservation}=input(programMediaReservation,{...r,replayed:false});
   return call(c,'reserve',{reservation},(value,ctx)=>{
    const row=bound(programMediaReservation.parse(value),ctx,undefined,reservation.programId);
    if(row.commandId!==reservation.commandId||row.kind!==reservation.kind||row.contentType!==reservation.contentType
     ||row.bytes!==reservation.bytes||row.sha256!==reservation.sha256||(!row.replayed&&row.artifactId!==reservation.artifactId))throw new Error('invalid_reply');
    return row;
   });
  },
  reservation:async(c,artifactId)=>{
   const id=input(uuid,artifactId);return call(c,'reservation',{artifactId:id},(value,ctx)=>{const row=programMediaReservation.nullable().parse(value);return row?bound(row,ctx,id):null;});
  },
  artifact:async(c,artifactId)=>{
   const id=input(uuid,artifactId);return call(c,'artifact',{artifactId:id},(value,ctx)=>{const row=programMediaArtifact.nullable().parse(value);return row?bound(row,ctx,id):null;});
  },
  commit:(c,artifactId,objectVersion,_at,claim)=>{
   const id=input(uuid,artifactId),ver=input(z.string().min(1).max(1024).refine(v=>v!=='null'),objectVersion);
   return call(c,'commit',{artifactId:id,claimId:input(uuid,claim),objectVersion:ver},(value,ctx)=>{
    const row=bound(programMediaArtifact.parse(value),ctx,id);if(row.state!=='ready'||row.objectVersion!==ver)throw new Error('invalid_reply');return row;
   });
  },
  settle:(c,id,state,failure,claim)=>execute(c,'settle',{artifactId:input(uuid,id),state:input(z.enum(['held','error','abandoned']),state),failure:input(z.string().min(1).max(80),failure),claimId:claim?input(uuid,claim):null}),
  beginWriter:(c,id,claim,mode)=>readBoolean(c,'beginWriter',{artifactId:input(uuid,id),claimId:input(uuid,claim),mode:input(z.enum(['admit','reconcile']),mode)}),
  finishWriter:(c,id,claim,outcome)=>execute(c,'finishWriter',{artifactId:input(uuid,id),claimId:input(uuid,claim),outcome:input(z.enum(['settled','uncertain']),outcome)}),
  beginCleanup:(c,id,claim)=>readBoolean(c,'beginCleanup',{artifactId:input(uuid,id),claimId:input(uuid,claim)}),
  certifyCleanup:(c,id,claim,value)=>execute(c,'certifyCleanup',{artifactId:input(uuid,id),claimId:input(uuid,claim),proof:input(proof,value)}),
  attachText:(c,id,version,slot,text)=>readArtifact(c,'attachText',{artifactId:input(uuid,id),expectedVersion:input(versionNumber,version),slot:input(z.enum(['caption','transcript']),slot),text:input(programMediaText,text)},id),
  retire:(c,id,version)=>readArtifact(c,'retire',{artifactId:input(uuid,id),expectedVersion:input(versionNumber,version)},id),
  recordPublication:(c,reference)=>execute(c,'recordPublication',{reference:input(programMediaReference,reference)}),
  hasPublication:(c,reference)=>readBoolean(c,'hasPublication',{reference:input(programMediaReference,reference)}),
  expiredReservations:async(c,programId,before)=>{
   const program=input(uuid,programId),date=input(z.string().datetime({offset:true}),before);
   return call(c,'expiredReservations',{programId:program,before:date},(value,ctx)=>{
    const rows=z.array(programMediaReservation).max(1000).parse(value);
    if(new Set(rows.map(r=>r.artifactId)).size!==rows.length)throw new Error('invalid_reply');
    for(const row of rows){bound(row,ctx,undefined,program);if(Date.parse(row.acceptBefore)>Date.parse(date))throw new Error('invalid_reply');}
    return rows;
   });
  },
 };
 return Object.freeze(ledger);
}
