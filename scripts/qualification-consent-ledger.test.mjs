import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {qualificationConsentArtifact,assertQualificationConsentLedger,assertQualificationConsentFoundation} from './qualification-consent-ledger.mjs';
const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:15000,windowsHide:true}));
test('actual canonical artifact and every ordered actual ledger row are required',()=>{
  const expected=qualificationConsentArtifact(artifact);
  assert.doesNotThrow(()=>assertQualificationConsentLedger('clinical_core_qualification',expected,expected));
  for(const rows of [expected.slice(0,105),expected.slice(0,104),expected.slice(0,103),[...expected,{version:'20261007010000',sha256:'a'.repeat(64)}],
    expected.map((m,i)=>i===0?{...m,sha256:'a'.repeat(64)}:m),[expected[1],expected[0],...expected.slice(2)],
    expected.map((m,i)=>i===1?expected[0]:m)])assert.throws(()=>assertQualificationConsentLedger('clinical_core_qualification',rows,expected),/ledger_refused/);
  assert.throws(()=>assertQualificationConsentLedger('clinical_core',expected,expected),/ledger_refused/);
  assert.throws(()=>assertQualificationConsentLedger('clinical_core_qualification',expected,expected.map(m=>({...m,sha256:'a'.repeat(64)}))),/ledger_refused/);
});
test('changed artifact or history cannot be passed off as the reviewed 106 ledger',()=>{
  const copy=structuredClone(artifact);copy.files[copy.manifest.migrations[0].file]+='\n-- tampered';
  assert.throws(()=>qualificationConsentArtifact(copy),/artifact_refused/);
  copy.manifest.migrations=copy.manifest.migrations.slice(0,103);assert.throws(()=>qualificationConsentArtifact(copy),/artifact_refused/);
});
test('foundation requires exact PHI-off qualification database and synthetic ARN accounts/region',()=>{
  const entries={PhiAllowed:'false',Activation:'blocked',DatabaseName:'clinical_core_qualification',QualificationInfrastructure:'prepared_no_candidates',
    DatabaseClusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',DatabaseSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCdEf'};
  const foundation=(patch={})=>({StackStatus:'CREATE_COMPLETE',Outputs:Object.entries({...entries,...patch}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))});
  assert.doesNotThrow(()=>assertQualificationConsentFoundation(foundation()));
  for(const patch of [{PhiAllowed:'true'},{Activation:'approved'},{DatabaseName:'clinical_core'},{DatabaseClusterArn:'arn:aws:rds:us-east-2:173535830222:cluster:production'},
    {DatabaseSecretArn:'arn:aws:secretsmanager:us-west-2:588966314750:secret:other'},{QualificationInfrastructure:undefined}])assert.throws(()=>assertQualificationConsentFoundation(foundation(patch)),/foundation_refused/);
});
test('registrar inspects every row before consent SQL and exposes an explicit rollback-only inspection',()=>{
  const code=readFileSync(new URL('./register-aws-qualification-consent.mjs',import.meta.url),'utf8');
  assert.match(code,/select version,sha256 from clinical_core.schema_migrations order by version/);
  assert.ok(code.indexOf('assertQualificationConsentLedger(field(')<code.indexOf('const existing = await query('));
  assert.match(code,/const inspect=process.argv\[2\]==='--inspect'/);
  assert.match(code,/set transaction isolation level repeatable read/);
  assert.match(code,/qualification_consent_dirty_source_refused/);
  assert.match(code,/writeStatus:inspect\?'none':'not_certified'/);
  assert.ok(code.indexOf("status:'inspected_missing'")<code.indexOf('insert into clinical_private.consumer_storage_consent_releases'));
  assert.doesNotMatch(code,/Number\(field\(row, 1\)\).*103/);
});
