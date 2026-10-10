// Build only. No AWS observations, migration, fixture, review or activation.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
if(process.argv.length!==2)throw Error('fullscript_upgrade_build_argument_refused');
const sha=v=>createHash('sha256').update(v).digest('hex');
const a=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],
  {encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
const migrations=a.manifest.migrations.map(r=>({version:r.version,name:r.file.slice(15,-4),sql:a.files[r.file],sha256:sha(a.files[r.file])}));
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra',
  'package.json','package-lock.json','.gitattributes','.github'],{encoding:'utf8',windowsHide:true}).trim();
const out='dist/aws-clinical-core/fullscript-upgrade';mkdirSync(out,{recursive:true});
await build({entryPoints:['src/server/clinical-core/fullscript-schema-upgrade-operator.ts'],outfile:`${out}/index.cjs`,
  bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:false,legalComments:'none',treeShaking:true,
  define:{__FULLSCRIPT_UPGRADE_BUILD__:JSON.stringify({sourceCommit,clean}),__FULLSCRIPT_UPGRADE_MIGRATIONS__:JSON.stringify(migrations)}});
writeFileSync(`${out}/artifact-manifest.json`,JSON.stringify({contract:'fullscript-upgrade-build/1',sourceCommit,clean,
  operatorSha256:sha(readFileSync(`${out}/index.cjs`)),embeddedMigrationCount:migrations.length,
  fromReleaseSha256s:[a.candidate.parentMigrationReleaseSha256,'542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c'],
  toReleaseSha256:a.candidate.migrationReleaseSha256,migrationArtifactSha256:a.releaseHash,execution:'qualification_only',phiAllowed:false,activation:'blocked',
  migrationPerformed:false,mandatoryRollbackRehearsal:true,automaticWriteRetry:false,durableNativeCustody:true,
  sharedOperatorNamespace:true,readOnlyInterruptionReconciliation:true,hostedRecoveryQualified:false,targetReviewRequired:true},null,2)+'\n');
console.log(JSON.stringify({built:true,sourceCommit,clean,migrationPerformed:false,phiAllowed:false,activation:'blocked'}));
