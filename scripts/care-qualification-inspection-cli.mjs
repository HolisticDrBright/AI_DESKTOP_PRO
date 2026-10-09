/** Read-only inspection: never deploys, signs reviews, registers consent or enables PHI. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,unlinkSync,rmdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CareObservationError,inspectCareMessagingQualification,inspectCareConnectionsQualification,canonical} from './care-messaging-qualification-observer.mjs';
import {inspectionAwsReader,inspectionCodeReader,inspectionLedgerReader} from './care-messaging-inspection-io.mjs';
import {qualificationConsentArtifact} from './qualification-consent-ledger.mjs';

const local=(program,args,maxBuffer=8*1024*1024)=>execFileSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer,windowsHide:true,stdio:['ignore','pipe','pipe']});
const source=()=>({head:local('git',['rev-parse','HEAD']).trim(),dirty:local('git',['status','--porcelain','--untracked-files=all']).trim()});
const load=directory=>{
 for(const [name,bound] of [['artifact-manifest.json',65536],['index.js',16*1024*1024],['template.json',1024*1024],['deployment.zip',16*1024*1024+1024]])
  if(!statSync(join(directory,name)).isFile()||statSync(join(directory,name)).size>bound)throw new CareObservationError('artifact_refused');
 return {manifest:JSON.parse(readFileSync(join(directory,'artifact-manifest.json'),'utf8')),
  code:readFileSync(join(directory,'index.js')),templateBytes:readFileSync(join(directory,'template.json')),zip:readFileSync(join(directory,'deployment.zip'))};
};
export async function runCareInspection(candidate){
 if(!['care-messaging','care-connections'].includes(candidate))throw new CareObservationError('argument_refused');
 const inspector=candidate==='care-connections'?inspectCareConnectionsQualification:inspectCareMessagingQualification;
 let temporary;
try{
 const args=process.argv.slice(2),options={};
 for(const arg of args){const match=/^--(artifact-dir|binding)=(.+)$/.exec(arg);
  if(!match||Object.hasOwn(options,match[1]))throw new CareObservationError('argument_refused');options[match[1]]=match[2];}
 const first=source();if(first.dirty)throw new CareObservationError('dirty_source_refused');
 const expected=qualificationConsentArtifact(JSON.parse(local(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'])));
 // Rebuild from this clean checkout; a caller-supplied manifest cannot self-certify.
 temporary=mkdtempSync(join(tmpdir(),'alp-care-rebuild-'));
 local(process.execPath,[`scripts/build-aws-${candidate}.mjs`,'--out-dir='+temporary]);
 const artifact=load(temporary);
 if(options['artifact-dir']){
  const supplied=load(resolve(options['artifact-dir']));
  if(canonical(supplied.manifest)!==canonical(artifact.manifest)||!supplied.code.equals(artifact.code)
   ||!supplied.templateBytes.equals(artifact.templateBytes)||!supplied.zip.equals(artifact.zip))throw new CareObservationError('rebuilt_artifact_mismatch');
 }
 let binding;
 if(options.binding){const path=resolve(options.binding);if(statSync(path).size>32768)throw new CareObservationError('binding_refused');binding=JSON.parse(readFileSync(path,'utf8'));}
 const readAws=inspectionAwsReader(undefined,candidate);
 const inspectLedger=inspectionLedgerReader(expected);
 const report=await inspector({artifact,head:first.head,binding,readAws,readCodeVersion:inspectionCodeReader(readAws),inspectLedger});
 const last=source();if(last.dirty||last.head!==first.head)throw new CareObservationError('source_changed');
 console.log(JSON.stringify(report));
}catch(error){
 console.error(JSON.stringify({status:'not_completed',category:error instanceof CareObservationError?error.category:'inspection_failed',
  mutations:false,acceptance:false,phiAllowed:false}));process.exitCode=1;
}finally{
 if(temporary){
  try{for(const name of readdirSync(temporary)){
   if(!['index.js','deployment.zip','artifact-manifest.json','template.json'].includes(name))throw new Error('unexpected file');
   unlinkSync(join(temporary,name));
  }rmdirSync(temporary);}catch{console.error(JSON.stringify({status:'not_completed',category:'temporary_cleanup_failed'}));process.exitCode=1;}
 }
}
}
