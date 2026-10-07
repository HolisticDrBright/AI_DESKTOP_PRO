/** Source-only overlay mapping. No SQL apply, AWS request or activation. */
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const args=process.argv.slice(2);
if(args.length>1||args[0]&&!args[0].startsWith('--out-dir='))throw new Error('care_claim_source_argument_invalid');
const out=resolve(args[0]?.slice('--out-dir='.length)||'dist/aws-clinical-core/care-claim-recovery-source');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const baseline=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
  {encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024}));
const ledger=sha(baseline.manifest.migrations.map(m=>`${m.version}:${sha(baseline.files[m.file])}`).join('\n'));
if(baseline.manifest.migrations.length!==105||ledger!=='7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743')
  throw new Error('care_claim_predecessor_changed');
const sql=readFileSync('infra/aws-clinical-core/production-candidates/care-claim-recovery.sql','utf8').replace(/\r\n?/g,'\n');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceDirty=!!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],{encoding:'utf8'}).trim();
mkdirSync(out,{recursive:true});
const libraries=[];
for(const [name,entry] of [['api','care-claim-recovery-api.ts'],['service','care-claim-recovery.ts'],
  ['database-binding','care-claim-recovery-database-binding.ts'],['schema-upgrade','care-claim-recovery-schema-upgrade.ts']]){
  const file=`${name}-library.cjs`;
  await build({entryPoints:[`src/server/clinical-core/${entry}`],outfile:resolve(out,file),platform:'node',target:'node22',format:'cjs',
    bundle:true,minify:true,legalComments:'none'});
  libraries.push({file,sha256:sha(readFileSync(resolve(out,file)))});
}
const functions=bytes=>[...bytes.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
  .map(([,name,body])=>({name,bodySha256:sha(body),apiExecute:name.startsWith('clinical_core.')}));
const dependencyFunctions=functions(baseline.files['20261006020000_production_care_connections.sql']),overlayFunctions=functions(sql);
const binding=createRequire(import.meta.url)(resolve(out,'database-binding-library.cjs'));
binding.validateCareClaimFunctions(overlayFunctions);
if(dependencyFunctions.length!==7)throw new Error('care_claim_dependency_invalid');
writeFileSync(resolve(out,'care-claim-recovery.sql'),sql);
const upgrade=createRequire(import.meta.url)(resolve(out,'schema-upgrade-library.cjs')).CARE_CLAIM_RECOVERY_UPGRADE;
const proposedFile=`${upgrade.version}_production_care_claim_recovery.sql`;
const proposedMigrations=[...baseline.manifest.migrations,{version:upgrade.version,file:proposedFile}];
const proposedLedger=sha([...baseline.manifest.migrations.map(m=>`${m.version}:${sha(baseline.files[m.file])}`),
  `${upgrade.version}:${sha(sql)}`].join('\n'));
if(upgrade.from!==ledger||upgrade.to!==proposedLedger||upgrade.sqlSha256!==sha(sql))throw new Error('care_claim_prepared_upgrade_invalid');
const preparedDirectory=resolve(out,'prepared-migrations');mkdirSync(preparedDirectory,{recursive:true});
for(const m of baseline.manifest.migrations)writeFileSync(resolve(preparedDirectory,m.file),baseline.files[m.file]);
writeFileSync(resolve(preparedDirectory,proposedFile),sql);
const preparedManifest=JSON.stringify({contract_version:'clinical-core-migrations/1',migrations:proposedMigrations},null,2)+'\n';
writeFileSync(resolve(preparedDirectory,'manifest.json'),preparedManifest);
// Self-contained operator: adjacent dist files, cwd and environment cannot
// substitute a different migration history after the source artifact is built.
const embeddedMigrations=proposedMigrations.map(m=>({version:m.version,name:m.file.slice(15,-4),
  sql:m.version===upgrade.version?sql:baseline.files[m.file],
  sha256:sha(m.version===upgrade.version?sql:baseline.files[m.file])}));
const operatorFile='qualification-upgrade-operator.cjs';
await build({entryPoints:['src/server/clinical-core/care-claim-recovery-schema-upgrade-operator.ts'],outfile:resolve(out,operatorFile),
  bundle:true,platform:'node',target:'node22',format:'cjs',minify:false,sourcemap:false,legalComments:'none',treeShaking:true,
  define:{__CARE_CLAIM_RECOVERY_UPGRADE_BUILD__:JSON.stringify({sourceCommit,clean:!sourceDirty}),
    __CARE_CLAIM_RECOVERY_MIGRATIONS__:JSON.stringify(embeddedMigrations)}});
const manifest={contract:'care-claim-recovery-source-candidate/1',status:'unreleased',deployable:false,sourceCommit,sourceDirty,
  predecessor:{migrationCount:105,ledgerReleaseSha256:ledger,canonicalAssemblySha256:baseline.releaseHash},
  overlay:{file:'care-claim-recovery.sql',sha256:sha(sql),bytes:Buffer.byteLength(sql),canonical:false,hostedVerified:false},
  libraries,dependencyFunctions,functions:overlayFunctions,
  preparedTransition:{status:'unregistered',canonical:false,qualificationOnly:true,operatorReleased:true,
    fromLedgerSha256:upgrade.from,toLedgerSha256:upgrade.to,migrationCount:106,tableCountBefore:207,tableCountAfter:209,
    mandatoryRollbackRehearsal:true,manifest:{file:'prepared-migrations/manifest.json',sha256:sha(preparedManifest)},
    operator:{file:operatorFile,sha256:sha(readFileSync(resolve(out,operatorFile))),scope:'prepared_qualification_only',
      embeddedMigrations:true,observedTarget:true,postRehearsalTargetRecheck:true,migrationPerformed:false}},
  proposedRoutes:['POST /clinical-core/consumer/connection-claims'],
  reviewRequired:'separate claim recovery/settlement review; source digests are not review evidence',
  proposedCoveredEntityMapping:[
    {table:'clinical_core.care_claim_requests',scope:'organization_column',column:'organization_id',ownerColumn:'consumer_person_id',
      dependsOn:['clinical_core.patient_connections'],appendOnly:true,
      disposition:'Blocked by immutable trigger until a separately reviewed clinic retention/disposition procedure exists; inventory is not deletion authority.',
      status:'inventory_and_disposition_pending'},
    {table:'clinical_audit.care_claim_events',scope:'organization_column',column:'organization_id',ownerColumn:'consumer_person_id',
      appendOnly:true,
      disposition:'Blocked by immutable trigger until a separately reviewed clinic retention/disposition procedure exists; inventory is not deletion authority.',
      status:'inventory_and_disposition_pending'},
  ],
  activation:'blocked',phiAllowed:false,seededApprovals:false,seededIdentities:false,seededConsents:false,
  remaining:['canonical 105-prefix promotion and reviewed disposition; hosted verification of the qualification-only bound upgrade operator',
    'V2 request-id journal migration preserving id-less legacy uncertainty; explicit receipt and settlement UI',
    'new route/Lambda/template/fleet/qualification target and capacity integration',
    'reviewed metadata binding and independent recovery/security/retention review',
    'exact-source synthetic deployment and real multi-session race/second-device acceptance',
    'matched releases and physical iOS/Android acceptance'],
};
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:'unreleased',deployable:false,sourceCommit,sourceDirty,predecessorLedgerSha256:ledger,
  overlaySha256:manifest.overlay.sha256,libraries}));
