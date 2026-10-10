if (typeof window !== 'undefined') throw Error('fullscript-upgrade-command is server-only');
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { qualificationUpgradeFromAws, QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { assertFullscriptUpgrade, FULLSCRIPT_UPGRADE, FullscriptUpgradeError, fullscriptConsentConstraintSha256,
  runFullscriptSchemaUpgrade, type FullscriptUpgradeObservation, type FullscriptUpgradeResult } from './fullscript-schema-upgrade';

const hash=z.string().regex(/^[a-f0-9]{64}$/), commit=z.string().regex(/^[a-f0-9]{40}$/);
export const fullscriptOperatorTargetSchema=z.object({
  contract:z.literal('fullscript-upgrade-target/1'),execution:z.literal('qualification'),
  account:z.literal('588966314750'),region:z.literal('us-east-2'),foundation:z.literal(QUALIFICATION_UPGRADE_AWS.foundation),
  operatorRole:z.literal('OrganizationAccountAccessRole'),
  clusterArn:z.string().regex(/^arn:aws:rds:us-east-2:588966314750:cluster:[a-z0-9-]+$/),
  secretArn:z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9!/_+=.@-]+$/),
  qualificationDatabaseName:z.literal('clinical_core_qualification'),stagingDatabaseName:z.literal('clinical_core'),
  sourceCommit:commit,operatorSha256:hash,phiAllowed:z.literal(false),activation:z.literal('blocked'),
  fromReleaseSha256:z.enum([FULLSCRIPT_UPGRADE.parent107,FULLSCRIPT_UPGRADE.parent108]),
  toReleaseSha256:z.literal(FULLSCRIPT_UPGRADE.successor111),
  review:z.object({reviewer:z.literal('Brandon Bright'),reviewedAt:z.string().datetime(),
    scope:z.literal('fictional-schema-transition-only')}).strict(),
}).strict();
export type FullscriptOperatorTarget=z.infer<typeof fullscriptOperatorTargetSchema>;
export type FullscriptUpgradeBuild={sourceCommit:string;clean:boolean};
export type FullscriptCustodyBinding={build:FullscriptUpgradeBuild;configuration:QualificationUpgradeConfiguration;
  callerSha256:string;targetSha256:string};
export type FullscriptOperatorFence={verify:()=>Promise<void>};
export type FullscriptCustodyStage='baseline'|'rehearsal'|'write_admitted'|'write_reply'|'readback_one'|'readback_two';
export type FullscriptWriterCustody={verify:()=>Promise<void>;record:(stage:FullscriptCustodyStage,value:FullscriptUpgradeResult)=>Promise<void>;
  finding:()=>Promise<void>;settle:(value:FullscriptUpgradeResult)=>Promise<{runId:string;journalSha256:string;custodySettled:true}>};
export type FullscriptRecoveryCustody={baseline:FullscriptUpgradeResult;writeAdmitted:boolean;verify:()=>Promise<void>;
  settle:(value:FullscriptUpgradeResult)=>Promise<{runId:string;journalSha256:string;custodySettled:true;originalWriteOutcome:'unknown'}>};
export type FullscriptUpgradeDependencies={
  readTarget:(file:string)=>Buffer; operatorSha256:()=>string;
  observeCaller:()=>unknown;observeFoundation:()=>unknown;loadMigrations:()=>ClinicalCoreMigration[];
  createDatabase:(c:QualificationUpgradeConfiguration)=>ClinicalCoreDatabase;
  run?:typeof runFullscriptSchemaUpgrade;
  withFence:<T>(work:(f:FullscriptOperatorFence)=>Promise<T>)=>Promise<T>;
  createCustody:(binding:FullscriptCustodyBinding,baseline:FullscriptUpgradeResult,fence:FullscriptOperatorFence)=>Promise<FullscriptWriterCustody>;
  openRecoveryCustody:(binding:FullscriptCustodyBinding,fence:FullscriptOperatorFence)=>Promise<FullscriptRecoveryCustody>;
};
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?
  '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const fail=(category:ConstructorParameters<typeof FullscriptUpgradeError>[0],stage?:string):never=>{throw new FullscriptUpgradeError(category,stage);};
