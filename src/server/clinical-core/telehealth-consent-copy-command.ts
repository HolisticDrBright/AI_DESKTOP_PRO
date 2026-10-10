if(typeof window!=='undefined')throw Error('telehealth-consent-copy-command is server-only');
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {ClinicalCoreDatabase} from './database';
import type {ClinicalCoreMigration} from './migrations';
import type {QualificationUpgradeConfiguration} from './qualification-schema-upgrade';
import {qualificationUpgradeFromAws} from './qualification-upgrade-aws-binding';
import {telehealthConsentOperatorTargetSchema} from './telehealth-consent-upgrade-command';
import {FULLSCRIPT_CONSENT_SUCCESSOR,FULLSCRIPT_UPGRADE} from './fullscript-migration-release';
import {assertTelehealthConsentUpgrade} from './telehealth-consent-schema-upgrade';
import {CareConsentCopyError} from './care-consent-copy-registration';
import {parseTelehealthConsentCopy,runTelehealthConsentCopyRegistration,
  type TelehealthConsentCopy,type TelehealthConsentCopyReceipt} from './telehealth-consent-copy-registration';
import {inspectRetainedTelehealthConsentCopy,type RetainedTelehealthCopyObservation} from './telehealth-consent-copy-retained';

const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
export const telehealthCopyTargetSchema=telehealthConsentOperatorTargetSchema.omit({
  contract:true,review:true,fromReleaseSha256:true,toReleaseSha256:true,
}).extend({
  contract:z.literal('telehealth-consent-copy-target/112'),
  migrationReleaseSha256:z.literal(FULLSCRIPT_CONSENT_SUCCESSOR.ledger),
  copySha256:hash,artifactId:uuid,organizationId:uuid,artifactVersion:z.string().min(1).max(64),
  scope:z.literal('telehealth_recording'),contentSha256:hash,
  review:z.object({reviewer:z.literal('Brandon Bright'),reviewedAt:z.string().datetime(),
    scope:z.literal('fictional-consent-copy-registration-only')}).strict(),
}).strict();
export type TelehealthCopyBuild={sourceCommit:string;clean:boolean};
export type TelehealthCopyFence={verify:()=>Promise<void>};
export type TelehealthCopyBinding={
  build:TelehealthCopyBuild;configuration:QualificationUpgradeConfiguration;callerSha256:string;targetSha256:string;
  copySha256:string;copy:Omit<TelehealthConsentCopy,'contract'|'content'>;
};
export type TelehealthCopyStage='rehearsal'|'write_admitted'|'write_reply'|'readback_one'|'readback_two';
export type TelehealthCopyEvidence=TelehealthConsentCopyReceipt|RetainedTelehealthCopyObservation;
export type TelehealthCopyWriter={
  verify:()=>Promise<void>;record:(stage:TelehealthCopyStage,value:TelehealthCopyEvidence)=>Promise<void>;
  finding:()=>Promise<void>;
  settle:(value:TelehealthConsentCopyReceipt)=>Promise<{runId:string;journalSha256:string;custodySettled:true}>;
};
export type TelehealthCopyRecovery={
  baseline:TelehealthConsentCopyReceipt;writeAdmitted:boolean;verify:()=>Promise<void>;
  settle:(value:RetainedTelehealthCopyObservation)=>Promise<{
    runId:string;journalSha256:string;custodySettled:true;originalWriteOutcome:'unknown';
  }>;
};
export type TelehealthCopyCommandDependencies={
  readTarget:(file:string)=>Buffer;readCopy:(file:string)=>Buffer;operatorSha256:()=>string;
  observeCaller:()=>unknown;observeFoundation:()=>unknown;loadMigrations:()=>ClinicalCoreMigration[];
  createDatabase:(configuration:QualificationUpgradeConfiguration)=>ClinicalCoreDatabase;
  run?:typeof runTelehealthConsentCopyRegistration;inspectRetained?:typeof inspectRetainedTelehealthConsentCopy;
  withFence:<T>(work:(fence:TelehealthCopyFence)=>Promise<T>)=>Promise<T>;
  createCustody:(binding:TelehealthCopyBinding,baseline:TelehealthConsentCopyReceipt,fence:TelehealthCopyFence)=>Promise<TelehealthCopyWriter>;
  openRecoveryCustody:(binding:TelehealthCopyBinding,fence:TelehealthCopyFence)=>Promise<TelehealthCopyRecovery>;
};
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?
  '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const fail=(category:ConstructorParameters<typeof CareConsentCopyError>[0]):never=>{throw new CareConsentCopyError(category);};
