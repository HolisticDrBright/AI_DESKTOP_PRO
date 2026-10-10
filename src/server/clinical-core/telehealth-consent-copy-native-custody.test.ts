import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,appendFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createNativeTelehealthCopyCustody,openNativeTelehealthCopyRecovery,readTelehealthCopyOperatorFile} from './telehealth-consent-copy-native-custody';
import {build,configuration,sha,bytes} from './__fixtures__/telehealth-consent-upgrade';
import {FULLSCRIPT_CONSENT_SUCCESSOR} from './fullscript-migration-release';
import type {TelehealthCopyBinding,TelehealthCopyWriter} from './telehealth-consent-copy-command';
import type {TelehealthConsentCopy,TelehealthConsentCopyReceipt} from './telehealth-consent-copy-registration';
import type {RetainedTelehealthCopyObservation} from './telehealth-consent-copy-retained';

const text='FICTIONAL ONLY. Exact original consent text, not production consent.';
const copy:TelehealthConsentCopy={contract:'telehealth-consent-copy/112',artifactId:'11111111-1111-4111-8111-111111111111',
  organizationId:'22222222-2222-4222-8222-222222222222',artifactVersion:'FICTIONAL/1',scope:'telehealth_recording',
  content:text,contentSha256:sha(text)};
const {contract:_contract,content:_content,...copyBinding}=copy;
const binding:TelehealthCopyBinding={build,configuration,callerSha256:'3'.repeat(64),targetSha256:'4'.repeat(64),
  copySha256:sha(bytes(copy)),copy:copyBinding};
const receipt=(command:'inspect'|'rehearse'|'register',present=false):TelehealthConsentCopyReceipt=>({
  contract:'telehealth-consent-copy-registration/112',command,execution:'qualification',phiAllowed:false,activation:'blocked',
  migrationCount:112,migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,scope:'telehealth_recording',
  approvalsCreated:false,grantsCreated:false,copyInserted:command==='register'&&!present,
  copyPresent:command==='register'||present,artifactId:copy.artifactId,contentSha256:copy.contentSha256,rolledBack:command==='rehearse'});
const retained=(present:boolean):RetainedTelehealthCopyObservation=>({
  contract:'telehealth-consent-copy-retained-observation/112',execution:'qualification',phiAllowed:false,activation:'blocked',
  migrationCount:112,migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,scope:'telehealth_recording',
  artifactId:copy.artifactId,organizationId:copy.organizationId,artifactVersion:copy.artifactVersion,contentSha256:copy.contentSha256,
  copyPresent:present,approvalAuthorityCertified:false,databaseMutationPerformed:false,retryPerformed:false,deletionCertified:false});
let root:string,operatorFile:string,copyFile:string,now:number,child:ChildProcess|undefined;
const fence={verify:async()=>{}};
const options=(pid=process.pid)=>({root,operatorFile,copyFile,runtime:{pid,host:'FICTIONAL-same-host',now:()=>now}});
const lock=()=>join(root,'operator.lock');
const journal=()=>join(root,readdirSync(root).find(v=>v.endsWith('.telehealth-copy.events.jsonl'))!);
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'alp-telehealth-copy-custody-'));operatorFile=join(root,'original.cjs');
  copyFile=join(root,'copy.json');writeFileSync(operatorFile,'FICTIONAL operator');writeFileSync(copyFile,bytes(copy));now=Date.now();});
afterEach(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){await new Promise<void>(done=>{child!.once('exit',()=>done());child!.kill();});}
  child=undefined;if(!resolve(root).startsWith(resolve(tmpdir())+sep+'alp-telehealth-copy-custody-'))throw Error('fixture_cleanup_scope');
  rmSync(root,{recursive:true,force:true});});
async function admitted(c:TelehealthCopyWriter,present=false){await c.record('rehearsal',receipt('rehearse',present));await c.record('write_admitted',receipt('rehearse',present));}
async function liveWriter(){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await new Promise<void>((done,fail)=>{child!.once('spawn',()=>done());child!.once('error',fail);});return child.pid!;}
async function stopWriter(advance=61000){await new Promise<void>(done=>{child!.once('exit',()=>done());child!.kill();});now+=advance;}

