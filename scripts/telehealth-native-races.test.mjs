import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTelehealthNativeRaces,TELEHEALTH_NATIVE_RACE_CASES } from './telehealth-native-races.mjs';
const identity={db:'alp_source_'+'a'.repeat(32),owner:'postgres',version:'17.7'};
for(const value of [[],[identity,identity],[null],[{...identity,db:'clinical_core_qualification'}],
  [{...identity,db:'clinical_core'}],[{...identity,owner:'clinical_admin'}],[{...identity,version:'18.3'}],
  [{...identity,approval:true}],null])test('native race identity guard refuses '+JSON.stringify(value),async()=>{
  let queries=0;const admin={query:async()=>{queries++;return{rows:value};}};
  await assert.rejects(runTelehealthNativeRaces(admin,()=>assert.fail('no secondary session before admission')),/identity_refused/);
  assert.equal(queries,1);
});
for(const value of [[],null,[{version:'20261010210000',name:'wrong',sha256:'a'.repeat(64)}]])
test('native race ledger guard refuses '+JSON.stringify(value),async()=>{
  let queries=0;const admin={query:async()=>({rows:++queries===1?[identity]:value})};
  await assert.rejects(runTelehealthNativeRaces(admin,()=>assert.fail('no secondary session before admission')),/ledger_refused/);
  assert.equal(queries,2);
});
test('the matrix makes all seven independent cases mandatory',()=>{
  assert.equal(TELEHEALTH_NATIVE_RACE_CASES.length,7);assert.equal(new Set(TELEHEALTH_NATIVE_RACE_CASES).size,7);
  assert.ok(Object.isFrozen(TELEHEALTH_NATIVE_RACE_CASES));
  assert.ok(TELEHEALTH_NATIVE_RACE_CASES.includes('key_retired_during_destination_lock'));
});
