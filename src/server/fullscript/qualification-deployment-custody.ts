import {constants,openSync,closeSync,writeFileSync,readSync,fstatSync,lstatSync,fsyncSync,linkSync,unlinkSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {hostname} from 'node:os';
import {randomBytes} from 'node:crypto';
import {deploymentCanonical,deploymentDigest,type DeploymentPlan,type DeploymentPorts,type DeploymentStage,type DeploymentMode} from './qualification-deployment-execution';
import {FULLSCRIPT_OPERATOR_SHARED_ROOT} from '../clinical-core/fullscript-native-custody';
type Options={root?:string;operatorFile:string;plan:DeploymentPlan;mode:DeploymentMode;
 runtime?:{pid:number;host:string;now():number;stopped(pid:number):boolean}};
const stages:DeploymentStage[]=['create_admitted','create_observed','execute_admitted','settled'];
const bytes=(v:unknown)=>Buffer.from(deploymentCanonical(v)+'\n');
const fail=():never=>{throw Error('fullscript_deployment_custody_refused');};
const check=(v:unknown)=>{if(!v)fail();};
function read(path:string,max=128*1024){
 const before=lstatSync(path);check(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=max);
 const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const opened=fstatSync(fd);check(opened.ino===before.ino&&opened.dev===before.dev&&opened.size===before.size&&opened.mtimeMs===before.mtimeMs);
  const b=Buffer.alloc(before.size+1);let received=0;
  while(received<b.length){const n=readSync(fd,b,received,b.length-received,received);if(!n)break;received+=n;}
  const final=fstatSync(fd),after=lstatSync(path);check(received===before.size&&final.size===before.size&&final.mtimeMs===before.mtimeMs
   &&after.ino===before.ino&&after.dev===before.dev&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&!after.isSymbolicLink());
  return b.subarray(0,received);
 }finally{closeSync(fd);}
}
function save(path:string,value:Buffer){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}
 check(read(path,Math.max(value.length,128*1024)).equals(value));}
function parse(value:Buffer){const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value));check(bytes(v).equals(value));return v;}
/** Complete files are synced before exclusive hard-link publication. Unused
 * temporary archives are inert. Numbered immutable writers replace stale-lock
 * deletion: the next slot can be claimed once, only after proving the previous
 * writer stopped. No process removes another writer's recovery record. */
