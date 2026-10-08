import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {CARE_CANONICAL,readCanonicalCareMigrations,readHistoricalCareParentMigrations,canonicalCareMapping} from './care-canonical-migrations.mjs';
import {sha256,careMigrationBinding} from './synthetic-care-release.mjs';
import {careIntentMigrationBinding} from './synthetic-care-intent-release.mjs';
const current=readCanonicalCareMigrations(process.cwd()),overlay=current.migrations.at(-1).sql;
test('current canonical47 equals admitted source47/live48; exact parent and SQL bytes preserved',()=>{
 assert.equal(current.mapping.canonicalRegistered,true);assert.equal(current.mapping.sourceMigrationCount,47);
 assert.equal(current.mapping.liveMigrationCount,48);assert.equal(current.mapping.sourceLedgerSha256,CARE_CANONICAL.sourceSha256);
 assert.equal(current.mapping.liveLedgerSha256,CARE_CANONICAL.liveSha256);
 assert.equal(sha256(overlay),CARE_CANONICAL.sqlSha256);
 assert.equal(overlay,readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8').replace(/\r\n?/g,'\n'));
 assert.deepEqual(readHistoricalCareParentMigrations(process.cwd()),current.migrations.slice(0,46));
 for(const key of ['schemaReplayAuthorized','ledgerRewriteAuthorized','productionApproved','phiAllowed'])assert.equal(current.mapping[key],false);
});
test('history omissions, ordering, duplicate and altered canonical or reference contents refuse',()=>{
 for(const m of [current.migrations.slice(0,46),[...current.migrations].reverse(),[...current.migrations,current.migrations[0]],
  current.migrations.map((x,i)=>i?x:{...x,name:'changed'}),current.migrations.map((x,i)=>i?x:{...x,sql:x.sql+'-- changed\n'}),
  current.migrations.map((x,i)=>i?x:{...x,sql:x.sql+'-- changed\n',sha256:sha256(x.sql+'-- changed\n')})])
  assert.throws(()=>canonicalCareMapping(m,current.reference,overlay),/refused/);
 for(const r of [current.reference.slice(0,1),[...current.reference].reverse(),current.reference.map((x,i)=>i?x:{...x,sql:x.sql+'-- changed\n'})])
  assert.throws(()=>canonicalCareMapping(current.migrations,r,overlay),/refused/);
 assert.throws(()=>canonicalCareMapping(current.migrations,current.reference,overlay+'-- changed\n'),/terminal/);
});
test('historical mappings require explicit source-only view; unchanged live defaults refuse successor',()=>{
 assert.throws(()=>careMigrationBinding(process.cwd()),/migration_drift/);
 assert.throws(()=>careIntentMigrationBinding(process.cwd()),/migration_drift/);
 assert.equal(careMigrationBinding(process.cwd(),true).sourceCount,46);
 assert.equal(careIntentMigrationBinding(process.cwd(),true).canonicalRegistered,false);
 assert.throws(()=>careMigrationBinding(process.cwd(),'true'),/historical_mode/);
});
test('retired default builders refuse new history rather than mint a current-source upgrade',()=>{
 for(const file of ['build-care-erasure-schema-upgrade.mjs','build-care-erasure-release.mjs',
  'build-care-erasure-intent-operator.mjs','build-care-erasure-intent-release.mjs']){
  assert.throws(()=>execFileSync(process.execPath,['scripts/'+file],{encoding:'utf8',stdio:'pipe',timeout:30000}),e=>e.status===1);
 }
});
test('explicit historical build embeds non-clean source and cannot execute lasting writes',()=>{
 execFileSync(process.execPath,['scripts/build-care-erasure-intent-release.mjs','--historical-source-only'],{encoding:'utf8',timeout:30000});
 const dir='dist/aws-clinical-core/care-erasure-intent-release/';
 const m=JSON.parse(readFileSync(dir+'artifact-manifest.json','utf8'));
 assert.equal(m.historicalSourceOnly,true);assert.equal(m.clean,false);assert.equal(m.canonicalRegistered,false);
 assert.equal(m.sha256,sha256(readFileSync(dir+'index.cjs')));
 const run="const p=require('./"+dir+"index.cjs');p.runCareIntentReleaseDatabase('upgrade','"+m.sourceCommit+"').then(()=>process.exit(2)).catch(e=>{if(e.category!=='boundary_refused')process.exit(3)})";
 execFileSync(process.execPath,['-e',run],{encoding:'utf8',timeout:10000});
});
test('current inspector embeds current registry but supplies neither replay nor PHI activation',()=>{
 execFileSync(process.execPath,['scripts/build-care-intent-canonical-inspector.mjs'],{encoding:'utf8',timeout:30000});
 const dir='dist/aws-clinical-core/care-intent-canonical-inspector/';
 const m=JSON.parse(readFileSync(dir+'artifact-manifest.json','utf8'));
 assert.equal(m.mapping.canonicalRegistered,true);assert.equal(m.sha256,sha256(readFileSync(dir+'index.cjs')));
 assert.equal(m.inspectionOnly,true);assert.equal(m.schemaReplayAvailable,false);assert.equal(m.ledgerRewriteAvailable,false);
 for(const args of [[],['upgrade'],['rehearse'],['inspect','--report=pass.json'],['inspect','--profile=other']])
  assert.throws(()=>execFileSync(process.execPath,[dir+'index.cjs',...args],{encoding:'utf8',stdio:'pipe',timeout:10000}),
   e=>e.status===1&&String(e.stderr).trim()==='care_canonical_registration_boundary_refused');
});