const base={execution:z.literal('qualification'),phiAllowed:z.literal(false),activation:z.literal('blocked'),
  migrationCount:z.literal(112),migrationReleaseSha256:z.literal(FULLSCRIPT_CONSENT_SUCCESSOR.ledger),
  scope:z.literal('telehealth_recording'),artifactId:uuid,contentSha256:hash};
const receiptSchema=z.object({...base,contract:z.literal('telehealth-consent-copy-registration/112'),
  command:z.enum(['inspect','rehearse','register']),approvalsCreated:z.literal(false),grantsCreated:z.literal(false),
  copyInserted:z.boolean(),copyPresent:z.boolean(),rolledBack:z.boolean()}).strict();
const retainedSchema=z.object({...base,contract:z.literal('telehealth-consent-copy-retained-observation/112'),
  organizationId:uuid,artifactVersion:z.string(),copyPresent:z.boolean(),
  approvalAuthorityCertified:z.literal(false),databaseMutationPerformed:z.literal(false),
  retryPerformed:z.literal(false),deletionCertified:z.literal(false)}).strict();
const settlementSchema=z.object({runId:z.string().regex(/^[a-f0-9]{32}$/),journalSha256:hash,custodySettled:z.literal(true)}).strict();
export function verifyTelehealthCopyReceipt(value:TelehealthConsentCopyReceipt,command:'inspect'|'rehearse'|'register',copy:TelehealthConsentCopy){
  const parsed=receiptSchema.safeParse(value);
  if(!parsed.success||value.command!==command||value.artifactId!==copy.artifactId||value.contentSha256!==copy.contentSha256
    ||value.rolledBack!==(command==='rehearse')||command!=='register'&&value.copyInserted
    ||command==='register'&&!value.copyPresent)fail('verification_failed');
}
export function verifyRetainedTelehealthCopy(value:RetainedTelehealthCopyObservation,copy:TelehealthConsentCopy){
  const parsed=retainedSchema.safeParse(value);
  if(!parsed.success||value.artifactId!==copy.artifactId||value.organizationId!==copy.organizationId
    ||value.artifactVersion!==copy.artifactVersion||value.contentSha256!==copy.contentSha256)fail('verification_failed');
}
function readCanonical(bytes:Buffer,digest:string,maximum:number):unknown{
  if(bytes.length<1||bytes.length>maximum||sha(bytes)!==digest)fail('target_refused');
  let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{return fail('target_refused');}
  if(!bytes.equals(Buffer.from(canonical(value)+'\n')))fail('target_refused');
  return value;
}
/** Orchestration source only until fixed native ports/custody and an exact
 * embedded clean builder are supplied. Never borrow a schema-only review. */
