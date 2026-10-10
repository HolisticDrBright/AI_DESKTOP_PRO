import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createNativeTelehealthConsentCustody,openNativeTelehealthConsentRecovery,readTelehealthConsentOperatorFile} from './telehealth-consent-native-custody';
import {build,configuration,result,sha} from './__fixtures__/telehealth-consent-upgrade';
import type {TelehealthConsentCustodyBinding,TelehealthConsentWriterCustody} from './telehealth-consent-upgrade-command';
const binding:TelehealthConsentCustodyBinding={build,configuration,callerSha256:'3'.repeat(64),targetSha256:'4'.repeat(64)};
let root:string,operatorFile:string,now:number,child:ChildProcess|undefined;
const fence={verify:async()=>{}};
const options=(pid=process.pid)=>({root,operatorFile,runtime:{pid,host:'FICTIONAL-same-host',now:()=>now}});
const lock=()=>join(root,'operator.lock');
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'alp-telehealth-consent-custody-'));operatorFile=join(root,'original.cjs');
  writeFileSync(operatorFile,'FICTIONAL operator');now=Date.now();});
afterEach(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){await new Promise<void>(done=>{child!.once('exit',()=>done());child!.kill();});}
  child=undefined;if(!resolve(root).startsWith(resolve(tmpdir())+sep+'alp-telehealth-consent-custody-'))throw Error('fixture_cleanup_scope');
  rmSync(root,{recursive:true,force:true});});
