// Operator-only entry point. There is no HTTP route or injectable transport.
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareFullscriptDeployment,runFullscriptDeployment,type DeploymentMode} from './qualification-deployment-execution';
import {createFullscriptDeploymentCustody} from './qualification-deployment-custody';
import {createNativeFullscriptResourcePort,createNativeFullscriptDeploymentPorts} from './qualification-deployment-native';
import {observeFullscriptDeploymentResources} from './qualification-deployment-resources';
declare const __FULLSCRIPT_DEPLOYMENT_BUILD__:{sourceCommit:string;clean:boolean};
const refuse=():never=>{throw Error('fullscript_deployment_command_refused');};
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
 const options={encoding:'utf8' as const,stdio:'pipe' as const,timeout:10000,windowsHide:true,maxBuffer:1024*1024};
 const sourceCommit=execFileSync('git',['rev-parse','HEAD'],options).trim();
 const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],options).trim();
 if(!clean||sourceCommit!==__FULLSCRIPT_DEPLOYMENT_BUILD__.sourceCommit)refuse();return {sourceCommit,clean};
}
async function main(){
 const args=process.argv.slice(2),modes=['inspect','deploy','resume-unadmitted','execute-prepared','observe'];
 if(args.length!==8||args[0]!=='--fictional-fullscript-deployment-only'||!modes.includes(args[1])
  ||typeof __FULLSCRIPT_DEPLOYMENT_BUILD__==='undefined'||!__FULLSCRIPT_DEPLOYMENT_BUILD__.clean)refuse();
 const files=args.slice(2),maxima=[8192,16*1024*1024,65536,65536,65536,16384],initial=files.map((p,i)=>bounded(p,maxima[i]));
 const input=()=>({ ...source(),buildBytes:initial[0],zipBytes:initial[1],templateBytes:initial[2],targetBytes:initial[3],parameterBytes:initial[4],reviewBytes:initial[5] });
 const plan=prepareFullscriptDeployment(input());
 const guard=async()=>{
  files.forEach((p,i)=>{if(!bounded(p,maxima[i]).equals(initial[i]))refuse();});
  const current=prepareFullscriptDeployment(input());if(current.reviewSha256!==plan.reviewSha256)refuse();
 };
 await guard();
 if(args[1]==='inspect'){
  const report=await observeFullscriptDeploymentResources(plan,createNativeFullscriptResourcePort(plan));await guard();
  console.log(JSON.stringify(report));return;
 }
 const mode=args[1] as DeploymentMode;
 const custody=createFullscriptDeploymentCustody({operatorFile:resolve(process.argv[1]),plan,mode});
 const report=await runFullscriptDeployment(plan,createNativeFullscriptDeploymentPorts(plan,custody,guard),mode);
 console.log(JSON.stringify(report));
}
void main().catch(()=>{console.error('fullscript_deployment_command_refused');process.exitCode=1;});
