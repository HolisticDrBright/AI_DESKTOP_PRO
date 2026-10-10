import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { telehealthTransferKeyFenceCandidate,TELEHEALTH_KEY_FENCE_FILE } from './telehealth-transfer-key-fence-candidate.mjs';
const parent=JSON.parse(execFileSync(process.execPath,['scripts/build-zoom-host-authority-candidate.mjs','--json'],
  {encoding:'utf8',maxBuffer:16*1024*1024,timeout:60_000,windowsHide:true}));
const source=readFileSync('infra/aws-clinical-core/source-candidates/telehealth-transfer-key-fence.sql','utf8').replace(/\r\n?/g,'\n');
test('copies all exact 114 bytes without mutation and adds only the distinct blocked key fence',()=>{
  const before=structuredClone(parent),child=telehealthTransferKeyFenceCandidate(parent,source);
  assert.deepEqual(parent,before);assert.deepEqual(child.manifest.migrations.slice(0,114),parent.manifest.migrations);
  for(const row of parent.manifest.migrations)assert.equal(child.files[row.file],parent.files[row.file]);
  assert.equal(child.manifest.migrations[114].file,TELEHEALTH_KEY_FENCE_FILE);
  assert.equal(child.releaseHash,'3172e6b60c62edbb9e9cec10fbc74fe908eb7c41bad562e499b08620d5d670a9');
  assert.equal(child.candidate.migrationReleaseSha256,'cf9e9a80ec6e2973cf53ce1718ce1b48b48e6c62c90af360fb33bb45d6635119');
  assert.equal(child.candidate.phiAllowed,false);assert.equal(child.candidate.activation,'blocked');
  assert.equal(child.candidate.deployment,'not_deployed');
  for(const [key,value]of Object.entries(child.candidate))if(key.startsWith('seeded'))assert.equal(value,false);
  assert.deepEqual(telehealthTransferKeyFenceCandidate(parent,source.replaceAll('\n','\r\n')),child);
});
test('the only function-body change is retaining the unretired admission key under FOR SHARE',()=>{
  const oldSql=parent.files[parent.manifest.migrations[112].file];
  const start=oldSql.indexOf('create or replace function clinical_core.transfer_telehealth_note(');
  const oldBody=oldSql.slice(start,oldSql.indexOf('\nend $$;',start)+8);
  const newBody=source.slice(source.indexOf('create or replace function'));
  assert.equal(newBody,oldBody.replace("where key_id=(_a->>'key_id') and retired_at is null;",
    "where key_id=(_a->>'key_id') and retired_at is null for share;")+'\n');
});
for(const [name,mutate]of [
  ['PHI',p=>{p.candidate.phiAllowed=true;}],['activation',p=>{p.candidate.activation='approved';}],
  ['seeded key',p=>{p.candidate.seededAdmissionKeys=true;}],['missing posture',p=>{delete p.candidate.seededApprovals;}],
  ['extra approval',p=>{p.candidate.approved=true;}],['wrong contract',p=>{p.candidate.contract='other/1';}],
  ['wrong parent extension',p=>{p.candidate.extensionSha256='a'.repeat(64);}],
  ['changed host pins',p=>{p.functionPins[0].bodySha256='a'.repeat(64);}],
  ['changed parent SQL',p=>{p.files[p.manifest.migrations[0].file]+='--drift';}],
  ['extra file',p=>{p.files['extra.sql']='select 1;';}],['missing file',p=>{delete p.files[p.manifest.migrations[0].file];}],
  ['reordered rows',p=>{p.manifest.migrations.reverse();}],['null row',p=>{p.manifest.migrations[0]=null;}],
  ['extra row field',p=>{p.manifest.migrations[0].approved=true;}],['wrong count',p=>{p.manifest.migrations.pop();}],
  ['wrong assembly',p=>{p.releaseHash='a'.repeat(64);}],
])test('key fence refuses '+name,()=>{
  const p=structuredClone(parent);mutate(p);assert.throws(()=>telehealthTransferKeyFenceCandidate(p,source),/artifact_refused/);
});
test('changed key lock, extra SQL and non-string source cannot be repinned',()=>{
  for(const sql of [source.replace(' for share;',';'),source.replace(' for share;',' for key share;'),source+'select 1;',null])
    assert.throws(()=>telehealthTransferKeyFenceCandidate(parent,sql),/artifact_refused/);
});
test('builder has no apply, alternate source or activation mode',()=>{
  for(const arg of ['--apply','--source=other.sql','--phi','--activate'])
    assert.throws(()=>execFileSync(process.execPath,['scripts/build-telehealth-transfer-key-fence-candidate.mjs',arg],
      {encoding:'utf8',timeout:5000,windowsHide:true,stdio:'pipe'}),e=>/argument_refused/.test(e.stderr));
});
