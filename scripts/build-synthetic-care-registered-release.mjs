/** Build-only entry point. No upload, API execution, database replay or mobile build. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildCareRegisteredCandidate,careRegisteredCurrent,writeCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
export function careRegisteredBuildArguments(args){
 if(args.length!==2||args[0]!=='--v2-root'||typeof args[1]!=='string'||!args[1]||args[1].startsWith('--'))refuseRegistered('arguments');
 return {mobileRoot:resolve(args[1])};
}
export async function runCareRegisteredBuild(root,args){
 const {mobileRoot}=careRegisteredBuildArguments(args),candidate=await buildCareRegisteredCandidate(root,mobileRoot);
 const directory=writeCareRegisteredCandidate(root,candidate);
 if(JSON.stringify(careRegisteredCurrent(root,mobileRoot))!==JSON.stringify(candidate.current))refuseRegistered('source_changed');
 return {contract:candidate.manifest.contract,directory,desktopCommit:candidate.current.desktop.commit,
  mobileCommit:candidate.current.mobile.source.commit,zipSha256:candidate.manifest.zipSha256,zipBytes:candidate.zip.length,
  built:true,canonicalRegistered:true,deployed:false,releaseAccepted:false,erasureAccepted:false,
  paidMobileBuildStarted:false,phiAllowed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runCareRegisteredBuild(process.cwd(),process.argv.slice(2)).then(r=>{console.log(JSON.stringify(r));}).catch(error=>{
  const code=error instanceof Error?error.message:'';
  console.error(/^synthetic_care_(?:registered_release|release)_refused:[a-z_]+$/.test(code)?code:'synthetic_care_registered_release_refused:build');
  process.exitCode=1;
 });
}
