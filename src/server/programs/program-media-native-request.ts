if(typeof window!=='undefined')throw new Error('program media native request is server-only');
import {z} from 'zod';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import type {ClinicalCoreDatabase} from '@/server/clinical-core/database';
import {programMediaStorageSchema,programMediaPrepareRequest,programMediaReadRequest,programMediaAdmitRequest,
 programMediaTextRequest,programMediaVersionRequest,programMediaReference,type ProgramMediaStorage} from '@/contracts/programMedia';
import {ProgramMediaError,createProgramMediaAuthoring,PROGRAM_MEDIA_ACTIVATION} from './program-media-authoring';
import {createProgramMediaNativeLedger} from './program-media-native-ledger';
import {createAwsProgramMediaStoreSource,type AwsProgramMediaStoreConfiguration} from './aws-program-media-store';

const requests=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('prepare'),request:programMediaPrepareRequest}).strict(),
 z.object({operation:z.literal('admit'),request:programMediaAdmitRequest}).strict(),
 z.object({operation:z.literal('reconcile'),request:programMediaReadRequest}).strict(),
 z.object({operation:z.literal('attachText'),request:programMediaTextRequest}).strict(),
 z.object({operation:z.literal('preview'),request:programMediaReadRequest}).strict(),
 z.object({operation:z.literal('publish'),request:programMediaVersionRequest}).strict(),
 z.object({operation:z.literal('retire'),request:programMediaVersionRequest}).strict(),
 z.object({operation:z.literal('describeReference'),request:programMediaReference}).strict(),
 z.object({operation:z.literal('cleanupOrphans'),request:z.object({programId:z.string().uuid()}).strict()}).strict(),
]);
const stable=(s:ProgramMediaStorage)=>JSON.stringify([s.purpose,s.phiAllowed,s.dedicated,s.bucket,s.expectedBucketOwner,s.region,s.kmsKeyArn,s.maxImageBytes,s.maxVideoBytes,s.publicOrigin]);

/** Per-request native source, not an installed route or authorization to deploy.
 * Browser payloads cannot supply identities, review hashes, roles or storage.
 * The host must bind resolveContext to its verified MFA workforce session and
 * credentialsForProgram to its separately reviewed scoped STS authority. No
 * ambient credentials, administrative database, caller endpoint or fixture
 * fallback is created here. Activation is OFF unless explicitly supplied AND
 * independently matched to the current DB release and dedicated store. */
export function createProgramMediaNativeRequestSource(input:{
 database:ClinicalCoreDatabase;
 storage:ProgramMediaStorage;
 resolveContext:()=>Promise<ClinicalRequestContext>;
 credentialsForProgram:(scope:{clinic:string;programId:string},signal:AbortSignal)=>Promise<AwsProgramMediaStoreConfiguration>;
 activation?:{enabled:boolean;evidenceSha256:string};
}){
 const activation=Object.freeze({... (input.activation??{enabled:false,evidenceSha256:''})});
 const storage=Object.freeze(programMediaStorageSchema.parse(input.storage));
 const ledger=createProgramMediaNativeLedger(input.database,activation.enabled&&/^[a-f0-9]{64}$/.test(activation.evidenceSha256)
  ?{evidenceSha256:activation.evidenceSha256,storage}:undefined);
 return Object.freeze({
  async execute(value:unknown,requestSignal:AbortSignal,bytes?:Uint8Array){
   try{
   if(!activation.enabled)throw new ProgramMediaError('program_media_disabled');
   if(!(requestSignal instanceof AbortSignal)||requestSignal.aborted)throw new ProgramMediaError('access_refused');
   const parsed=requests.safeParse(value);if(!parsed.success)throw new ProgramMediaError('request_invalid');
   const command=structuredClone(parsed.data);
   if(command.operation==='prepare'&&command.request.bytes>(command.request.kind==='image'?storage.maxImageBytes:storage.maxVideoBytes))
    throw new ProgramMediaError('request_invalid');
   if(command.operation==='admit'&&(!(bytes instanceof Uint8Array)||bytes.byteLength!==command.request.bytes||bytes.byteLength>storage.maxVideoBytes))
    throw new ProgramMediaError('request_invalid');
   const captured=bytes===undefined?undefined:new Uint8Array(bytes);
   if((command.operation==='admit')!==(captured instanceof Uint8Array))throw new ProgramMediaError('request_invalid');
   const context=Object.freeze({...await input.resolveContext()});
   if(requestSignal.aborted)throw new ProgramMediaError('access_refused');
   const config=await ledger.configuration(context);
   if(requestSignal.aborted)throw new ProgramMediaError('access_refused');
   if(!/^[a-f0-9]{64}$/.test(activation.evidenceSha256)||config.evidenceSha256!==activation.evidenceSha256||stable(config.storage)!==stable(storage))
    throw new ProgramMediaError('storage_unverified');
   let programId:string;
   if(command.operation==='prepare'||command.operation==='cleanupOrphans')programId=command.request.programId;
   else {
    const artifactId=command.request.artifactId;
    const artifact=await ledger.artifact(context,artifactId);
    if(!artifact||artifact.clinic!==context.organizationId)throw new ProgramMediaError('not_found');
    programId=artifact.programId;
    if(command.operation==='admit'&&(captured!.byteLength> (artifact.kind==='image'?storage.maxImageBytes:storage.maxVideoBytes)
     ||artifact.bytes!==command.request.bytes||artifact.sha256!==command.request.sha256))throw new ProgramMediaError('request_invalid');
   }
   if(!await ledger.authorize(context,programId))throw new ProgramMediaError('access_refused');
   const scope=Object.freeze({clinic:context.organizationId,programId});
   if(requestSignal.aborted)throw new ProgramMediaError('access_refused');
   const storeConfig=await input.credentialsForProgram(scope,requestSignal);
   if(requestSignal.aborted)throw new ProgramMediaError('access_refused');
   if(storeConfig.scope.clinic!==scope.clinic||storeConfig.scope.programId!==scope.programId||stable(storeConfig.storage)!==stable(storage))
    throw new ProgramMediaError('storage_unverified');
   const opened=await createAwsProgramMediaStoreSource(storeConfig,requestSignal);
   try{
    const api=createProgramMediaAuthoring({ledger,store:opened.store,storage,
     activation:{enabled:true,reason:'Bound native educational-media qualification source'}});
    if(command.operation==='admit')return await api.admit(context,command.request,captured!);
    if(command.operation==='describeReference')return await api.describeReference(context,command.request);
    return await api[command.operation](context,command.request);
   }finally{opened.close();}
   }catch(error){
    if(error instanceof ProgramMediaError)throw error;
    throw new ProgramMediaError('service_unavailable');
   }
  },
  activation:()=>activation.enabled?{enabled:true,reason:'Requires current database and provider admission for every request'}:{...PROGRAM_MEDIA_ACTIVATION},
 });
}