async function admitted(c:TelehealthConsentWriterCustody){await c.record('rehearsal',result('rehearse'));await c.record('write_admitted',result('rehearse'));}
async function deadWriter(){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await new Promise<void>((done,fail)=>{child!.once('spawn',()=>done());child!.once('error',fail);});return child.pid!;}
async function stopWriter(){await new Promise<void>(done=>{child!.once('exit',()=>done());child!.kill();});now+=61000;}
describe('Native file custody with real files/process liveness; fictional DB fence, not hosted evidence',()=>{
  it('retains immutable source, bound target and complete journal before publishing the shared lock',async()=>{
    const c=await createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence);
    const h=JSON.parse(readFileSync(lock(),'utf8'));expect(h).toMatchObject({purpose:'qualification-telehealth-consent-upgrade',targetSha256:binding.targetSha256});
    expect(h.operatorSha256).toBe(sha('FICTIONAL operator'));await c.verify();
    expect(readdirSync(root).some(v=>v.endsWith('.telehealth-consent.events.jsonl'))).toBe(true);
  });
  it('refuses another writer through the shared namespace, without replacing the first lock',async()=>{
    await createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence);const before=readFileSync(lock());
    await expect(createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence)).rejects.toMatchObject({stage:'operator_active'});
    expect(readFileSync(lock()).equals(before)).toBe(true);
  });
  it('cannot settle before all journal stages and successor readbacks',async()=>{
    const c=await createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence);
    await expect(c.settle(result('upgrade'))).rejects.toMatchObject({stage:'settlement'});expect(existsSync(lock())).toBe(true);
  });
  it('archives a complete custody receipt before retiring a verified normal writer',async()=>{
    const c=await createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence);await admitted(c);
    await c.record('write_reply',result('upgrade'));await c.record('readback_one',result('inspect-settled',112));
    await c.record('readback_two',result('inspect-settled',112));expect(await c.settle(result('upgrade'))).toMatchObject({custodySettled:true});
    expect(existsSync(lock())).toBe(false);expect(readdirSync(root).some(v=>v.endsWith('.telehealth-consent.settled.json'))).toBe(true);
  });
  it('a changed operator refuses before journal advancement and preserves the lock',async()=>{
    const c=await createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence);writeFileSync(operatorFile,'CHANGED');
    await expect(c.record('rehearsal',result('rehearse'))).rejects.toMatchObject({stage:'operator_changed'});expect(existsSync(lock())).toBe(true);
  });
  it('a finding records no successful settlement or automatic retirement',async()=>{
    const c=await createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),fence);await admitted(c);await c.finding();
    await expect(c.record('write_reply',result('upgrade'))).rejects.toMatchObject({stage:'journal_terminal'});expect(existsSync(lock())).toBe(true);
  });
  it('cannot reconcile an actually live writer even after time has passed',async()=>{
    const pid=await deadWriter();await createNativeTelehealthConsentCustody(options(pid),binding,result('inspect-settled'),fence);now+=61000;
    await expect(openNativeTelehealthConsentRecovery(options(),binding,fence)).rejects.toMatchObject({stage:'writer_active'});expect(existsSync(lock())).toBe(true);
  });
  it('requires stopped original process, original artifact, exact target and settlement interval',async()=>{
    const pid=await deadWriter();const c=await createNativeTelehealthConsentCustody(options(pid),binding,result('inspect-settled'),fence);await admitted(c);
    await stopWriter();const r=await openNativeTelehealthConsentRecovery(options(),binding,fence);expect(r.writeAdmitted).toBe(true);
    expect(await r.settle(result('inspect-settled',112))).toMatchObject({custodySettled:true,originalWriteOutcome:'unknown'});
    expect(existsSync(lock())).toBe(false);
  });
  it('stopped writer with no admission may observe predecessor but cannot certify successor',async()=>{
    const pid=await deadWriter();await createNativeTelehealthConsentCustody(options(pid),binding,result('inspect-settled'),fence);await stopWriter();
    const r=await openNativeTelehealthConsentRecovery(options(),binding,fence);
    await expect(r.settle(result('inspect-settled',112))).rejects.toMatchObject({stage:'unadmitted_successor'});expect(existsSync(lock())).toBe(true);
  });
  it('a changed reviewed target refuses recovery without removing an abandoned lock',async()=>{
    const pid=await deadWriter();await createNativeTelehealthConsentCustody(options(pid),binding,result('inspect-settled'),fence);await stopWriter();
    await expect(openNativeTelehealthConsentRecovery(options(),{...binding,targetSha256:'5'.repeat(64)},fence)).rejects.toMatchObject({stage:'lock_binding'});
    expect(existsSync(lock())).toBe(true);
  });
  it('a torn final journal append is retained and cannot manufacture write admission',async()=>{
    const pid=await deadWriter();await createNativeTelehealthConsentCustody(options(pid),binding,result('inspect-settled'),fence);
    const journal=join(root,readdirSync(root).find(v=>v.endsWith('.telehealth-consent.events.jsonl'))!);appendFileSync(journal,'{"stage":"write_admitted"');
    const bytes=readFileSync(journal);await stopWriter();const r=await openNativeTelehealthConsentRecovery(options(),binding,fence);
    expect(r.writeAdmitted).toBe(false);await r.settle(result('inspect-settled'));expect(readFileSync(journal).equals(bytes)).toBe(true);
  });
  it('changed stored historical data refuses recovery settlement and keeps custody',async()=>{
    const pid=await deadWriter();const c=await createNativeTelehealthConsentCustody(options(pid),binding,result('inspect-settled'),fence);await admitted(c);
    await stopWriter();const r=await openNativeTelehealthConsentRecovery(options(),binding,fence);
    await expect(r.settle({...result('inspect-settled',112),dataSha256:'8'.repeat(64)})).rejects.toMatchObject({stage:'preservation'});
    expect(existsSync(lock())).toBe(true);
  });
  it('a changed DB fence cannot be bypassed by a matching local lock',async()=>{
    await expect(createNativeTelehealthConsentCustody(options(),binding,result('inspect-settled'),{verify:async()=>{throw Error('FICTIONAL database fence refused');}}))
      .rejects.toThrow('FICTIONAL database fence refused');expect(existsSync(lock())).toBe(false);
  });
  it('bounded target loading rejects oversized files before parsing',()=>{
    const file=join(root,'too-big.json');writeFileSync(file,Buffer.alloc(16385));expect(()=>readTelehealthConsentOperatorFile(file)).toThrow();
  });
});