export async function executeTelehealthCopyCommand(args:readonly string[],supplied:TelehealthCopyBuild,d:TelehealthCopyCommandDependencies){
  const build={...supplied},[command,targetKey,targetFile,shaKey,targetSha256,copyKey,copyFile,copyShaKey,copySha256,confirmation,...extra]=args;
  if(extra.length||!['inspect','rehearse','register','reconcile'].includes(command)||targetKey!=='--target'
    ||!targetFile||!isAbsolute(targetFile)||shaKey!=='--target-sha256'||!/^[a-f0-9]{64}$/.test(targetSha256??'')
    ||copyKey!=='--copy'||!copyFile||!isAbsolute(copyFile)||copyShaKey!=='--copy-sha256'||!/^[a-f0-9]{64}$/.test(copySha256??'')
    ||build.clean!==true||!/^[a-f0-9]{40}$/.test(build.sourceCommit)
    ||(command==='inspect'?confirmation!==undefined:confirmation!==(command==='reconcile'?
      '--reconcile-fictional-telehealth-copy':'--confirm-fictional-telehealth-copy')))fail('target_refused');
  function observe(){
    const raw=readCanonical(d.readTarget(targetFile),targetSha256,16384),parsed=telehealthCopyTargetSchema.safeParse(raw);
    if(!parsed.success)return fail('target_refused');const target=parsed.data;
    const copy=parseTelehealthConsentCopy(readCanonical(d.readCopy(copyFile),copySha256,131072));
    if(target.sourceCommit!==build.sourceCommit||target.operatorSha256!==d.operatorSha256()
      ||Date.parse(target.review.reviewedAt)>Date.now()||target.copySha256!==copySha256
      ||target.artifactId!==copy.artifactId||target.organizationId!==copy.organizationId
      ||target.artifactVersion!==copy.artifactVersion||target.scope!==copy.scope||target.contentSha256!==copy.contentSha256)fail('target_refused');
    const caller=d.observeCaller(),c=qualificationUpgradeFromAws(caller,d.observeFoundation());
    if(!/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9_+=,.@-]+$/.test(String((caller as Record<string,unknown>).Arn))
      ||c.clusterArn!==target.clusterArn||c.secretArn!==target.secretArn
      ||c.qualificationDatabaseName!==target.qualificationDatabaseName||c.stagingDatabaseName!==target.stagingDatabaseName)fail('target_refused');
    return {copy,callerSha256:sha(canonical(caller)),configuration:{...c,
      fromReleaseSha256:FULLSCRIPT_UPGRADE.successor111,
      toReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger}};
  }
  const observation=observe(),m=d.loadMigrations().map(v=>({...v}));assertTelehealthConsentUpgrade(observation.configuration,m);
  const database=d.createDatabase({...observation.configuration}),run=d.run??runTelehealthConsentCopyRegistration,
    inspect=d.inspectRetained??inspectRetainedTelehealthConsentCopy;
  const guard=()=>{if(canonical(observe())!==canonical(observation))fail('target_refused');};
  const invoke=async(mode:'inspect'|'rehearse'|'register')=>{
    const value=await run(database,m.map(v=>({...v})),{...observation.configuration},mode,{...observation.copy});
    verifyTelehealthCopyReceipt(value,mode,observation.copy);return structuredClone(value);
  };
  const retained=async()=>{
    const value=await inspect(database,m.map(v=>({...v})),{...observation.configuration},{...observation.copy});
    verifyRetainedTelehealthCopy(value,observation.copy);return structuredClone(value);
  };
  const summary={operatorSource:build,operatorScope:'prepared_qualification_only' as const,targetSha256,copySha256,
    awsAccountId:'588966314750',foundation:'ai-clinical-core-qualification-foundation'};
  if(command==='inspect'||command==='rehearse'){guard();const result=await invoke(command);guard();return {...result,...summary};}
  const {content:_content,contract:_contract,...copyBinding}=observation.copy;
  const binding:TelehealthCopyBinding={build,configuration:observation.configuration,callerSha256:observation.callerSha256,targetSha256,copySha256,copy:copyBinding};
  return d.withFence(async fence=>{
    const check=async()=>{await fence.verify();guard();await fence.verify();};
    if(command==='reconcile'){
      await check();const custody=await d.openRecoveryCustody(structuredClone(binding),fence);
      const baseline=structuredClone(custody.baseline);verifyTelehealthCopyReceipt(baseline,'inspect',observation.copy);
      if(typeof custody.writeAdmitted!=='boolean')fail('verification_failed');
      let value:RetainedTelehealthCopyObservation|undefined;
      for(let pass=0;pass<3;pass++){
        await custody.verify();await check();const next=await retained();
        if(baseline.copyPresent&&!next.copyPresent||!custody.writeAdmitted&&next.copyPresent!==baseline.copyPresent
          ||value&&canonical(value)!==canonical(next))fail('verification_failed');
        await custody.verify();await check();value=next;
      }
      const settled=await custody.settle(value!);
      if(!settlementSchema.extend({originalWriteOutcome:z.literal('unknown')}).safeParse(settled).success)fail('verification_failed');
      return {contract:'telehealth-consent-copy-reconciliation/112',command,execution:'qualification',...summary,...settled,
        observation:value!.copyPresent?'exact_retained_copy_observed':'copy_absence_observed',result:value!,
        repeatedReadbackVerified:true,databaseMutationPerformed:false,retryPerformed:false,
        approvalAuthorityCertified:false,deletionCertified:false,phiAllowed:false,activation:'blocked'};
    }
    await check();const baseline=await invoke('inspect');
    const custody=await d.createCustody(structuredClone(binding),baseline,fence);
    try{
      await custody.verify();await check();const rehearsal=await invoke('rehearse');
      if(rehearsal.copyPresent!==baseline.copyPresent)fail('verification_failed');
      await custody.record('rehearsal',rehearsal);await custody.verify();await check();
      await custody.record('write_admitted',rehearsal);await custody.verify();await check();
      const result=await invoke('register');
      if(result.copyInserted===baseline.copyPresent)fail('verification_failed');
      await custody.record('write_reply',result);
      for(const stage of ['readback_one','readback_two'] as const){
        await custody.verify();await check();const next=await retained();if(!next.copyPresent)fail('verification_failed');
        await custody.record(stage,next);
      }
      await custody.verify();await check();const settled=await custody.settle(result);
      if(!settlementSchema.safeParse(settled).success)fail('verification_failed');
      return {...result,...summary,...settled,authorityAtReadbackNotCertified:true,
        rehearsal:{rolledBack:true,copyPresent:rehearsal.copyPresent}};
    }catch(error){try{await custody.finding();}catch{/* Original custody retained; never retry. */}throw error;}
  });
}