export const fullscriptParentCount=(c:QualificationUpgradeConfiguration)=>c.fromReleaseSha256===FULLSCRIPT_UPGRADE.parent107?107:108;
export function verifyFullscriptUpgradeObservation(r:FullscriptUpgradeResult,command:FullscriptUpgradeResult['command']) {
  const expected=['contract','execution','phiAllowed','activation','observedMigrationCount','historicalTableCount','rowCount','dataSha256',
    'historicalSchemaSha256','consentConstraintSha256','fromReleaseSha256','toReleaseSha256','command','applied','rolledBack',
    'dataPreserved','historicalSchemaPreserved','newTableCount','newRows'];
  const parent=r.fromReleaseSha256===FULLSCRIPT_UPGRADE.parent107?107:108;
  if(canonical(Object.keys(r).sort())!==canonical(expected.sort()) || r.contract!=='fullscript-schema-upgrade/1'
    || r.command!==command || r.execution!=='qualification' || r.phiAllowed!==false || r.activation!=='blocked'
    || r.toReleaseSha256!==FULLSCRIPT_UPGRADE.successor111 || (r.fromReleaseSha256!==FULLSCRIPT_UPGRADE.parent107 && r.fromReleaseSha256!==FULLSCRIPT_UPGRADE.parent108)
    || ![parent,...(command==='inspect-settled'||command==='upgrade'?[111]:[])].includes(r.observedMigrationCount)
    || r.historicalTableCount!==209 || !Number.isSafeInteger(r.rowCount) || r.rowCount<0
    || !/^[a-f0-9]{64}$/.test(r.dataSha256) || !/^[a-f0-9]{64}$/.test(r.historicalSchemaSha256)
    || r.consentConstraintSha256!==fullscriptConsentConstraintSha256(r.observedMigrationCount)
    || r.applied!==(command==='upgrade') || r.rolledBack!==(command==='rehearse')
    || r.dataPreserved!==true || r.historicalSchemaPreserved!==true || r.newRows!==0
    || r.newTableCount!==(r.observedMigrationCount===111?8:0) || command==='upgrade' && r.observedMigrationCount!==111)fail('verification_failed');
}
export function fullscriptPreserved(a:FullscriptUpgradeResult,b:FullscriptUpgradeResult) {
  if(a.rowCount!==b.rowCount || a.dataSha256!==b.dataSha256 || a.historicalSchemaSha256!==b.historicalSchemaSha256
    || a.fromReleaseSha256!==b.fromReleaseSha256 || a.toReleaseSha256!==b.toReleaseSha256)fail('verification_failed','preservation');
}
/** Privileged local command, not a public API. Target review binds a fictional
 * schema operation only; it is never a security/provider/retention approval. */
