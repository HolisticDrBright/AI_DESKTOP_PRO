import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {inventorySourceIdentity} from './inventory-qualification-source.mjs';
let directory,manifest;
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?
  '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
before(()=>{
  directory=mkdtempSync(join(tmpdir(),'alp-consent-upgrade-artifact-'));
  execFileSync(process.execPath,['scripts/build-telehealth-consent-upgrade.mjs',`--out-dir=${directory}`],
    {encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,windowsHide:true});
  manifest=JSON.parse(readFileSync(join(directory,'artifact-manifest.json')));
});
after(()=>{
  if(!directory)return;
  const target=realpathSync(directory),parent=realpathSync(tmpdir());
  if(!target.startsWith(parent+sep)||!target.includes('alp-consent-upgrade-artifact-')||target===resolve('.'))
    throw Error('temp_cleanup_refused');
  rmSync(target,{recursive:true,force:true});
});
const command=args=>spawnSync(process.execPath,[join(directory,'index.cjs'),...args],
  {encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
function refused(args,stage='arguments',category='boundary_refused'){
  const result=command(args);
  assert.equal(result.error,undefined);assert.equal(result.status,1);
  assert.equal(result.stdout,'');assert.equal(result.stderr,`${category}:${stage}\n`);
}
test('actual built operator pins source bytes and the distinct 111 to 112 release without a hosted claim',()=>{
  const identity=inventorySourceIdentity();
  assert.equal(manifest.contract,'telehealth-consent-upgrade-build/1');
  assert.equal(manifest.sourceCommit,identity.sourceCommit);assert.equal(manifest.clean,identity.sourceClean);
  assert.equal(manifest.sourceInputSha256,identity.sourceInputSha256);
  assert.equal(manifest.sourceObservation,'before_and_after_not_atomic');
  assert.equal(manifest.operatorSha256,sha(readFileSync(join(directory,'index.cjs'))));
  assert.equal(manifest.embeddedMigrationCount,112);
  assert.equal(manifest.fromReleaseSha256,'98ef31a24baeafb83bfd65a7832b1e4e02dbe1c71b6e78f8efdad4e0b0e62d4c');
  assert.equal(manifest.toReleaseSha256,'45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4');
  assert.equal(manifest.migrationArtifactSha256,'6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9');
  assert.equal(manifest.execution,'qualification_only');assert.equal(manifest.activation,'blocked');
  for(const key of ['phiAllowed','migrationPerformed','automaticWriteRetry','hostedRecoveryQualified'])assert.equal(manifest[key],false,key);
  for(const key of ['mandatoryRollbackRehearsal','durableNativeCustody','sharedOperatorNamespace','readOnlyInterruptionReconciliation','targetReviewRequired'])
    assert.equal(manifest[key],true,key);
});
test('actual CLI rejects unsupported, relative, incomplete and extra arguments without AWS or input echo',()=>{
  const path=join(directory,'never-opened-FICTIONAL-SECRET.json'),digest='a'.repeat(64);
  for(const args of [[],['--help'],['approve'],['upgrade'],
    ['inspect','--target','relative.json','--target-sha256',digest],
    ['inspect','--target',path,'--target-sha256','short'],
    ['inspect','--target',path,'--target-sha256',digest,'--approve'],
    ['upgrade','--target',path,'--target-sha256',digest],
    ['reconcile','--target',path,'--target-sha256',digest,'--confirm-fictional-telehealth-consent-upgrade'],
    ['upgrade','--target',path,'--target-sha256',digest,'--confirm-fictional-telehealth-consent-upgrade','extra']])refused(args);
});
test('actual CLI refuses dirty source or unsafe canonical target before AWS observations',()=>{
  // Fictional review-shaped input is deliberately invalid, never an approval.
  const target={contract:'telehealth-consent-upgrade-target/1',execution:'qualification',account:'173535830222',region:'us-east-2',
    foundation:'ai-clinical-core-qualification-foundation',operatorRole:'OrganizationAccountAccessRole',
    clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12',
    qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',
    sourceCommit:manifest.sourceCommit,operatorSha256:manifest.operatorSha256,phiAllowed:false,activation:'blocked',
    fromReleaseSha256:manifest.fromReleaseSha256,toReleaseSha256:manifest.toReleaseSha256,
    review:{reviewer:'Brandon Bright',reviewedAt:'2026-01-01T00:00:00.000Z',scope:'fictional-schema-transition-only'}};
  const path=join(directory,'invalid-target.json');
  for(const bytes of [Buffer.from(canonical(target)+'\n'),Buffer.from('{}\n'),Buffer.from('null\n'),Buffer.alloc(16385,32)]){
    writeFileSync(path,bytes);
    // Native bounded custody reads reject oversized files even earlier than
    // the command parser. Preserve and test that stronger refusal boundary.
    const oversized=manifest.clean&&bytes.length>16384;
    refused(['inspect','--target',path,'--target-sha256',sha(bytes)],oversized?'file':manifest.clean?'target_fields':'arguments',
      oversized?'custody_refused':'boundary_refused');
  }
  writeFileSync(path,JSON.stringify(target));
  refused(['inspect','--target',path,'--target-sha256',sha(JSON.stringify(target))],manifest.clean?'target_encoding':'arguments');
});
test('builder refuses override flags and relative output paths before compilation',()=>{
  for(const args of [['--approve'],['--out-dir=relative'],['--out-dir='],[`--out-dir=${directory}`,'--phi=true']]){
    const result=spawnSync(process.execPath,['scripts/build-telehealth-consent-upgrade.mjs',...args],
      {encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
    assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.match(result.stderr,/telehealth_consent_upgrade_build_argument_refused/);
  }
});
test('builder source-drift guard refuses changed commit, cleanliness or bytes before publishing with explicit dependency fixtures',()=>{
  // Exercise the real builder's control flow with fictional identity/esbuild
  // dependencies. This is not evidence of atomic filesystem observation.
  const artifact=execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
    {encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,windowsHide:true});
  for(const delta of [{sourceCommit:'b'.repeat(40)},{sourceClean:false},{sourceInputSha256:'c'.repeat(64)}]){
    const root=mkdtempSync(join(directory,'drift-')),scripts=join(root,'scripts'),modules=join(root,'node_modules','esbuild');
    mkdirSync(scripts);mkdirSync(modules,{recursive:true});
    writeFileSync(join(scripts,'build-telehealth-consent-upgrade.mjs'),readFileSync('scripts/build-telehealth-consent-upgrade.mjs'));
    writeFileSync(join(scripts,'artifact.json'),artifact);
    writeFileSync(join(scripts,'build-telehealth-consent-copy-candidate.mjs'),
      'import {readFileSync} from "node:fs";process.stdout.write(readFileSync(new URL("artifact.json",import.meta.url)));');
    const initial={sourceCommit:'a'.repeat(40),sourceClean:true,sourceInputSha256:'d'.repeat(64)};
    writeFileSync(join(scripts,'inventory-qualification-source.mjs'),
      `let n=0;export function inventorySourceIdentity(){return ++n===1?${JSON.stringify(initial)}:${JSON.stringify({...initial,...delta})};}`);
    writeFileSync(join(modules,'package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}));
    writeFileSync(join(modules,'index.mjs'),'export async function build(){return {outputFiles:[{contents:Buffer.from("fictional compiled bytes")}]};}');
    const out=join(root,'output'),result=spawnSync(process.execPath,['scripts/build-telehealth-consent-upgrade.mjs',`--out-dir=${out}`],
      {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
    assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.match(result.stderr,/telehealth_consent_upgrade_build_source_changed/);
    assert.equal(existsSync(join(out,'index.cjs')),false);assert.equal(existsSync(join(out,'artifact-manifest.json')),false);
  }
});
