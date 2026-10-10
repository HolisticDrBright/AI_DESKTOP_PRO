import {constants,openSync,closeSync,writeFileSync,readSync,fstatSync,lstatSync,fsyncSync,linkSync,unlinkSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {hostname} from 'node:os';
import {randomBytes} from 'node:crypto';
import {deploymentCanonical,deploymentDigest,type DeploymentPlan,type DeploymentPorts,type DeploymentStage} from './qualification-deployment-execution';
import {FULLSCRIPT_OPERATOR_SHARED_ROOT} from '../clinical-core/fullscript-native-custody';
type Options={root?:string;operatorFile:string;plan:DeploymentPlan;mode:'deploy'|'execute-prepared'|'observe';
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
/** Native shared-process custody. There is intentionally no stale-lock timeout
 * deletion. Recovery pins the same review/operator and requires a dead original
 * process on this host, then publishes its own exclusive hard-link guard. */
export function createFullscriptDeploymentCustody(options:Options):DeploymentPorts['custody']{
 try{
  const root=resolve(options.root??FULLSCRIPT_OPERATOR_SHARED_ROOT),lock=resolve(root,'operator.lock');
  const guardPath=resolve(root,'fullscript-deployment-recovery.lock');
  const runtime=options.runtime??{pid:process.pid,host:hostname(),now:Date.now,stopped:(pid:number)=>{
   try{process.kill(pid,0);return false;}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return false;return true;}}};
  check(Number.isSafeInteger(runtime.pid)&&runtime.pid>0&&runtime.host.length>0);
  const dirs:{path:string;ino:number;dev:number}[]=[];
  for(let path=root;;path=dirname(path)){const s=lstatSync(path);check(s.isDirectory()&&!s.isSymbolicLink());dirs.push({path,ino:s.ino,dev:s.dev});if(path===dirname(path))break;}
  const operator=read(resolve(options.operatorFile),16*1024*1024),operatorSha256=deploymentDigest(operator);
  const runId=options.plan.review.runId,journalPath=resolve(root,runId+'.fullscript-deployment.journal.json');
  const binding={contract:'fullscript-deployment-custody/1',purpose:'qualification-fullscript-stack',runId,
   reviewSha256:options.plan.reviewSha256,sourceCommit:options.plan.sourceCommit,operatorSha256};
  let headerBytes:Buffer,journalBytes:Buffer,headerFile:string,guardBytes:Buffer|undefined,guardFile:string|undefined;
  type Event={stage:DeploymentStage;at:string;previousSha256:string};
  let events:Event[]=[];
  const checkedEvents=(v:unknown,header:Buffer):Event[]=>{
   if(!Array.isArray(v)||v.length>4)return fail();let prior=deploymentDigest(header),at=0;
   for(let i=0;i<v.length;i++){const e=v[i],n=Date.parse(e?.at);check(e&&Object.keys(e).sort().join(',')==='at,previousSha256,stage'
    &&e.stage===stages[i]&&e.previousSha256===prior&&Number.isFinite(n)&&n>=at&&n<=runtime.now());prior=deploymentDigest(bytes(e));at=n;}
   return v;
  };
  if(options.mode==='deploy'){
   check(!existsSync(lock)&&!existsSync(guardPath));
   const header={...binding,pid:runtime.pid,host:runtime.host,at:new Date(runtime.now()).toISOString()};
   headerBytes=bytes(header);headerFile=resolve(root,runId+'.fullscript-deployment.header.json');journalBytes=bytes([]);
   save(headerFile,headerBytes);save(journalPath,journalBytes);save(resolve(root,runId+'.fullscript-deployment.operator.cjs'),operator);
   linkSync(headerFile,lock);
  }else{
   check(!existsSync(guardPath));headerBytes=read(lock);const h=parse(headerBytes);
   check(Object.keys(h).sort().join(',')==='at,contract,host,operatorSha256,pid,purpose,reviewSha256,runId,sourceCommit'
    &&Object.entries(binding).every(([k,v])=>h[k]===v)&&h.host===runtime.host&&h.pid!==runtime.pid
    &&Number.isSafeInteger(h.pid)&&h.pid>0&&runtime.stopped(h.pid)
    &&Number.isFinite(Date.parse(h.at))&&runtime.now()-Date.parse(h.at)>=60000);
   headerFile=resolve(root,runId+'.fullscript-deployment.header.json');check(read(headerFile).equals(headerBytes));
   journalBytes=read(journalPath);events=checkedEvents(parse(journalBytes),headerBytes);
   check(events.length>0&&read(resolve(root,runId+'.fullscript-deployment.operator.cjs'),16*1024*1024).equals(operator));
   // The last admitted writer, not just the original header, must be gone.
   const writerFile=resolve(root,runId+'.fullscript-deployment.execution-writer.json');
   if(existsSync(writerFile)){const w=parse(read(writerFile));check(w.reviewSha256===binding.reviewSha256&&w.operatorSha256===operatorSha256
    &&w.host===runtime.host&&w.pid!==runtime.pid&&Number.isSafeInteger(w.pid)&&w.pid>0&&runtime.stopped(w.pid)
    &&Number.isFinite(Date.parse(w.at))&&runtime.now()-Date.parse(w.at)>=60000);}
   check(options.mode==='observe'||!events.some(e=>e.stage==='execute_admitted'));
   const id=randomBytes(16).toString('hex');guardBytes=bytes({...binding,pid:runtime.pid,host:runtime.host,at:new Date(runtime.now()).toISOString()});
   guardFile=resolve(root,id+'.fullscript-deployment.recovery-header.json');save(guardFile,guardBytes);linkSync(guardFile,guardPath);
  }
  let live=true;
  const verify=async()=>{
   check(live);for(const p of dirs){const s=lstatSync(p.path);check(s.isDirectory()&&!s.isSymbolicLink()&&s.ino===p.ino&&s.dev===p.dev);}
   check(read(resolve(options.operatorFile),16*1024*1024).equals(operator)&&read(lock).equals(headerBytes)
    &&read(headerFile).equals(headerBytes)&&read(journalPath).equals(journalBytes));
   if(guardBytes)check(read(guardPath).equals(guardBytes)&&read(guardFile!).equals(guardBytes));
  };
  return {verify,stages:()=>events.map(e=>e.stage),record:async stage=>{
   await verify();check(stage===stages[events.length]&&events.length<4);
   if(stage==='execute_admitted'){
    // Publish the recovering executor identity before admission. A crash here
    // leaves a refusal, never permission for a second admitted executor.
    save(resolve(root,runId+'.fullscript-deployment.execution-writer.json'),bytes({...binding,pid:runtime.pid,host:runtime.host,at:new Date(runtime.now()).toISOString()}));
   }
   const e={stage,at:new Date(runtime.now()).toISOString(),previousSha256:deploymentDigest(events.length?bytes(events.at(-1)):headerBytes)};
   const next=[...events,e];checkedEvents(next,headerBytes);
   const fd=openSync(journalPath,constants.O_WRONLY|(constants.O_NOFOLLOW??0));
   try{const s=fstatSync(fd);check(s.size===journalBytes.length);const nextBytes=bytes(next);
    // Replace only this owned journal. A torn write is permanently refused;
    // no parsed prefix can turn a lost admission into permission to retry.
    writeFileSync(fd,nextBytes);fsyncSync(fd);journalBytes=nextBytes;
   }finally{closeSync(fd);}
   events=next;await verify();
  },finish:async report=>{
   await verify();const r=report as Record<string,unknown>;check(events.some(e=>e.stage==='execute_admitted')
    &&r.contract==='fullscript-deployment-observation/1'&&r.reviewSha256===binding.reviewSha256&&r.sourceCommit===binding.sourceCommit
    &&r.deployed===true&&r.controlPlaneObserved===true&&r.hostedQualified===false&&r.phiAllowed===false);
   save(resolve(root,randomBytes(16).toString('hex')+'.fullscript-deployment.receipt.json'),bytes(report));
   await verify();if(guardBytes)unlinkSync(guardPath);unlinkSync(lock);live=false;
  }};
 }catch{return fail();}
}
