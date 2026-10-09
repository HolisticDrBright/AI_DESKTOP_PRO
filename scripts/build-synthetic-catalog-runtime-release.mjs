/** Build-only. No AWS operation or mobile build. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildCatalogRuntimeCandidate,writeCatalogRuntimeCandidate} from './synthetic-catalog-runtime-release.mjs';
import {careRegisteredBuildArguments} from './build-synthetic-care-registered-release.mjs';
import {careRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
export async function runCatalogRuntimeBuild(root,args){
 const {mobileRoot}=careRegisteredBuildArguments(args),candidate=await buildCatalogRuntimeCandidate(root,mobileRoot);
 const directory=writeCatalogRuntimeCandidate(root,candidate);
 if(canonical(careRegisteredCurrent(root,mobileRoot))!==canonical(candidate.current))refuseRegistered('catalog_runtime_source_changed');
 return {contract:candidate.manifest.contract,directory,desktopCommit:candidate.current.desktop.commit,
  mobileCommit:candidate.current.mobile.source.commit,zipSha256:candidate.manifest.zipSha256,zipBytes:candidate.zip.length,
  built:true,deployed:false,releaseAccepted:false,erasureAccepted:false,paidMobileBuildStarted:false,phiAllowed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runCatalogRuntimeBuild(process.cwd(),process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{
  console.error('synthetic_care_registered_release_refused:catalog_runtime_build');process.exitCode=1;
 });
}
