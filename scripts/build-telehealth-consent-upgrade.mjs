// Build only. No AWS observations, migration, fixture, review or activation.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {build} from 'esbuild';
import {inventorySourceIdentity} from './inventory-qualification-source.mjs';
const args=process.argv.slice(2);
if(args.length>1 || args.length && (!args[0].startsWith('--out-dir=') || !isAbsolute(args[0].slice(10))))
  throw Error('telehealth_consent_upgrade_build_argument_refused');
const out=resolve(args.length?args[0].slice(10):'dist/aws-clinical-core/telehealth-consent-upgrade');
const identity=inventorySourceIdentity();
const sourceCommit=identity.sourceCommit,clean=identity.sourceClean;
const sha=v=>createHash('sha256').update(v).digest('hex');
const a=JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
  {encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
if(a.candidate?.contract!=='telehealth-consent-copy-candidate/1' || a.candidate.migrationCount!==112
  || a.manifest.migrations.length!==112 || a.candidate.migrationReleaseSha256!=='45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4'
  || a.releaseHash!=='6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9'
  || a.candidate.extensionSha256!=='5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e'
  || a.candidate.activation!=='blocked' || a.candidate.phiAllowed!==false)
  throw Error('telehealth_consent_upgrade_build_artifact_refused');
const migrations=a.manifest.migrations.map(r=>({version:r.version,name:r.file.slice(15,-4),sql:a.files[r.file],sha256:sha(a.files[r.file])}));
const compiled=await build({entryPoints:['src/server/clinical-core/telehealth-consent-schema-upgrade-operator.ts'],outfile:join(out,'index.cjs'),write:false,
  bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:false,legalComments:'none',treeShaking:true,
  define:{__TELEHEALTH_CONSENT_UPGRADE_BUILD__:JSON.stringify({sourceCommit,clean}),__TELEHEALTH_CONSENT_UPGRADE_MIGRATIONS__:JSON.stringify(migrations)}});
// Paired source-byte observations, not an atomic filesystem snapshot. Do not
// publish a manifest or runnable bytes if compilation observed source drift.
if(JSON.stringify(inventorySourceIdentity())!==JSON.stringify(identity))throw Error('telehealth_consent_upgrade_build_source_changed');
if(compiled.outputFiles.length!==1)throw Error('telehealth_consent_upgrade_build_output_refused');
mkdirSync(out,{recursive:true});writeFileSync(join(out,'index.cjs'),compiled.outputFiles[0].contents);
writeFileSync(join(out,'artifact-manifest.json'),JSON.stringify({contract:'telehealth-consent-upgrade-build/1',sourceCommit,clean,
  sourceInputSha256:identity.sourceInputSha256,sourceObservation:'before_and_after_not_atomic',
  operatorSha256:sha(readFileSync(join(out,'index.cjs'))),embeddedMigrationCount:migrations.length,
  fromReleaseSha256:'98ef31a24baeafb83bfd65a7832b1e4e02dbe1c71b6e78f8efdad4e0b0e62d4c',
  toReleaseSha256:a.candidate.migrationReleaseSha256,migrationArtifactSha256:a.releaseHash,execution:'qualification_only',phiAllowed:false,activation:'blocked',
  migrationPerformed:false,mandatoryRollbackRehearsal:true,automaticWriteRetry:false,durableNativeCustody:true,
  sharedOperatorNamespace:true,readOnlyInterruptionReconciliation:true,hostedRecoveryQualified:false,targetReviewRequired:true},null,2)+'\n');
console.log(JSON.stringify({built:true,sourceCommit,clean,migrationPerformed:false,phiAllowed:false,activation:'blocked'}));
