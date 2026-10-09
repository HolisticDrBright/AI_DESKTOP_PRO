if (typeof window !== 'undefined') throw new Error('care-erasure-intent-command is server-only');
import type {ClinicalCoreDatabase} from './database';
import type {ClinicalCoreMigration} from './migrations';
import {CARE_ERASURE_AWS,careErasureUpgradeFromAws,type CareErasureUpgradeConfiguration} from './care-erasure-schema-upgrade';
import {careErasureIntentMapping,runCareErasureIntentUpgrade,type CareErasureIntentUpgradeResult} from './care-erasure-intent-upgrade';

export class CareErasureIntentCommandError extends Error {
 constructor(readonly category:'boundary_refused'|'verification_failed'|'api_recovery_required'){super(category);}
}
export type CareErasureIntentCommandDependencies={
 observeCaller:()=>unknown;observeFoundation:()=>unknown;
 loadMigrations:()=>ClinicalCoreMigration[];loadReference:()=>ClinicalCoreMigration[];loadOverlay:()=>ClinicalCoreMigration;
 createDatabase:(configuration:CareErasureUpgradeConfiguration)=>ClinicalCoreDatabase;
 run?:typeof runCareErasureIntentUpgrade;
};
const refuse=(category:'boundary_refused'|'verification_failed'|'api_recovery_required'):never=>{
 throw new CareErasureIntentCommandError(category);
};
/** Inspection/rehearsal only. No supplied report, environment flag or confirmation
 * can replace the unimplemented real API recovery drill or authorize lasting DDL. */
export async function executeCareErasureIntentCommand(args:readonly string[],
 suppliedBuild:{sourceCommit:string;clean:boolean},d:CareErasureIntentCommandDependencies){
 const build={...suppliedBuild},[command,confirm,...extra]=args;
 if(command==='upgrade')refuse('api_recovery_required');
 if(extra.length||!['inspect','rehearse'].includes(command)||!/^[a-f0-9]{40}$/.test(build.sourceCommit)
  ||typeof build.clean!=='boolean'||command==='inspect'&&confirm!==undefined
  ||command==='rehearse'&&(!build.clean||confirm!=='--confirm-fictional-intent-rollback'))refuse('boundary_refused');
 const observe=()=>careErasureUpgradeFromAws(d.observeCaller(),d.observeFoundation());
 const configuration=observe(),m=d.loadMigrations().map(v=>({...v})),reference=d.loadReference().map(v=>({...v})),overlay={...d.loadOverlay()};
 const mapping=careErasureIntentMapping(m,reference,overlay,configuration);
 const database=d.createDatabase({...configuration}),run=d.run??runCareErasureIntentUpgrade;
 const invoke=async(mode:'inspect'|'rehearse')=>{
  const r=await run(database,m.map(v=>({...v})),reference.map(v=>({...v})),{...overlay},{...configuration},mode);
  if(r.contract!=='care-erasure-intent-upgrade/1'||r.command!==mode||r.execution!=='synthetic-staging'||r.phiAllowed!==false
   ||![47,48].includes(r.observedMigrationCount)||r.sourceMigrationCount!==r.observedMigrationCount-1
   ||r.tableCount!==r.observedMigrationCount+41||!Number.isSafeInteger(r.rowCount)||r.rowCount<0
   ||!/^[a-f0-9]{64}$/.test(r.dataSha256)||!/^[a-f0-9]{64}$/.test(r.schemaSha256)
   ||r.dataPreserved!==true||r.schemaPreserved!==true||r.applied!==false||r.alreadyApplied!==(r.observedMigrationCount===48)
   ||r.rolledBack!==(mode==='rehearse')||r.fromLedgerSha256!==mapping.liveBeforeSha256
   ||r.toLedgerSha256!==mapping.liveAfterSha256||r.referenceLedgerSha256!==mapping.referenceSha256
   ||r.canonicalRegistered!==false||r.hostedAcceptance!==false||r.recoveryAcceptance!==false||r.activationApproved!==false)
   refuse('verification_failed');
  return {...r};
 };
 const before=await invoke('inspect');
 let result:CareErasureIntentUpgradeResult=before;
 if(command==='rehearse'){
  result=await invoke('rehearse');
  const after=await invoke('inspect');
  for(const r of [result,after])for(const key of ['observedMigrationCount','sourceMigrationCount','tableCount','rowCount',
   'dataSha256','schemaSha256','alreadyApplied'] as const)if(r[key]!==before[key])refuse('verification_failed');
 }
 if(JSON.stringify(observe())!==JSON.stringify(configuration))refuse('boundary_refused');
 return {...result,operatorSource:build,awsAccountId:CARE_ERASURE_AWS.account,foundation:CARE_ERASURE_AWS.foundation,
  rollbackReadback:command==='rehearse',lastingUpgradeAvailable:false,apiDeploymentPerformed:false,
  recoveryDrillPerformed:false,acceptance:false,phiActivation:false};
}
