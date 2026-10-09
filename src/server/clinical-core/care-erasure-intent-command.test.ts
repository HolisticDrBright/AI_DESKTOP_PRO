import {describe,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadClinicalCoreMigrations} from './migrations';
import {loadGovernedCatalogMigrations} from './catalog-migrations';
import {CARE_ERASURE_AWS,CARE_ERASURE_UPGRADE} from './care-erasure-schema-upgrade';
import {CARE_ERASURE_INTENT_UPGRADE,CareErasureIntentUpgradeError,type CareErasureIntentUpgradeResult} from './care-erasure-intent-upgrade';
import {executeCareErasureIntentCommand,type CareErasureIntentCommandDependencies} from './care-erasure-intent-command';
const a=CARE_ERASURE_AWS,build={sourceCommit:'a'.repeat(40),clean:true};
const caller={Account:a.account,Arn:`arn:aws:sts::${a.account}:assumed-role/FictionalOperator/session`};
const stack={StackStatus:'UPDATE_COMPLETE',StackId:`arn:aws:cloudformation:${a.region}:${a.account}:stack/${a.foundation}/fictional`,
 Outputs:Object.entries({PhiAllowed:'false',Environment:'synthetic-staging',DataClassification:'synthetic_only',DatabaseName:a.databaseName,
  ClinicalApiId:a.apiId,DatabaseClusterArn:a.clusterArn,DatabaseSecretArn:a.secretArn}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))};
function overlay(){const sql=readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8').replace(/\r\n?/g,'\n');
 return {version:CARE_ERASURE_INTENT_UPGRADE.version,name:CARE_ERASURE_INTENT_UPGRADE.name,sql,sha256:CARE_ERASURE_INTENT_UPGRADE.sqlSha256};}
