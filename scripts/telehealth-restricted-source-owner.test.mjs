import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRestrictedSourceOwnerIdentity } from './telehealth-restricted-source-owner.mjs';
import { compileTelehealthSchemaRestrictedOwnerSource } from './compile-telehealth-schema-source.mjs';

const identity={database_name:'alp_owner_source_'+'a'.repeat(32),owner:'clinical_admin',session_owner:'clinical_admin',
  database_owner:'clinical_admin',version:'17.7',rolsuper:false,rolcreaterole:true,rolcreatedb:true,
  rolinherit:true,rolbypassrls:false,rolcanlogin:true,rolreplication:false};
test('restricted source identity cannot authorize an upgrade or impersonate managed Aurora',()=>{
  const value=assertRestrictedSourceOwnerIdentity([identity]);
  for(const key of ['managedRoleSemanticsVerified','runtimeAdmission','providerAuthorized','upgradeAuthorized','phiAllowed'])assert.equal(value[key],false);
  assert.equal(value.activation,'blocked');assert.equal(value.sourceOnly,true);
});
for(const patch of [{database_name:'clinical_core_qualification'},{database_name:'clinical_core'},
  {database_name:'alp_owner_source_bad'},{owner:'postgres'},{session_owner:'postgres'},{database_owner:'postgres'},
  {version:'18.3'},{version:'17.8'},{rolsuper:true},{rolbypassrls:true},{rolreplication:true},
  {rolcreaterole:false},{rolcreatedb:false},{rolinherit:false},{rolcanlogin:false},{rolsuper:'false'},
  {extra:true}])test('restricted source refuses '+JSON.stringify(patch),async()=>{
  let queries=0;
  const db={query:async()=>{queries++;return {rows:[{...identity,...patch}]};},
    exec:async()=>assert.fail('SQL execution forbidden'),transaction:async()=>assert.fail('write transaction forbidden')};
  await assert.rejects(compileTelehealthSchemaRestrictedOwnerSource(db),/owner_refused/);assert.equal(queries,1);
});
for(const rows of [[],[identity,identity],[null],[{...identity,rolbypassrls:undefined}]])
test('restricted source rejects malformed identity '+JSON.stringify(rows),()=>assert.throws(()=>assertRestrictedSourceOwnerIdentity(rows),/owner_refused/));
for(const patch of [{memberships:1},{namespaces:1},{roles:1},{public_relations:1},{roles:'0'},{memberships:null},{extra:0}])
test('restricted source rejects nonempty or malformed catalog '+JSON.stringify(patch),async()=>{
  let queries=0;
  const db={query:async()=>({rows:++queries===1?[identity]:[{memberships:0,namespaces:0,roles:0,public_relations:0,...patch}]}),
    exec:async()=>assert.fail('SQL execution forbidden'),transaction:async()=>assert.fail('write transaction forbidden')};
  await assert.rejects(compileTelehealthSchemaRestrictedOwnerSource(db),/not_empty/);assert.equal(queries,2);
});
