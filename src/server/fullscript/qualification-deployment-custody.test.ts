import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFullscriptDeploymentCustody} from './qualification-deployment-custody';
import type {DeploymentPlan} from './qualification-deployment-execution';
let root:string,operatorFile:string;
const now=Date.parse('2026-10-09T21:00:00Z');
const plan={review:{runId:'1'.repeat(32)},reviewSha256:'2'.repeat(64),sourceCommit:'3'.repeat(40)} as DeploymentPlan;
const runtime={pid:11,host:'FICTIONAL HOST',now:()=>now,stopped:()=>true};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'fullscript-deployment-'));operatorFile=join(root,'operator.cjs');writeFileSync(operatorFile,'FICTIONAL OPERATOR\n');});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const start=()=>createFullscriptDeploymentCustody({root,operatorFile,plan,mode:'deploy',runtime});
const recover=(mode:'resume-unadmitted'|'execute-prepared'|'observe',extra={})=>createFullscriptDeploymentCustody({root,operatorFile,plan,mode,
 runtime:{...runtime,pid:12,now:()=>now+60001,...extra}});
it('publishes shared custody and refuses a second writer even from a different run',async()=>{
 const c=start();await c.verify();expect(existsSync(join(root,'operator.lock'))).toBe(true);
 expect(()=>start()).toThrow('fullscript_deployment_custody_refused');
 expect(()=>createFullscriptDeploymentCustody({root,operatorFile,plan:{...plan,review:{...plan.review,runId:'4'.repeat(32)}},mode:'deploy',runtime})).toThrow();
});
it('orders durable stages and refuses skipping, duplicate admission or changed journal',async()=>{
 const c=start();await expect(c.record('execute_admitted')).rejects.toThrow();await c.record('create_admitted');
 await expect(c.record('create_admitted')).rejects.toThrow();expect(c.stages()).toEqual(['create_admitted']);
 writeFileSync(join(root,plan.review.runId+'.fullscript-deployment.event-0.json'),'[]\n');await expect(c.verify()).rejects.toThrow();
});
it('unknown create outcome retains its lock and has read-only recoverable custody',async()=>{
 const c=start();await c.record('create_admitted');expect(existsSync(join(root,'operator.lock'))).toBe(true);
 const r=recover('observe');await r.verify();expect(r.stages()).toEqual(['create_admitted']);
 expect(()=>recover('observe')).toThrow(); // exclusive recovering observer
});
it.each(['alive','too-young','different-host','different-review','changed-operator','torn-journal'])('refuses recovery %s',async kind=>{
 const c=start();await c.record('create_admitted');
 if(kind==='changed-operator')writeFileSync(operatorFile,'CHANGED');
 if(kind==='torn-journal')writeFileSync(join(root,plan.review.runId+'.fullscript-deployment.event-0.json'),'[{');
 if(kind==='different-review'){
  expect(()=>createFullscriptDeploymentCustody({root,operatorFile,plan:{...plan,reviewSha256:'9'.repeat(64)},mode:'observe',runtime:{...runtime,pid:12,now:()=>now+60001}})).toThrow();return;
 }
 expect(()=>recover('observe',kind==='alive'?{stopped:()=>false}:kind==='too-young'?{now:()=>now+1}:kind==='different-host'?{host:'OTHER HOST'}:{})).toThrow();
});
it('an admitted execution is never available to a recovering executor',async()=>{
 const c=start();await c.record('create_admitted');await c.record('create_observed');await c.record('execute_admitted');
 expect(()=>recover('execute-prepared')).toThrow();const r=recover('observe');await r.verify();
});
it('a recovered executor publishes its own process identity before admission',async()=>{
 const c=start();await c.record('create_admitted');const r=recover('execute-prepared');await r.record('create_observed');await r.record('execute_admitted');
 const writer=JSON.parse(readFileSync(join(root,plan.review.runId+'.fullscript-deployment.writer-1.json'),'utf8'));
 expect(writer.pid).toBe(12);expect(writer.reviewSha256).toBe(plan.reviewSha256);
 const event=JSON.parse(readFileSync(join(root,plan.review.runId+'.fullscript-deployment.event-2.json'),'utf8'));
 expect(event.writerGeneration).toBe(1);
});
it('a stopped recovery observer can be recovered without deleting or replacing its writer record',async()=>{
 const c=start();await c.record('create_admitted');const first=recover('observe');await first.verify();
 const original=readFileSync(join(root,plan.review.runId+'.fullscript-deployment.writer-1.json'));
 const second=createFullscriptDeploymentCustody({root,operatorFile,plan,mode:'observe',runtime:{...runtime,pid:13,now:()=>now+120002}});
 await second.verify();expect(second.stages()).toEqual(['create_admitted']);
 expect(readFileSync(join(root,plan.review.runId+'.fullscript-deployment.writer-1.json')).equals(original)).toBe(true);
 await expect(first.verify()).rejects.toThrow(); // prior generation can no longer act
});
it('a live recovery observer is not replaced just because its original writer is stopped',async()=>{
 const c=start();await c.record('create_admitted');recover('observe');
 expect(()=>createFullscriptDeploymentCustody({root,operatorFile,plan,mode:'observe',runtime:{...runtime,pid:13,now:()=>now+120002,stopped:pid=>pid===11}})).toThrow();
});
it('an execution admitted by a recovering writer remains read-only to every later generation',async()=>{
 const c=start();await c.record('create_admitted');const first=recover('execute-prepared');await first.record('create_observed');await first.record('execute_admitted');
 const next={root,operatorFile,plan,runtime:{...runtime,pid:13,now:()=>now+120002}};
 expect(()=>createFullscriptDeploymentCustody({...next,mode:'execute-prepared'})).toThrow();
 const observer=createFullscriptDeploymentCustody({...next,mode:'observe'});await observer.verify();
 expect(observer.stages()).toContain('execute_admitted');
});
it('interruption before any write admission can resume only in the explicit unadmitted mode',async()=>{
 start();expect(()=>recover('execute-prepared')).toThrow();const r=recover('resume-unadmitted');
 expect(r.stages()).toEqual([]);await r.record('create_admitted');await r.verify();
});
it('an unadmitted resume can never turn an unknown create into a second create',async()=>{
 const c=start();await c.record('create_admitted');expect(()=>recover('resume-unadmitted')).toThrow();
});
it('inert unpublished archives cannot be mistaken for an admitted provider or control-plane write',async()=>{
 start();writeFileSync(join(root,'FICTIONAL.partial-publication.json'),'{');const r=recover('resume-unadmitted');
 expect(r.stages()).toEqual([]);await r.verify();
});
it('old custody formats and subsidiary locks are not automatically migrated or deleted',()=>{
 writeFileSync(join(root,'fullscript-deployment-recovery.lock'),'FICTIONAL OLD LOCK');
 expect(()=>start()).toThrow();expect(readFileSync(join(root,'fullscript-deployment-recovery.lock'),'utf8')).toBe('FICTIONAL OLD LOCK');
});
it('only a positive bound deployment receipt after admitted execution retires custody',async()=>{
 const c=start();await c.record('create_admitted');await c.record('create_observed');await c.record('execute_admitted');await c.record('settled');
 const report={contract:'fullscript-deployment-observation/1',reviewSha256:plan.reviewSha256,sourceCommit:plan.sourceCommit,
  deployed:true,controlPlaneObserved:true,hostedQualified:false,phiAllowed:false};
 await expect(c.finish({...report,phiAllowed:true})).rejects.toThrow();expect(existsSync(join(root,'operator.lock'))).toBe(true);
 await c.finish(report);expect(existsSync(join(root,'operator.lock'))).toBe(false);
 expect(readdirSync(root).filter(n=>n.endsWith('.receipt.json'))).toHaveLength(1);await expect(c.verify()).rejects.toThrow();
});