function result(command:'inspect'|'rehearse'|'upgrade',successor=false):CareErasureIntentUpgradeResult{
 return {contract:'care-erasure-intent-upgrade/1',command,execution:'synthetic-staging',phiAllowed:false,
  observedMigrationCount:successor?48:47,sourceMigrationCount:successor?47:46,tableCount:successor?89:88,rowCount:10,
  dataSha256:'b'.repeat(64),schemaSha256:'c'.repeat(64),dataPreserved:true,schemaPreserved:true,applied:false,
  originalDataSha256:'b'.repeat(64),originalRowCount:10,completeDataSha256:'b'.repeat(64),completeRowCount:10,intentRowCount:0,
  alreadyApplied:successor,rolledBack:command==='rehearse',fromLedgerSha256:CARE_ERASURE_UPGRADE.liveAfter,
  toLedgerSha256:'447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50',referenceLedgerSha256:CARE_ERASURE_UPGRADE.reference,
  canonicalRegistered:false,hostedAcceptance:false,recoveryAcceptance:false,activationApproved:false};
}
function dependencies(successor=false){
 const events:string[]=[],d:CareErasureIntentCommandDependencies={
  observeCaller:vi.fn(()=>{events.push('caller');return structuredClone(caller);}),
  observeFoundation:vi.fn(()=>{events.push('foundation');return {Stacks:[structuredClone(stack)]};}),
  loadMigrations:()=>loadClinicalCoreMigrations().slice(0,46),loadReference:loadGovernedCatalogMigrations,loadOverlay:overlay,
  createDatabase:vi.fn(()=>{events.push('client');return {transaction:async()=>{throw Error('unexpected');}};}),
  run:vi.fn(async(_db,_m,_ref,_overlay,_c,command)=>{events.push(command);return result(command,successor);}),
 };return {d,events};
}
describe('fixed intent inspection and rollback executable, fictional transports only',()=>{
 it('embeds exact artifacts and refuses lasting upgrade or overrides before AWS is invoked',()=>{
  execFileSync(process.execPath,['scripts/build-care-erasure-intent-operator.mjs','--historical-source-only'],{encoding:'utf8',timeout:30000});
  const dir='dist/aws-clinical-core/care-erasure-intent-operator/',bytes=readFileSync(dir+'index.cjs');
  const manifest=JSON.parse(readFileSync(dir+'artifact-manifest.json','utf8'));
  expect(manifest).toMatchObject({embeddedMigrations:true,embeddedReferenceMigrations:true,embeddedOverlay:true,targetOverrides:false,
   inspectionAvailable:true,rollbackRehearsalAvailable:true,lastingUpgradeAvailable:false,apiRecoveryRequired:true,
   canonicalRegistered:false,phiAllowed:false,migrationPerformed:false,hostedAcceptance:false});
  expect(manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(manifest.releaseMapping).toMatchObject({sourceBeforeCount:46,sourceAfterCount:47,liveBeforeCount:47,liveAfterCount:48});
  expect(bytes.toString()).toContain(CARE_ERASURE_INTENT_UPGRADE.sqlSha256);
  for(const [args,error] of [[['upgrade','--confirm-fictional-intent-rollback'],'api_recovery_required'],
   [['inspect','--database=clinical_core_qualification'],'boundary_refused']] as const){
   try{execFileSync(process.execPath,[dir+'index.cjs',...args],{encoding:'utf8',timeout:10000,stdio:'pipe'});throw Error('unexpected success');}
   catch(e){expect(e).toHaveProperty('status',1);expect(String((e as {stderr:string}).stderr).trim()).toBe(error);}
  }
 },40000);
 it('does not accept a review/report/environment override or any route to upgrade',async()=>{
  for(const args of [[],['apply'],['rehearse'],['inspect','--confirm-fictional-intent-rollback'],
   ['inspect','--profile=other'],['inspect','--recovery-report=pass.json'],['rehearse','--confirm-fictional-intent-rollback','--skip-readback']]){
   const {d,events}=dependencies();await expect(executeCareErasureIntentCommand(args,build,d)).rejects.toThrow('boundary_refused');expect(events).toEqual([]);
  }
  for(const args of [['upgrade'],['upgrade','--confirm-fictional-intent-rollback'],['upgrade','--recovery-approved=true']]){
   const {d,events}=dependencies();await expect(executeCareErasureIntentCommand(args,build,d)).rejects.toThrow('api_recovery_required');expect(events).toEqual([]);
  }
 });
 it('refuses a dirty rollback build or invalid source identity before observation',async()=>{
  for(const patch of [{clean:false},{clean:'true'},{sourceCommit:'main'}]){
   const {d,events}=dependencies();await expect(executeCareErasureIntentCommand(['rehearse','--confirm-fictional-intent-rollback'],
    {...build,...patch} as typeof build,d)).rejects.toThrow('boundary_refused');expect(events).toEqual([]);
  }
 });
 it('refuses root, wrong account, unfinished foundation and each missing or changed fixed output before opening a database',async()=>{
  for(const patch of [{Account:'173535830222'},{Arn:`arn:aws:iam::${a.account}:root`},{Arn:`arn:aws:iam::${a.account}:user/test`}]){
   const {d}=dependencies();d.observeCaller=()=>({...caller,...patch});
   await expect(executeCareErasureIntentCommand(['inspect'],build,d)).rejects.toThrow('boundary_refused');expect(d.createDatabase).not.toHaveBeenCalled();
  }
  for(const output of stack.Outputs)for(const value of ['',output.OutputKey==='PhiAllowed'?'true':'other']){
   const {d}=dependencies(),s=structuredClone(stack);s.Outputs.find(v=>v.OutputKey===output.OutputKey)!.OutputValue=value;
   d.observeFoundation=()=>({Stacks:[s]});await expect(executeCareErasureIntentCommand(['inspect'],build,d)).rejects.toThrow('boundary_refused');
   expect(d.createDatabase).not.toHaveBeenCalled();
  }
  const {d}=dependencies();d.observeFoundation=()=>({Stacks:[{...stack,StackStatus:'UPDATE_IN_PROGRESS'}]});
  await expect(executeCareErasureIntentCommand(['inspect'],build,d)).rejects.toThrow('boundary_refused');expect(d.createDatabase).not.toHaveBeenCalled();
 });
 it('refuses changed parent, reference or overlay artifacts before database creation',async()=>{
  for(const kind of ['parent','reference','overlay']){
   const {d}=dependencies();
   if(kind==='parent')d.loadMigrations=()=>loadClinicalCoreMigrations().slice(0,45);
   if(kind==='reference')d.loadReference=()=>loadGovernedCatalogMigrations().slice(0,-1);
   if(kind==='overlay')d.loadOverlay=()=>({...overlay(),sql:overlay().sql+'-- drift\n'});
   await expect(executeCareErasureIntentCommand(['inspect'],build,d)).rejects.toThrow('artifact_refused');expect(d.createDatabase).not.toHaveBeenCalled();
  }
 });
 it.each([false,true])('only inspects; rollback re-reads the entire admitted state and freshly checks AWS, successor=%s',async successor=>{
  const inspection=dependencies(successor);
  expect(await executeCareErasureIntentCommand(['inspect'],{...build,clean:false},inspection.d)).toMatchObject({applied:false,acceptance:false,
   operatorSource:{clean:false},lastingUpgradeAvailable:false,recoveryDrillPerformed:false});
  expect(inspection.events).toEqual(['caller','foundation','client','inspect','caller','foundation']);
  const {d,events}=dependencies(successor);
  expect(await executeCareErasureIntentCommand(['rehearse','--confirm-fictional-intent-rollback'],build,d)).toMatchObject({rolledBack:true,
   rollbackReadback:true,applied:false,hostedAcceptance:false,recoveryAcceptance:false,phiActivation:false});
  expect(events).toEqual(['caller','foundation','client','inspect','rehearse','inspect','caller','foundation']);
 });
 it('refuses malformed or approval-claiming results, including before any rollback begins',async()=>{
  for(const patch of [{contract:'other'},{command:'upgrade'},{execution:'qualification'},{phiAllowed:true},{observedMigrationCount:46},
   {sourceMigrationCount:47},{tableCount:87},{rowCount:-1},{rowCount:1.5},{dataSha256:'wrong'},{schemaSha256:'wrong'},
   {dataPreserved:false},{schemaPreserved:false},{applied:true},{alreadyApplied:true},{rolledBack:true},
   {fromLedgerSha256:'d'.repeat(64)},{toLedgerSha256:'d'.repeat(64)},{referenceLedgerSha256:'d'.repeat(64)},
   {canonicalRegistered:true},{hostedAcceptance:true},{recoveryAcceptance:true},{activationApproved:true}]){
   const {d,events}=dependencies();d.run=vi.fn(async()=>({...result('inspect'),...patch} as CareErasureIntentUpgradeResult));
   await expect(executeCareErasureIntentCommand(['rehearse','--confirm-fictional-intent-rollback'],build,d)).rejects.toThrow('verification_failed');
   expect(events).not.toContain('rehearse');
  }
 });
 it('refuses changed row content, counts, schema or history during rollback/readback',async()=>{
  for(const changedMode of ['rehearse','inspect'])for(const patch of [{dataSha256:'d'.repeat(64)},{schemaSha256:'d'.repeat(64)},
   {rowCount:11},{observedMigrationCount:48,sourceMigrationCount:47,tableCount:89,alreadyApplied:true}]){
   const {d}=dependencies();let calls=0;
   d.run=vi.fn(async(_db,_m,_ref,_overlay,_c,command)=>{calls++;return {...result(command),...(calls>1&&command===changedMode?patch:{})} as CareErasureIntentUpgradeResult;});
   await expect(executeCareErasureIntentCommand(['rehearse','--confirm-fictional-intent-rollback'],build,d)).rejects.toThrow('verification_failed');
  }
 });
 it('a missing terminal parent is a refusal, not an inferred or automatic parent upgrade',async()=>{
  const {d,events}=dependencies();d.run=vi.fn(async()=>{throw new CareErasureIntentUpgradeError('history_refused','history');});
  await expect(executeCareErasureIntentCommand(['inspect'],build,d)).rejects.toMatchObject({category:'history_refused',stage:'history'});
  expect(events).not.toContain('rehearse');
 });
 it('refuses target drift on the final observation instead of emitting qualification evidence',async()=>{
  const {d}=dependencies();let reads=0;d.observeFoundation=()=>({Stacks:[{...stack,StackStatus:++reads===1?'UPDATE_COMPLETE':'UPDATE_IN_PROGRESS'}]});
  await expect(executeCareErasureIntentCommand(['rehearse','--confirm-fictional-intent-rollback'],build,d)).rejects.toThrow('boundary_refused');
 });
});