export function createFullscriptDeploymentCustody(options:Options):DeploymentPorts['custody']{
 try{
  const root=resolve(options.root??FULLSCRIPT_OPERATOR_SHARED_ROOT),lock=resolve(root,'operator.lock');
  const runtime=options.runtime??{pid:process.pid,host:hostname(),now:Date.now,stopped:(pid:number)=>{
   try{process.kill(pid,0);return false;}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return false;return true;}}};
  check(Number.isSafeInteger(runtime.pid)&&runtime.pid>0&&runtime.host.length>0);
  const dirs:{path:string;ino:number;dev:number}[]=[];
  for(let path=root;;path=dirname(path)){const s=lstatSync(path);check(s.isDirectory()&&!s.isSymbolicLink());dirs.push({path,ino:s.ino,dev:s.dev});if(path===dirname(path))break;}
  const verifyDirs=()=>{for(const p of dirs){const s=lstatSync(p.path);check(s.isDirectory()&&!s.isSymbolicLink()&&s.ino===p.ino&&s.dev===p.dev);}};
  const operator=read(resolve(options.operatorFile),16*1024*1024),operatorSha256=deploymentDigest(operator);
  const runId=options.plan.review.runId;
  const binding={contract:'fullscript-deployment-custody/2',purpose:'qualification-fullscript-stack',runId,
   reviewSha256:options.plan.reviewSha256,sourceCommit:options.plan.sourceCommit,operatorSha256};
  const writerPath=(n:number)=>resolve(root,runId+'.fullscript-deployment.writer-'+n+'.json');
  const eventPath=(n:number)=>resolve(root,runId+'.fullscript-deployment.event-'+n+'.json');
  const operatorPath=resolve(root,runId+'.fullscript-deployment.operator.cjs');
  const publish=(path:string,value:Buffer)=>{
   verifyDirs();const archive=resolve(root,randomBytes(16).toString('hex')+'.fullscript-deployment.publication.json');
   save(archive,value);verifyDirs();linkSync(archive,path);check(read(path).equals(value));
  };
  const writer=(n:number)=>bytes({...binding,generation:n,pid:runtime.pid,host:runtime.host,at:new Date(runtime.now()).toISOString()});
  const validWriter=(v:Buffer,n:number)=>{
   const h=parse(v);check(Object.keys(h).sort().join(',')==='at,contract,generation,host,operatorSha256,pid,purpose,reviewSha256,runId,sourceCommit'
    &&Object.entries(binding).every(([k,value])=>h[k]===value)&&h.generation===n&&h.host===runtime.host
    &&Number.isSafeInteger(h.pid)&&h.pid>0&&Number.isFinite(Date.parse(h.at))&&Date.parse(h.at)<=runtime.now());return h;
  };
  const stopped=(h:ReturnType<typeof validWriter>)=>check(h.pid!==runtime.pid&&runtime.stopped(h.pid)&&runtime.now()-Date.parse(h.at)>=60000);
  let generation=0,headerBytes:Buffer,currentWriter:Buffer;
  const writerBytes:Buffer[]=[];
  type Event={stage:DeploymentStage;at:string;previousSha256:string;writerGeneration:number};
  const events:Event[]=[],eventBytes:Buffer[]=[];
  const loadEvents=()=>{
   let prior=deploymentDigest(headerBytes),at=0,writerGeneration=0;
   for(let i=0;i<stages.length;i++){
    if(!existsSync(eventPath(i))){for(let j=i+1;j<stages.length;j++)check(!existsSync(eventPath(j)));break;}
    const v=read(eventPath(i)),e=parse(v),time=Date.parse(e.at);
    check(Object.keys(e).sort().join(',')==='at,previousSha256,stage,writerGeneration'&&e.stage===stages[i]&&e.previousSha256===prior
     &&Number.isFinite(time)&&time>=at&&time<=runtime.now()&&Number.isSafeInteger(e.writerGeneration)
     &&e.writerGeneration>=writerGeneration&&e.writerGeneration<=generation
     &&time>=Date.parse(validWriter(writerBytes[e.writerGeneration],e.writerGeneration).at));
    events.push(e);eventBytes.push(v);prior=deploymentDigest(v);at=time;writerGeneration=e.writerGeneration;
   }
  };
  // Old /1 subsidiary locks are never silently retired or translated. No live
  // deployment used /1; an existing one needs its original operator review.
  check(!existsSync(resolve(root,'fullscript-deployment-recovery.lock')));
  if(options.mode==='deploy'){
   check(!existsSync(lock));headerBytes=writer(0);currentWriter=headerBytes;writerBytes.push(headerBytes);
   for(let i=0;i<stages.length;i++)check(!existsSync(eventPath(i)));
   save(operatorPath,operator);publish(writerPath(0),headerBytes);verifyDirs();linkSync(writerPath(0),lock);
  }else{
   headerBytes=read(lock);validWriter(headerBytes,0);check(read(writerPath(0)).equals(headerBytes));
   check(read(operatorPath,16*1024*1024).equals(operator));writerBytes.push(headerBytes);
   for(let i=1;existsSync(writerPath(i));i++){
    check(i<64);const v=read(writerPath(i));validWriter(v,i);writerBytes.push(v);generation=i;
   }
   const last=validWriter(writerBytes[generation],generation);stopped(last);loadEvents();
   check(options.mode==='resume-unadmitted'?events.length===0:
    events.length>0&&(options.mode==='observe'||!events.some(e=>e.stage==='execute_admitted')));
   // Exclusive creation of a NEW slot. A concurrent claimant cannot replace it
   // or mistake an observation timeout for a stopped writer.
   generation++;check(generation<64);currentWriter=writer(generation);publish(writerPath(generation),currentWriter);writerBytes.push(currentWriter);
  }
  let live=true;
  const verify=async()=>{
   check(live);verifyDirs();check(read(resolve(options.operatorFile),16*1024*1024).equals(operator)
    &&read(operatorPath,16*1024*1024).equals(operator)&&read(lock).equals(headerBytes)&&!existsSync(writerPath(generation+1)));
   for(let i=0;i<=generation;i++)check(read(writerPath(i)).equals(writerBytes[i]));
   for(let i=0;i<eventBytes.length;i++)check(read(eventPath(i)).equals(eventBytes[i]));
   for(let i=eventBytes.length;i<stages.length;i++)check(!existsSync(eventPath(i)));
  };
  return {verify,stages:()=>events.map(e=>e.stage),record:async stage=>{
   await verify();check(stage===stages[events.length]&&events.length<4);
   const e={stage,at:new Date(runtime.now()).toISOString(),previousSha256:deploymentDigest(events.length?eventBytes.at(-1)!:headerBytes),writerGeneration:generation};
   check(!events.length||Date.parse(e.at)>=Date.parse(events.at(-1)!.at));
   publish(eventPath(events.length),bytes(e));events.push(e);eventBytes.push(bytes(e));await verify();
  },finish:async report=>{
   await verify();const r=report as Record<string,unknown>;check(events.some(e=>e.stage==='execute_admitted')
    &&r.contract==='fullscript-deployment-observation/1'&&r.reviewSha256===binding.reviewSha256&&r.sourceCommit===binding.sourceCommit
    &&r.deployed===true&&r.controlPlaneObserved===true&&r.installedControlsObserved===true&&r.hostedQualified===false&&r.phiAllowed===false);
   save(resolve(root,randomBytes(16).toString('hex')+'.fullscript-deployment.receipt.json'),bytes(report));
   await verify();unlinkSync(lock);live=false; // numbered evidence remains immutable
  }};
 }catch{return fail();}
}
