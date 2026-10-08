import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {CARE_RELEASE as P,careSourceSnapshot,careSourceEntry,sha256,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {careIntentCurrent,createCareIntentCandidate} from './synthetic-care-intent-release.mjs';
import {parseCareGitBlobs,readHistoricalCareSource,verifyCareRuntimeEntries,qualifyCareIntentResumptionSource} from './care-intent-resumption-source.mjs';
import {careIntentResumptionSourceArgs} from './qualify-synthetic-care-intent-resumption-source.mjs';
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true,stdio:['ignore','pipe','pipe']});
function fixture(t){
 const root=mkdtempSync(resolve(tmpdir(),'alp-resume-source-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,bytes)=>{mkdirSync(resolve(root,path,'..'),{recursive:true});writeFileSync(resolve(root,path),bytes);};
 const commit=()=>{git(root,['add','.']);git(root,['-c','user.name=Fictional','-c','user.email=fictional@example.invalid',
  '-c','commit.gpgsign=false','commit','--no-verify','-m','fictional source']);return git(root,['rev-parse','HEAD']).trim();};
 git(root,['init']);git(root,['config','core.autocrlf','false']);
 return {root,put,commit};
}
function batch(values){
 const objects=[],parts=[];
 for(const data of values){const oid=createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
  objects.push(oid);parts.push(Buffer.from(`${oid} blob ${data.length}\n`),data,Buffer.from('\n'));}
 return {objects,bytes:Buffer.concat(parts)};
}
test('binary Git framing preserves newline, NUL, header-like contents and empty blobs',()=>{
 const values=[Buffer.from('a\n'+ 'c'.repeat(40)+' blob 9\n\0b'),Buffer.alloc(0),Buffer.from([0,255,13,10])],b=batch(values);
 const result=parseCareGitBlobs(b.bytes,b.objects);
 assert.deepEqual([...result.values()],values);
});
test('missing, malformed, truncated, extra, duplicate or changed Git objects refuse',()=>{
 const b=batch([Buffer.from('binary\0\ncontent')]),other=batch([Buffer.from('other')]);
 for(const [bytes,objects] of [
  [Buffer.alloc(0),b.objects],[b.bytes.subarray(0,b.bytes.length-1),b.objects],
  [Buffer.concat([b.bytes,Buffer.from('extra')]),b.objects],
  [b.bytes,[...b.objects,...b.objects]],[other.bytes,b.objects],
  [Buffer.from(b.bytes.toString().replace('blob','tree')),b.objects],
  [Buffer.concat([b.bytes.subarray(0,b.bytes.length-2),Buffer.from('x\n')]),b.objects],
  [Buffer.from(`${b.objects[0]} blob 16777217\n`),b.objects],
  [Buffer.from(`${b.objects[0]} blob 01\nx\n`),b.objects],
  [b.bytes,['--batch']],[b.bytes,[]]])assert.throws(()=>parseCareGitBlobs(bytes,objects),/resume_source_/);
});
test('historical digest exactly reproduces clean desktop snapshot without checking out or mutating HEAD',t=>{
 const f=fixture(t);f.put('src/app/[owner]/route.ts','export const value = 1;\r\n');
 f.put('src/assets/picture.bin',Buffer.from([0,255,13,10]));f.put('scripts/operator.mjs','export const safe = true;\n');
 f.put('package.json','{}\n');f.commit();const application=careSourceSnapshot(f.root,'desktop');
 f.put('scripts/operator.mjs','export const safe = 2;\n');f.put('docs/report.md','documentation\n');f.commit();
 const head=git(f.root,['rev-parse','HEAD']).trim(),before=git(f.root,['status','--porcelain']);
 const old=readHistoricalCareSource(f.root,'desktop',application.commit);
 assert.deepEqual(old.snapshot,application);assert.equal(old.entries.length,application.files);
 assert.equal(git(f.root,['rev-parse','HEAD']).trim(),head);assert.equal(git(f.root,['status','--porcelain']),before);
 const now=readHistoricalCareSource(f.root,'desktop',head);
 assert.equal(verifyCareRuntimeEntries('desktop',old.entries,now.entries).files,3);
 assert.notEqual(now.snapshot.sha256,old.snapshot.sha256);
});
test('current source hashing keeps LF text normalization and byte-exact binary semantics',()=>{
 assert.deepEqual(careSourceEntry('src/value.ts',Buffer.from('a\r\nb\r')),careSourceEntry('src/value.ts',Buffer.from('a\nb\n')));
 assert.notDeepEqual(careSourceEntry('src/value.bin',Buffer.from('a\r\n')),careSourceEntry('src/value.bin',Buffer.from('a\n')));
 assert.notDeepEqual(careSourceEntry('src/value.ts',Buffer.from('a')),careSourceEntry('src/other.ts',Buffer.from('a')));
});
test('historical V2 snapshot includes evidence source while runtime comparison excludes only the named release handoff',t=>{
 const f=fixture(t);f.put('expo/app/(tabs)/plan.tsx','export const plan = 1;\n');f.put('expo/docs/six-phase-current-evidence-2026-10-05.md','old\n');
 f.put('data/catalog/products.json','[]\n');f.put('scripts/operator.mjs','old\n');f.put('bun.lock','old\n');
 f.commit();const application=careSourceSnapshot(f.root,'v2');
 f.put('expo/docs/six-phase-current-evidence-2026-10-05.md','new\n');const head=f.commit();
 const old=readHistoricalCareSource(f.root,'v2',application.commit),now=readHistoricalCareSource(f.root,'v2',head);
 assert.deepEqual(old.snapshot,application);assert.equal(verifyCareRuntimeEntries('v2',old.entries,now.entries).files,4);
 f.put('expo/app/(tabs)/plan.tsx','changed runtime\n');const changed=readHistoricalCareSource(f.root,'v2',f.commit());
 assert.throws(()=>verifyCareRuntimeEntries('v2',old.entries,changed.entries),/runtime_changed/);
});
test('commit input is full immutable ancestor identity, not a ref, future commit or missing object',t=>{
 const f=fixture(t);f.put('src/test.ts','old\n');const old=f.commit();f.put('src/test.ts','new\n');const future=f.commit();
 git(f.root,['checkout','--detach',old]);
 for(const commit of ['HEAD',old.slice(0,8),'--help',future,'f'.repeat(40)])
  assert.throws(()=>readHistoricalCareSource(f.root,'desktop',commit),/resume_source_/);
 assert.deepEqual(readHistoricalCareSource(f.root,'desktop',old).snapshot,careSourceSnapshot(f.root,'desktop'));
});
test('runtime changes include additions, removals, dependencies, migrations, catalog and health destinations',()=>{
 const entry=file=>({file,sha256:sha256(file)});
 for(const [kind,paths] of [['desktop',['src/a.ts','infra/schema.sql','package.json','package-lock.json','.gitattributes']],
  ['v2',['expo/eas.json','expo/app/a.tsx','expo/docs/code.ts','expo/docs/another.md','scripts/build.mjs','data/products.json','package.json','package-lock.json','bun.lock','.gitattributes']]]){
  const original=paths.map(entry);
  for(let i=0;i<original.length;i++)for(const mode of ['changed','removed']){
   const changed=structuredClone(original);if(mode==='changed')changed[i].sha256='f'.repeat(64);else changed.splice(i,1);
   assert.throws(()=>verifyCareRuntimeEntries(kind,original,changed),/runtime_changed/);
  }
  const added=[...original,entry(kind==='desktop'?'src/added.ts':'expo/new.ts')];
  assert.throws(()=>verifyCareRuntimeEntries(kind,original,added),/runtime_changed/);
  assert.throws(()=>verifyCareRuntimeEntries(kind,original,[...original,original[0]]),/runtime_shape/);
 }
});
test('symlinks and gitlinks are never admitted as historical application files',t=>{
 const f=fixture(t);f.put('src/normal.ts','safe\n');f.commit();
 const blob=git(f.root,['hash-object','src/normal.ts']).trim();
 git(f.root,['update-index','--add','--cacheinfo',`120000,${blob},src/link.ts`]);
 git(f.root,['-c','user.name=Fictional','-c','user.email=fictional@example.invalid','-c','commit.gpgsign=false',
  'commit','--no-verify','-m','fictional symlink']);
 assert.throws(()=>readHistoricalCareSource(f.root,'desktop',git(f.root,['rev-parse','HEAD']).trim()),/tree_entry/);
});
async function pairedFixture(t){
 const d=fixture(t),v=fixture(t),infra='infra/aws-clinical-core/';
 for(const folder of ['migrations','catalog-migrations'])cpSync(resolve(infra,folder),resolve(d.root,infra,folder),{recursive:true});
 for(const path of ['source-candidates/care-erasure-intents.sql','identity-api-extension.json'])
  d.put(infra+path,readFileSync(infra+path));
 for(const name of ['careDataLifecycle','careErasureRecovery']){
  const bytes=readFileSync('src/contracts/'+name+'.ts');d.put('src/contracts/'+name+'.ts',bytes);v.put('expo/contracts/'+name+'.ts',bytes);
 }
 d.put('src/server/clinical-core/aws-identity-lambda.ts','exports.handler = async () => ({statusCode: 503});\n');
 const env={EXPO_PUBLIC_RELEASE_CHANNEL:'synthetic-testflight',EXPO_PUBLIC_SYNTHETIC_ACCOUNT_DOMAIN:'brightlongevity.test',
  EXPO_PUBLIC_CLINICAL_AWS_API_ORIGIN:`https://${P.apiId}.execute-api.${P.region}.amazonaws.com`,EXPO_PUBLIC_CLINICAL_AWS_RUNTIME_MODE:'synthetic',
  EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_POOL_ID:P.consumerPool,EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_CLIENT_ID:P.consumerClient};
 v.put('expo/eas.json',JSON.stringify({build:{testflight:{env},'android-health-connect':{env}}}));
 for(const path of ['lib/clinicalData/careErasureJournal.ts','lib/clinicalData/awsCareDataLifecycle.ts','components/CareErasureRequestsList.tsx'])
  v.put('expo/'+path,'export const fictional = 1;\n');
 d.put('scripts/operator.mjs','old\n');v.put('expo/docs/six-phase-current-evidence-2026-10-05.md','old\n');d.commit();v.commit();
 const application=careIntentCurrent(d.root,v.root),candidate=createCareIntentCandidate(application,await buildCareIdentityBundle(d.root));
 d.put('scripts/operator.mjs','repaired\n');d.commit();v.put('expo/docs/six-phase-current-evidence-2026-10-05.md','updated evidence\n');v.commit();
 return {d,v,application,candidate};
}
test('resumption qualification independently separates source identities without claiming AWS or schema acceptance',async t=>{
 const f=await pairedFixture(t),r=await qualifyCareIntentResumptionSource(f.d.root,f.v.root,f.candidate);
 assert.deepEqual(r.applicationCurrent,f.application);
 assert.notEqual(r.operatorCurrent.desktop.commit,r.applicationCurrent.desktop.commit);
 assert.notEqual(r.operatorCurrent.mobile.source.commit,r.applicationCurrent.mobile.source.commit);
 assert.equal(r.historicalSourcesVerified,true);assert.equal(r.currentRuntimeByteMatched,true);
 for(const k of ['awsObserved','custodyAcquired','deployed','schemaChanged','hostedAcceptance','physicalDeviceAcceptance',
  'phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
});
test('candidate rehashing, forged source, dirty checkout or changed runtime cannot gain a resumption binding',async t=>{
 const f=await pairedFixture(t);
 for(const change of [c=>c.release.desktop.sha256='f'.repeat(64),c=>c.release.mobile.source.files++,
  c=>c.manifest.phiAllowed=true,c=>c.release.mobile.deviceVerified=true,c=>c.zip=Buffer.from('changed'),
  c=>c.bundle=Buffer.from('changed')]){
  const candidate={...f.candidate,release:structuredClone(f.candidate.release),manifest:structuredClone(f.candidate.manifest)};
  change(candidate);await assert.rejects(qualifyCareIntentResumptionSource(f.d.root,f.v.root,candidate));
 }
 f.d.put('scripts/dirty.mjs','uncommitted operator\n');
 await assert.rejects(qualifyCareIntentResumptionSource(f.d.root,f.v.root,f.candidate),/source_dirty/);
 f.d.commit();f.d.put('src/server/clinical-core/aws-identity-lambda.ts','exports.handler = async () => ({statusCode: 200});\n');f.d.commit();
 await assert.rejects(qualifyCareIntentResumptionSource(f.d.root,f.v.root,f.candidate),/runtime_changed/);
});
test('source-only CLI has no AWS target, approval, report authority, custody override or paid build surface',()=>{
 const args=['--v2-root','mobile','--candidate','candidate','--qualify-interrupted-application-source-only'];
 assert.deepEqual(careIntentResumptionSourceArgs(args),{mobileRoot:resolve('mobile'),directory:resolve('candidate')});
 for(const extra of ['--target','--report','--approve','--resume','--unlock','--phi','--skip','--qualifier','--build'])
  assert.throws(()=>careIntentResumptionSourceArgs([...args,extra]),/resume_source_arguments/);
 for(const changed of [[],args.slice(0,4),[...args.slice(0,4),'--resume'],['--v2-root','--approve',...args.slice(2)],
  ['--v2-root','',...args.slice(2)]])assert.throws(()=>careIntentResumptionSourceArgs(changed),/resume_source_arguments/);
 const code=readFileSync(new URL('./care-intent-resumption-source.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(code,/from ['"]@aws-sdk|intentAws\(|unlinkSync|renameSync|writeFileSync|process\.env/);
});
