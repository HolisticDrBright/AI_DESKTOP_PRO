import {openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {preflightFullscriptDeployment} from './qualification-deployment-preflight';
declare const __FULLSCRIPT_PREFLIGHT_BUILD__:{sourceCommit:string;clean:boolean};
function readBounded(path:string,maximum:number):Buffer {
 if(!isAbsolute(path))throw Error('refused');
 const fd=openSync(path,'r');
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size===0||stat.size>maximum)throw Error('refused');
  const bytes=Buffer.alloc(stat.size);let received=0;
  while(received<bytes.length){const count=readSync(fd,bytes,received,bytes.length-received,null);if(count===0)throw Error('refused');received+=count;}
  if(readSync(fd,Buffer.alloc(1),0,1,null)!==0)throw Error('refused');return bytes;
 }finally{closeSync(fd);}
}
try{
 const args=process.argv.slice(2);
 if(args.length!==6||args[0]!=='--inspect-fictional-fullscript-deployment-only'
  ||typeof __FULLSCRIPT_PREFLIGHT_BUILD__==='undefined'||!__FULLSCRIPT_PREFLIGHT_BUILD__.clean)throw Error('refused');
 const options={encoding:'utf8' as const,stdio:'pipe' as const,timeout:10000,windowsHide:true,maxBuffer:1024*1024};
 const sourceCommit=execFileSync('git',['rev-parse','HEAD'],options).trim();
 const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],options).trim();
 if(sourceCommit!==__FULLSCRIPT_PREFLIGHT_BUILD__.sourceCommit)throw Error('refused');
 const [,manifest,zip,template,target,parameters]=args;
 const report=preflightFullscriptDeployment({sourceCommit,clean,buildBytes:readBounded(manifest,8192),zipBytes:readBounded(zip,16*1024*1024),
  templateBytes:readBounded(template,65536),targetBytes:readBounded(target,65536),parameterBytes:readBounded(parameters,65536)});
 console.log(JSON.stringify(report));
}catch{console.error('fullscript_deployment_preflight_refused');process.exitCode=1;}