describe('112 copy native custody: real filesystem and process liveness; fictional database fence, not hosted evidence',()=>{
  it('archives original operator and exact text before publishing a complete shared lock, keeping wording out of journal/header',async()=>{
    const c=await createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence);
    const h=JSON.parse(readFileSync(lock(),'utf8'));expect(h).toMatchObject({purpose:'qualification-telehealth-consent-copy',copySha256:binding.copySha256});
    expect(h.operatorSha256).toBe(sha('FICTIONAL operator'));await c.verify();
    expect(readFileSync(join(root,h.runId+'.telehealth-copy.original.json')).equals(bytes(copy))).toBe(true);
    expect(readFileSync(join(root,h.runId+'.telehealth-copy.operator.cjs'),'utf8')).toBe('FICTIONAL operator');
    expect(readFileSync(lock(),'utf8')).not.toContain(text);expect(readFileSync(journal(),'utf8')).not.toContain(text);
  });
  it('refuses a foreign operator lock without replacing it',async()=>{
    writeFileSync(lock(),'FICTIONAL foreign schema operator');const original=readFileSync(lock());
    await expect(createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence)).rejects.toMatchObject({stage:'operator_active'});
    expect(readFileSync(lock()).equals(original)).toBe(true);
  });
  it.each([false,true])('settles only the complete ordered readback journal; baseline present=%s',async present=>{
    const c=await createNativeTelehealthCopyCustody(options(),binding,receipt('inspect',present),fence);await admitted(c,present);
    await c.record('write_reply',receipt('register',present));await c.record('readback_one',retained(true));await c.record('readback_two',retained(true));
    expect(await c.settle(receipt('register',present))).toMatchObject({custodySettled:true});expect(existsSync(lock())).toBe(false);
    const settled=join(root,readdirSync(root).find(v=>v.endsWith('.telehealth-copy.settled.json'))!);
    expect(readFileSync(settled,'utf8')).not.toContain(text);
  });
  it('does not settle an incomplete journal',async()=>{
    const c=await createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence);
    await expect(c.settle(receipt('register'))).rejects.toMatchObject({stage:'settlement'});expect(existsSync(lock())).toBe(true);
  });
  it.each(['operator','copy','archive'])('refuses changed %s without journal advancement or lock clearing',async kind=>{
    const c=await createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence),before=readFileSync(journal());
    const h=JSON.parse(readFileSync(lock(),'utf8'));writeFileSync(kind==='operator'?operatorFile:kind==='copy'?copyFile:join(root,h.runId+'.telehealth-copy.original.json'),'CHANGED');
    await expect(c.record('rehearsal',receipt('rehearse'))).rejects.toThrow();expect(readFileSync(journal()).equals(before)).toBe(true);
    expect(existsSync(lock())).toBe(true);
  });
  it.each(['wrong-order','wrong-presence','wrong-insert','wrong-authority','wrong-artifact','wrong-hash'])('refuses %s evidence and keeps original custody',async variant=>{
    const c=await createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence);
    if(variant==='wrong-insert'||variant==='wrong-authority')await admitted(c);
    const before=readFileSync(journal());
    const action=variant==='wrong-order'?()=>c.record('write_admitted',receipt('rehearse')):
      variant==='wrong-presence'?()=>c.record('rehearsal',receipt('rehearse',true)):
      variant==='wrong-insert'?()=>c.record('write_reply',receipt('register',true)):
      variant==='wrong-authority'?()=>c.record('write_reply',{...receipt('register'),approvalsCreated:true} as unknown as TelehealthConsentCopyReceipt):
      variant==='wrong-artifact'?()=>c.record('rehearsal',{...receipt('rehearse'),artifactId:'33333333-3333-4333-8333-333333333333'}):
        ()=>c.record('rehearsal',{...receipt('rehearse'),contentSha256:'0'.repeat(64)});
    await expect(action()).rejects.toThrow();expect(readFileSync(journal()).equals(before)).toBe(true);expect(existsSync(lock())).toBe(true);
  });
  it('records findings without retries, successful settlement or further progress',async()=>{
    const c=await createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence);await admitted(c);await c.finding();
    await expect(c.record('write_reply',receipt('register'))).rejects.toMatchObject({stage:'journal_terminal'});expect(existsSync(lock())).toBe(true);
  });
  it('refuses recovery for a live original process even when older than the settlement bound',async()=>{
    const pid=await liveWriter();await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);now+=61000;
    await expect(openNativeTelehealthCopyRecovery(options(),binding,fence)).rejects.toMatchObject({stage:'writer_active'});expect(existsSync(lock())).toBe(true);
  });
  it('requires the settlement interval after the original process stops',async()=>{
    const pid=await liveWriter();await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);await stopWriter(0);
    await expect(openNativeTelehealthCopyRecovery(options(),binding,fence)).rejects.toMatchObject({stage:'writer_settlement'});expect(existsSync(lock())).toBe(true);
  });
  it.each([false,true])('read-only recovery can observe either admitted outcome, present=%s, without claiming original success',async present=>{
    const pid=await liveWriter(),c=await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);await admitted(c);await c.finding();await stopWriter();
    const r=await openNativeTelehealthCopyRecovery(options(),{...binding,callerSha256:'9'.repeat(64)},fence);expect(r.writeAdmitted).toBe(true);
    expect(await r.settle(retained(present))).toMatchObject({custodySettled:true,originalWriteOutcome:'unknown'});expect(existsSync(lock())).toBe(false);
    const file=join(root,readdirSync(root).find(v=>v.endsWith('.telehealth-copy.reconciled.json'))!);
    expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({retryPerformed:false,databaseMutationPerformed:false,approvalAuthorityCertified:false,deletionCertified:false});
  });
  it('unadmitted new presence cannot retire custody',async()=>{
    const pid=await liveWriter();await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);await stopWriter();
    const r=await openNativeTelehealthCopyRecovery(options(),binding,fence);
    await expect(r.settle(retained(true))).rejects.toMatchObject({stage:'unadmitted_copy'});expect(existsSync(lock())).toBe(true);
  });
  it('a retained baseline copy must never disappear',async()=>{
    const pid=await liveWriter();const c=await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect',true),fence);await admitted(c,true);await stopWriter();
    const r=await openNativeTelehealthCopyRecovery(options(),binding,fence);
    await expect(r.settle(retained(false))).rejects.toMatchObject({stage:'baseline_disappeared'});expect(existsSync(lock())).toBe(true);
  });
  it('a recorded committed/read-back copy cannot subsequently be reported absent',async()=>{
    const pid=await liveWriter(),c=await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);await admitted(c);
    await c.record('write_reply',receipt('register'));await c.record('readback_one',retained(true));await stopWriter();
    const r=await openNativeTelehealthCopyRecovery(options(),binding,fence);
    await expect(r.settle(retained(false))).rejects.toMatchObject({stage:'observed_copy_disappeared'});expect(existsSync(lock())).toBe(true);
  });
  it.each(['target','copy-binding','operator'])('requires the original %s for recovery',async kind=>{
    const pid=await liveWriter();await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);await stopWriter();
    if(kind==='operator')writeFileSync(operatorFile,'CHANGED operator');
    const v=kind==='target'?{...binding,targetSha256:'5'.repeat(64)}:kind==='copy-binding'?{...binding,copy:{...binding.copy,artifactVersion:'CHANGED'}}:binding;
    await expect(openNativeTelehealthCopyRecovery(options(),v,fence)).rejects.toThrow();expect(existsSync(lock())).toBe(true);
  });
  it('preserves a torn admission event and cannot use it as authority for new presence',async()=>{
    const pid=await liveWriter();await createNativeTelehealthCopyCustody(options(pid),binding,receipt('inspect'),fence);
    appendFileSync(journal(),'{"stage":"write_admitted"');const before=readFileSync(journal());await stopWriter();
    const r=await openNativeTelehealthCopyRecovery(options(),binding,fence);expect(r.writeAdmitted).toBe(false);
    await r.settle(retained(false));expect(readFileSync(journal()).equals(before)).toBe(true);
  });
  it('does not publish when the shared DB fence refuses',async()=>{
    await expect(createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),{verify:async()=>{throw Error('FICTIONAL fence refused');}})).rejects.toThrow('FICTIONAL fence refused');
    expect(existsSync(lock())).toBe(false);
  });
  it('refuses an oversized copy before allocating/archiving it',async()=>{
    writeFileSync(copyFile,Buffer.alloc(131073));await expect(createNativeTelehealthCopyCustody(options(),binding,receipt('inspect'),fence)).rejects.toThrow();expect(existsSync(lock())).toBe(false);
  });
  it('refuses noncanonical copy bytes even if the supplied digest matches',async()=>{
    const v=Buffer.from(JSON.stringify(copy,null,2)+'\n');writeFileSync(copyFile,v);
    await expect(createNativeTelehealthCopyCustody(options(),{...binding,copySha256:sha(v)},receipt('inspect'),fence)).rejects.toMatchObject({stage:'copy_encoding'});
    expect(existsSync(lock())).toBe(false);
  });
  it('refuses a symlinked ancestor when loading operator inputs',()=>{
    const link=join(root,'alias');symlinkSync(root,link,process.platform==='win32'?'junction':'dir');
    expect(()=>readTelehealthCopyOperatorFile(join(link,'copy.json'),131072)).toThrow();
  });
});
