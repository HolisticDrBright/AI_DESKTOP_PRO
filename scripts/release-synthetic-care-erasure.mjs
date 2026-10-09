/** Actual fixed-target release. Recovery and schema work share one operator lock. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {careSourceSnapshot,sha256,refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {runCareRecovery,recoveryFailureCode} from './rehearse-synthetic-care-routing.mjs';
import {releaseCareErasure} from './care-erasure-release.mjs';
export function careErasureReleaseArgs(args){
 if(args.length!==1||args[0]!=='--release-fictional-care-erasure-with-fresh-recovery')fail('erasure_release_arguments');
}
export function verifyCareErasureReleaseArtifact(manifest,bytes,source){
 if(manifest?.contract!=='synthetic-care-erasure-release-build/1'||manifest.sourceCommit!==source.commit||manifest.clean!==true
  ||manifest.sha256!==sha256(bytes)||manifest.execution!=='synthetic-staging'||manifest.phiAllowed!==false
  ||manifest.migrationPerformed!==false||manifest.embeddedMigrations!==true||manifest.embeddedReferenceMigrations!==true
  ||manifest.targetOverrides!==false||manifest.expectedLiveBefore!==46||manifest.expectedLiveAfter!==47
  ||manifest.mandatoryFreshRoutingRecovery!==true||manifest.mandatoryRollbackRehearsal!==true)fail('erasure_release_artifact');
}
async function main(){
 careErasureReleaseArgs(process.argv.slice(2));const root=process.cwd(),source=careSourceSnapshot(root,'desktop'),started=Date.now();
 execFileSync(process.execPath,[resolve(root,'scripts/build-care-erasure-release.mjs')],
  {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const dir=resolve(root,'dist/aws-clinical-core/care-erasure-release'),manifest=JSON.parse(readFileSync(resolve(dir,'artifact-manifest.json'),'utf8'));
 verifyCareErasureReleaseArtifact(manifest,readFileSync(resolve(dir,'index.cjs')),source);
 const {runCareErasureReleaseDatabase}=createRequire(import.meta.url)(resolve(dir,'index.cjs'));
 if(typeof runCareErasureReleaseDatabase!=='function')fail('erasure_release_database_port');
 // Do not wrap this in a child-process timeout: killing routing recovery can
 // interrupt compensation. Await its actual terminal state, never blind retry.
 const result=await runCareRecovery(async(recovery,transport)=>{
  const release=await releaseCareErasure(recovery,{started,now:Date.now,source:async()=>careSourceSnapshot(root,'desktop'),
   transport,schema:async command=>runCareErasureReleaseDatabase(command,source.commit)});
  const report=recovery.report.replace(/\.json$/,'.release.json');
  writeFileSync(report,JSON.stringify({...release,recoveryReport:recovery.report,completedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  return {report,...release};
 });
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 const category=['boundary_refused','artifact_refused','history_refused','inventory_refused','upgrade_busy','data_changed','verification_failed','upgrade_failed'];
 console.error(category.includes(error?.category)?'care_erasure_release_'+error.category:recoveryFailureCode(error,'rehearsal'));process.exitCode=1;
});
