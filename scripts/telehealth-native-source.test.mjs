import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileTelehealthSchemaNativeSource } from './compile-telehealth-schema-source.mjs';

const identity={database_name:'alp_source_'+'a'.repeat(32),owner:'postgres',version:'17.7'};
function fake(rows,existing={namespaces:0,roles:0,public_relations:0}) {
  let queries=0;
  const db={query:async()=>({rows:++queries===1?rows:[existing]}),
    exec:async()=>assert.fail('must not execute SQL'),transaction:async()=>assert.fail('must not start a write transaction')};
  return {db,count:()=>queries};
}
for(const patch of [
  {database_name:'clinical_core_qualification'},{database_name:'clinical_core'},
  {database_name:'production'},{database_name:'alp_source_not_random'},
  {database_name:'alp_source_'+'a'.repeat(32)+';select 1'},
  {owner:'clinical_admin'},{owner:'another_admin'},{version:'18.3'},
  {version:'17.8'},{version:'17.7 extra'},
])test('native source refuses identity '+JSON.stringify(patch),async()=>{
  const t=fake([{...identity,...patch}]);
  await assert.rejects(compileTelehealthSchemaNativeSource(t.db),/identity_refused/);
  assert.equal(t.count(),1);
});
for(const rows of [[],[identity,identity]])test('native source refuses identity row count '+rows.length,async()=>{
  const t=fake(rows);await assert.rejects(compileTelehealthSchemaNativeSource(t.db),/identity_refused/);assert.equal(t.count(),1);
});
for(const patch of [{namespaces:1},{roles:1},{public_relations:1},{namespaces:'0'},{roles:null}])
test('native source refuses existing/invalid catalog '+JSON.stringify(patch),async()=>{
  const t=fake([identity],{namespaces:0,roles:0,public_relations:0,...patch});
  await assert.rejects(compileTelehealthSchemaNativeSource(t.db),/not_empty/);assert.equal(t.count(),2);
});
const root=fileURLToPath(new URL('../',import.meta.url));
for(const args of [[],['--target','production'],['--connection-string','postgres://remote/db'],
  ['--binary-directory','relative','--driver-directory','relative'],
  ['--binary-directory','/tmp','--driver-directory','/tmp','--phi','true'],
  ['--binary-directory',root,'--driver-directory',root,'--matrix','other'],
  ['--binary-directory',root,'--driver-directory',root,'--candidate','key-fence'],
  ['--binary-directory',root,'--driver-directory',root,'--matrix','telehealth-transfer','--candidate','other'],
  ['--binary-directory',root,'--driver-directory',root,'--matrix','telehealth-transfer','--phi','true'],
  ['--binary-directory',root,'--driver-directory',root,'--owner-profile','postgres'],
  ['--binary-directory',root,'--driver-directory',root,'--owner-profile','clinical-admin','--matrix','telehealth-transfer'],
  ['--binary-directory',root,'--driver-directory',root,'--owner-profile','clinical-admin','--target','clinical_core_qualification']])
test('native CLI refuses unsupported inputs '+JSON.stringify(args),()=>{
  const run=spawnSync(process.execPath,['scripts/qualify-telehealth-native-source.mjs',...args],{
    cwd:root,encoding:'utf8',timeout:15_000,windowsHide:true});
  assert.equal(run.status,1);assert.match(run.stderr,/arguments_refused/);
  assert.doesNotMatch(run.stdout,/local_empty_source/);
});
