// Separate operator-only command. No HTTP route or injectable AWS transport.
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync,mkdtempSync,rmSync} from 'node:fs';
import {isAbsolute,resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {inventorySourceIdentity} from '../../../scripts/inventory-qualification-source.mjs';
import {prepareSuccessorFullscriptDeployment,runSuccessorFullscriptDeployment,type DeploymentMode} from './successor-deployment-execution';
import {createSuccessorFullscriptDeploymentCustody} from './successor-deployment-custody';
import {createNativeSuccessorFullscriptResourcePort,createNativeSuccessorFullscriptDeploymentPorts} from './successor-deployment-native';
import {observeFullscriptDeploymentResources} from './successor-deployment-resources';

declare const __SUCCESSOR_FULLSCRIPT_DEPLOYMENT_BUILD__:{sourceCommit:string;sourceClean:true;sourceInputSha256:string};
const refuse=():never=>{throw Error('successor_fullscript_deployment_command_refused');};
function bounded(path:string,max:number){
 if(!isAbsolute(path))refuse();const before=lstatSync(path);
 if(!before.isFile()||before.isSymbolicLink()||before.size<=0||before.size>max)refuse();
 const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const opened=fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)refuse();
  const bytes=Buffer.alloc(before.size+1);let n=0;
  while(n<bytes.length){const count=readSync(fd,bytes,n,bytes.length-n,n);if(!count)break;n+=count;}
  const end=fstatSync(fd),after=lstatSync(path);
  if(n!==before.size||end.size!==before.size||end.mtimeMs!==before.mtimeMs||after.isSymbolicLink()
   ||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)refuse();
  return bytes.subarray(0,n);
 }finally{closeSync(fd);}
}
function source(){
 const current=inventorySourceIdentity();
 if(current.sourceClean!==true||JSON.stringify(current)!==JSON.stringify(__SUCCESSOR_FULLSCRIPT_DEPLOYMENT_BUILD__))refuse();
 return current;
}
async function main(){
 const args=process.argv.slice(2),modes=['validate','inspect','deploy','resume-unadmitted','execute-prepared','observe'];
 if(args.length!==8||args[0]!=='--fictional-successor-fullscript-deployment-only'||!modes.includes(args[1])
  ||typeof __SUCCESSOR_FULLSCRIPT_DEPLOYMENT_BUILD__==='undefined'||__SUCCESSOR_FULLSCRIPT_DEPLOYMENT_BUILD__.sourceClean!==true)refuse();
 const identity=source(),files=args.slice(2),maxima=[8192,16*1024*1024,65536,65536,65536,16384];
 const initial=files.map((p,i)=>bounded(p,maxima[i]));
 const input=()=>({source:source(),buildBytes:initial[0],zipBytes:initial[1],templateBytes:initial[2],targetBytes:initial[3],parameterBytes:initial[4],reviewBytes:initial[5]});
 const plan=prepareSuccessorFullscriptDeployment(input());
 // Independently run the actual API producer from the exact clean checkout.
 // Caller-supplied report fields cannot replace this rebuild or byte comparison.
 const parent=resolve(tmpdir()),rebuilt=mkdtempSync(join(parent,'alp-successor-fullscript-rebuild-'));
 try{
  execFileSync(process.execPath,['scripts/build-successor-fullscript-api.mjs','--out-dir='+rebuilt],{
   stdio:'pipe',timeout:120000,maxBuffer:16*1024*1024,windowsHide:true});
  for(const [name,index] of [['artifact-manifest.json',0],['function.zip',1],['template.json',2]] as const)
   if(!bounded(join(rebuilt,name),maxima[index]).equals(initial[index]))refuse();
  if(JSON.stringify(source())!==JSON.stringify(identity))refuse();
 }finally{
  if(dirname(resolve(rebuilt))!==parent||!resolve(rebuilt).startsWith(join(parent,'alp-successor-fullscript-rebuild-'))
   ||lstatSync(rebuilt).isSymbolicLink())refuse();
  rmSync(rebuilt,{recursive:true,force:true});
 }
 const guard=async()=>{
  files.forEach((p,i)=>{if(!bounded(p,maxima[i]).equals(initial[i]))refuse();});
  const current=prepareSuccessorFullscriptDeployment(input());
  if(JSON.stringify(current)!==JSON.stringify(plan))refuse();
 };
 await guard();
 if(args[1]==='validate'){
  console.log(JSON.stringify({contract:'successor-fullscript-deployment-validation/1',verdict:'locally_consistent',
   sourceCommit:plan.sourceCommit,sourceInputSha256:plan.sourceInputSha256,migrationCount:plan.migrationCount,
   migrationReleaseSha256:plan.migrationReleaseSha256,migrationAssemblySha256:plan.migrationAssemblySha256,
   zipSha256:plan.zipSha256,templateSha256:plan.templateSha256,targetSha256:plan.targetSha256,
   parameterSha256:plan.parameterSha256,reviewSha256:plan.reviewSha256,
   sourceObserved:true,sourceRebuilt:true,sourceObservation:'before_and_after_not_atomic',
   awsObserved:false,approvedForDeployment:false,deployed:false,providerActionPerformed:false,
   completeFleetQualified:false,hostedQualified:false,phiAllowed:false,activation:'blocked'}));return;
 }
 if(args[1]==='inspect'){
  const report=await observeFullscriptDeploymentResources(plan,createNativeSuccessorFullscriptResourcePort(plan));await guard();
  console.log(JSON.stringify({...report,sourceObserved:true,sourceRebuilt:true,sourceObservation:'before_and_after_not_atomic'}));return;
 }
 const mode=args[1] as DeploymentMode;
 const custody=createSuccessorFullscriptDeploymentCustody({operatorFile:resolve(process.argv[1]),plan,mode});
 const report=await runSuccessorFullscriptDeployment(plan,createNativeSuccessorFullscriptDeploymentPorts(plan,custody,guard),mode);
 console.log(JSON.stringify({...report,sourceObserved:true,sourceRebuilt:true,sourceObservation:'before_and_after_not_atomic'}));
}
void main().catch(()=>{console.error('successor_fullscript_deployment_command_refused');process.exitCode=1;});