export async function executeFullscriptUpgradeCommand(args:readonly string[],supplied:FullscriptUpgradeBuild,d:FullscriptUpgradeDependencies) {
  const build={...supplied},[command,targetKey,file,shaKey,targetSha256,confirmation,...extra]=args;
  if(extra.length || !['inspect','rehearse','upgrade','reconcile'].includes(command) || targetKey!=='--target' || !file || !isAbsolute(file)
    || shaKey!=='--target-sha256' || !/^[a-f0-9]{64}$/.test(targetSha256??'') || !/^[a-f0-9]{40}$/.test(build.sourceCommit)
    || build.clean!==true || (command==='inspect'?confirmation!==undefined:confirmation!==(command==='reconcile'?
      '--reconcile-fictional-fullscript-upgrade':'--confirm-fictional-fullscript-upgrade')))fail('boundary_refused','arguments');
  function observe() {
    const bytes=d.readTarget(file);
    if(bytes.length<1 || bytes.length>16384 || sha(bytes)!==targetSha256)fail('boundary_refused','target_bytes');
    let raw:unknown;try{raw=JSON.parse(bytes.toString('utf8'));}catch{fail('boundary_refused','target_json');}
    // Canonical bytes reject duplicate keys, ambiguous encoding and trailing data.
    if(!Buffer.from(canonical(raw)+'\n').equals(bytes))fail('boundary_refused','target_encoding');
    const parsed=fullscriptOperatorTargetSchema.safeParse(raw);
    if(!parsed.success)return fail('boundary_refused','target_fields');const target=parsed.data;
    if(target.sourceCommit!==build.sourceCommit || target.operatorSha256!==d.operatorSha256()
      || Date.parse(target.review.reviewedAt)>Date.now())fail('boundary_refused','operator_binding');
    const caller=d.observeCaller(),c=qualificationUpgradeFromAws(caller,d.observeFoundation());
    if(!/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9_+=,.@-]+$/.test(String((caller as Record<string,unknown>).Arn)))
      fail('boundary_refused','caller_role');
    if(c.clusterArn!==target.clusterArn || c.secretArn!==target.secretArn || c.qualificationDatabaseName!==target.qualificationDatabaseName
      || c.stagingDatabaseName!==target.stagingDatabaseName)fail('boundary_refused','observed_target');
    return {callerSha256:sha(canonical(caller)),targetSha256,configuration:{...c,fromReleaseSha256:target.fromReleaseSha256,toReleaseSha256:target.toReleaseSha256}};
  }
  const target=observe(),m=d.loadMigrations().map(v=>({...v}));assertFullscriptUpgrade(target.configuration,m);
  const database=d.createDatabase({...target.configuration}),run=d.run??runFullscriptSchemaUpgrade;
  const summary={operatorSource:build,operatorScope:'prepared_qualification_only' as const,foundation:QUALIFICATION_UPGRADE_AWS.foundation,
    awsAccountId:QUALIFICATION_UPGRADE_AWS.account,targetSha256};
  const guard=()=>{if(canonical(observe())!==canonical(target))fail('boundary_refused','observations_changed');};
  const invoke=async(mode:FullscriptUpgradeResult['command'],a?:FullscriptUpgradeObservation)=>{
    const r=await run(database,m.map(v=>({...v})),{...target.configuration},mode,a?{...a}:undefined);
    verifyFullscriptUpgradeObservation(r,mode);return structuredClone(r);
  };
  if(command==='inspect'||command==='rehearse') {guard();const result=await invoke(command);guard();return {...result,...summary};}
  const binding:FullscriptCustodyBinding={...target,build};
  return d.withFence(async fence=>{
    const check=async()=>{await fence.verify();guard();await fence.verify();};
    if(command==='reconcile') {
      await check();const custody=await d.openRecoveryCustody(structuredClone(binding),fence);
      const baseline=structuredClone(custody.baseline);verifyFullscriptUpgradeObservation(baseline,'inspect-settled');
      if(baseline.observedMigrationCount!==fullscriptParentCount(target.configuration)||typeof custody.writeAdmitted!=='boolean')fail('recovery_refused');
      let observed:FullscriptUpgradeResult|undefined;
      for(let pass=0;pass<3;pass++) {
        await custody.verify();await check();const next=await invoke('inspect-settled');fullscriptPreserved(next,baseline);
        if(!custody.writeAdmitted&&next.observedMigrationCount!==baseline.observedMigrationCount
          || observed&&canonical(next)!==canonical(observed))fail('recovery_refused','readback');
        await custody.verify();await check();observed=next;
      }
      const settled=await custody.settle(observed!);
      return {contract:'fullscript-upgrade-reconciliation/1',command,execution:'qualification',...summary,...settled,
        observation:observed!.observedMigrationCount===111?'preserved_successor_observed':'preserved_predecessor_observed',
        result:observed!,repeatedReadbackVerified:true,databaseMutationPerformed:false,retryPerformed:false,phiAllowed:false,activation:'blocked'};
    }
    await check();const baseline=await invoke('inspect-settled');
    if(baseline.observedMigrationCount!==fullscriptParentCount(target.configuration))fail('history_refused');
    const custody=await d.createCustody(structuredClone(binding),baseline,fence);
    try {
      await custody.verify();await check();const rehearsal=await invoke('rehearse');fullscriptPreserved(rehearsal,baseline);
      await custody.record('rehearsal',rehearsal);await check();await custody.verify();
      await custody.record('write_admitted',rehearsal);await custody.verify();await check();
      const result=await invoke('upgrade',{...rehearsal,observedMigrationCount:fullscriptParentCount(target.configuration)});fullscriptPreserved(result,baseline);
      await custody.record('write_reply',result);
      for(const stage of ['readback_one','readback_two'] as const){await custody.verify();await check();const next=await invoke('inspect-settled');
        fullscriptPreserved(next,baseline);if(next.observedMigrationCount!==111)fail('verification_failed','readback');await custody.record(stage,next);}
      await custody.verify();await check();const settled=await custody.settle(result);
      return {...result,...summary,...settled,rehearsal:{rolledBack:true,dataSha256:rehearsal.dataSha256,historicalSchemaSha256:rehearsal.historicalSchemaSha256}};
    } catch(e) {try{await custody.finding();}catch{/* Original custody remains; no retry or retirement. */}throw e;}
  });
}
