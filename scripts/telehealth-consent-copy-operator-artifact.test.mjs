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
  directory=mkdtempSync(join(tmpdir(),'alp-copy-operator-artifact-'));
  execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-operator.mjs',`--out-dir=${directory}`],
    {encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,windowsHide:true});
  manifest=JSON.parse(readFileSync(join(directory,'artifact-manifest.json')));
});
after(()=>{
  if(!directory)return;const target=realpathSync(directory),parent=realpathSync(tmpdir());
  if(!target.startsWith(parent+sep)||!target.includes('alp-copy-operator-artifact-')||target===resolve('.'))throw Error('temp_cleanup_refused');
  rmSync(target,{recursive:true,force:true});
});
const command=args=>spawnSync(process.execPath,[join(directory,'index.cjs'),...args],
  {encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
function refused(args,message='target_refused'){
  const result=command(args);assert.equal(result.error,undefined);assert.equal(result.status,1);
  assert.equal(result.stdout,'');assert.equal(result.stderr,message+'\n');
}
test('actual build pins exact112 SQL and source, without copy/approval/migration or hosted claims',()=>{
  const identity=inventorySourceIdentity();assert.equal(manifest.contract,'telehealth-consent-copy-operator-build/112');
  assert.equal(manifest.sourceCommit,identity.sourceCommit);assert.equal(manifest.clean,identity.sourceClean);
  assert.equal(manifest.sourceInputSha256,identity.sourceInputSha256);assert.equal(manifest.sourceObservation,'before_and_after_not_atomic');
  assert.equal(manifest.operatorSha256,sha(readFileSync(join(directory,'index.cjs'))));assert.equal(manifest.embeddedMigrationCount,112);
  assert.equal(manifest.migrationReleaseSha256,'45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4');
  assert.equal(manifest.migrationArtifactSha256,'6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9');
  assert.equal(manifest.execution,'qualification_only');assert.equal(manifest.activation,'blocked');
  for(const key of ['phiAllowed','migrationPerformed','copyRegistrationPerformed','approvalsCreated','grantsCreated','automaticWriteRetry','hostedRecoveryQualified'])
    assert.equal(manifest[key],false,key);
  for(const key of ['mandatoryRollbackRehearsal','durableNativeCustody','sharedOperatorNamespace','readOnlyInterruptionReconciliation','targetReviewRequired','exactCopyReviewRequired','originalCopyArchived'])
    assert.equal(manifest[key],true,key);
});
test('actual executable refuses incomplete/foreign operations and overrides before file/AWS access without echo',()=>{
  const path=join(directory,'unread-FICTIONAL-SECRET.json'),digest='a'.repeat(64);
  const args=['register','--target',path,'--target-sha256',digest,'--copy',path,'--copy-sha256',digest,'--confirm-fictional-telehealth-copy'];
  for(const v of [[],['--help'],['approve'],['upgrade'],args.slice(0,-1),[...args,'--profile','other'],
    ['reconcile',...args.slice(1,-1),'--confirm-fictional-telehealth-copy'],
    [args[0],args[1],'relative.json',...args.slice(3)],
    [...args.slice(0,6),'relative-copy.json',...args.slice(7)],
    [...args.slice(0,8),'short',args[9]],
    ['inspect',...args.slice(1)]])refused(v);
});
test('actual executable refuses unsafe/schema-only target before AWS and never prints fictional text',()=>{
  const copy={contract:'telehealth-consent-copy/112',artifactId:'11111111-1111-4111-8111-111111111111',
    organizationId:'22222222-2222-4222-8222-222222222222',artifactVersion:'FICTIONAL/1',scope:'telehealth_recording',
    content:'FICTIONAL-SECRET-NEVER-ECHO',contentSha256:sha('FICTIONAL-SECRET-NEVER-ECHO')};
  const copyBytes=Buffer.from(canonical(copy)+'\n'),copyFile=join(directory,'copy.json');writeFileSync(copyFile,copyBytes);
  const target={contract:'telehealth-consent-copy-target/112',execution:'qualification',account:'173535830222',region:'us-east-2',
    foundation:'ai-clinical-core-qualification-foundation',operatorRole:'OrganizationAccountAccessRole',
    clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12',
    qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',sourceCommit:manifest.sourceCommit,
    operatorSha256:manifest.operatorSha256,phiAllowed:false,activation:'blocked',migrationReleaseSha256:manifest.migrationReleaseSha256,
    copySha256:sha(copyBytes),artifactId:copy.artifactId,organizationId:copy.organizationId,artifactVersion:copy.artifactVersion,
    contentSha256:copy.contentSha256,scope:copy.scope,
    review:{reviewer:'Brandon Bright',reviewedAt:'2026-01-01T00:00:00.000Z',scope:'fictional-schema-transition-only'}};
  const path=join(directory,'target.json');
  for(const value of [Buffer.from(canonical(target)+'\n'),Buffer.from('{}\n'),Buffer.from('null\n'),Buffer.alloc(16385,32),Buffer.from(JSON.stringify(target))]){
    writeFileSync(path,value);refused(['inspect','--target',path,'--target-sha256',sha(value),'--copy',copyFile,'--copy-sha256',sha(copyBytes)],
      manifest.clean&&value.length>16384?'custody_refused:file':'target_refused');
  }
});
test('builder refuses foreign flags and relative output directory before compilation',()=>{
  for(const args of [['--approve'],['--out-dir=relative'],['--out-dir='],[`--out-dir=${directory}`,'--phi=true']]){
    const result=spawnSync(process.execPath,['scripts/build-telehealth-consent-copy-operator.mjs',...args],
      {encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
    assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/telehealth_copy_operator_build_argument_refused/);
  }
});
test('real builder refuses source drift before publishing with clearly fictional compile/identity dependencies',()=>{
  const artifact=execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
    {encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,windowsHide:true});
  for(const delta of [{sourceCommit:'b'.repeat(40)},{sourceClean:false},{sourceInputSha256:'c'.repeat(64)}]){
    const root=mkdtempSync(join(directory,'drift-')),scripts=join(root,'scripts'),modules=join(root,'node_modules','esbuild');
    mkdirSync(scripts);mkdirSync(modules,{recursive:true});
    writeFileSync(join(scripts,'build-telehealth-consent-copy-operator.mjs'),readFileSync('scripts/build-telehealth-consent-copy-operator.mjs'));
    writeFileSync(join(scripts,'artifact.json'),artifact);writeFileSync(join(scripts,'build-telehealth-consent-copy-candidate.mjs'),
      'import {readFileSync} from "node:fs";process.stdout.write(readFileSync(new URL("artifact.json",import.meta.url)));');
    const initial={sourceCommit:'a'.repeat(40),sourceClean:true,sourceInputSha256:'d'.repeat(64)};
    writeFileSync(join(scripts,'inventory-qualification-source.mjs'),
      `let n=0;export function inventorySourceIdentity(){return ++n===1?${JSON.stringify(initial)}:${JSON.stringify({...initial,...delta})};}`);
    writeFileSync(join(modules,'package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}));
    writeFileSync(join(modules,'index.mjs'),'export async function build(){return {outputFiles:[{contents:Buffer.from("FICTIONAL compiled bytes")}]};}');
    const out=join(root,'output'),result=spawnSync(process.execPath,['scripts/build-telehealth-consent-copy-operator.mjs',`--out-dir=${out}`],
      {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:100000,windowsHide:true});
    assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/telehealth_copy_operator_build_source_changed/);
    assert.equal(existsSync(join(out,'index.cjs')),false);assert.equal(existsSync(join(out,'artifact-manifest.json')),false);
  }
});
