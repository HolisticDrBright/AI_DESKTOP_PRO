/** Build only. No AWS access, schema mutation, activation or mobile build. */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
try{
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--v2-root'||args[1].startsWith('--'))refuseIntent('arguments');
 const c=await buildCareIntentCandidate(process.cwd(),resolve(args[1]));
 const directory=resolve('dist/synthetic-care-intent-release',c.manifest.desktop.commit,c.manifest.mobile.source.commit);
 mkdirSync(directory,{recursive:true});
 for(const [name,bytes] of [['index.js',c.bundle],['candidate.zip',c.zip],
  ['release.json',JSON.stringify(c.release)+'\n'],['artifact-manifest.json',JSON.stringify(c.manifest,null,2)+'\n']]){
  const file=resolve(directory,name);
  try{writeFileSync(file,bytes,{flag:'wx'});}catch{if(!readFileSync(file).equals(Buffer.from(bytes)))refuseIntent('artifact_collision');}
 }
 console.log(JSON.stringify({directory,desktopCommit:c.manifest.desktop.commit,mobileCommit:c.manifest.mobile.source.commit,
  zipSha256:c.manifest.zipSha256,built:true,deployed:false,schemaChanged:false,canonicalRegistered:false,
  paidMobileBuildStarted:false,phiAllowed:false}));
}catch(error){
 console.error(error.message?.startsWith('synthetic_care_intent_release_refused:')?error.message:'synthetic_care_intent_release_refused:build');
 process.exitCode=1;
}
