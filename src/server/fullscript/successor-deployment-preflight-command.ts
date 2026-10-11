import {openSync,lstatSync,fstatSync,readSync,closeSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {inventorySourceIdentity} from '../../../scripts/inventory-qualification-source.mjs';
import {preflightSuccessorFullscriptDeployment} from './successor-deployment-preflight';
declare const __SUCCESSOR_FULLSCRIPT_PREFLIGHT_SOURCE__:{sourceCommit:string;sourceClean:boolean;sourceInputSha256:string};
function readBounded(path:string,maximum:number):Buffer{
 if(!isAbsolute(path))throw Error('refused');
 const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink())throw Error('refused');
 const fd=openSync(path,'r');
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.size===0||stat.size>maximum||stat.ino!==before.ino||stat.dev!==before.dev)throw Error('refused');
  const bytes=Buffer.alloc(stat.size);let read=0;
  while(read<bytes.length){const count=readSync(fd,bytes,read,bytes.length-read,null);if(count===0)throw Error('refused');read+=count;}
  const after=fstatSync(fd);
  if(readSync(fd,Buffer.alloc(1),0,1,null)!==0||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('refused');
  return bytes;
 }finally{closeSync(fd);}
}
try{
 const args=process.argv.slice(2);
 if(args.length!==6||args[0]!=='--inspect-fictional-successor-fullscript-only'
  ||typeof __SUCCESSOR_FULLSCRIPT_PREFLIGHT_SOURCE__==='undefined')throw Error('refused');
 const compiled=__SUCCESSOR_FULLSCRIPT_PREFLIGHT_SOURCE__,observed=inventorySourceIdentity();
 if(compiled.sourceClean!==true||JSON.stringify(compiled)!==JSON.stringify(observed))throw Error('refused');
 const [,manifest,zip,template,target,parameters]=args;
 const result=preflightSuccessorFullscriptDeployment({source:observed,buildBytes:readBounded(manifest,8192),
  zipBytes:readBounded(zip,16*1024*1024),templateBytes:readBounded(template,65536),
  targetBytes:readBounded(target,65536),parameterBytes:readBounded(parameters,65536)});
 if(JSON.stringify(inventorySourceIdentity())!==JSON.stringify(observed))throw Error('refused');
 console.log(JSON.stringify({...result,sourceObserved:true,sourceObservation:'before_and_after_not_atomic'}));
}catch{console.error('successor_fullscript_deployment_preflight_refused');process.exitCode=1;}
