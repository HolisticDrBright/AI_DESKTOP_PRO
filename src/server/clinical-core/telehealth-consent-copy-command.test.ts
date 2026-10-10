import {beforeAll,describe,expect,it,vi} from 'vitest';
import {resolve} from 'node:path';
import type {ClinicalCoreMigration} from './migrations';
import {build,bytes,caller,foundation,migrations,sha,target as upgradeTarget} from './__fixtures__/telehealth-consent-upgrade';
import {FULLSCRIPT_CONSENT_SUCCESSOR} from './fullscript-migration-release';
import type {TelehealthConsentCopy,TelehealthConsentCopyReceipt} from './telehealth-consent-copy-registration';
import type {RetainedTelehealthCopyObservation} from './telehealth-consent-copy-retained';
import {executeTelehealthCopyCommand,verifyTelehealthCopyReceipt,verifyRetainedTelehealthCopy,
  type TelehealthCopyCommandDependencies,type TelehealthCopyStage,type TelehealthCopyEvidence} from './telehealth-consent-copy-command';

let m:ClinicalCoreMigration[];beforeAll(()=>{m=migrations();});
const text='FICTIONAL TEST ONLY. Exact consent wording.';
const copy:TelehealthConsentCopy={contract:'telehealth-consent-copy/112',artifactId:'11111111-1111-4111-8111-111111111111',
  organizationId:'22222222-2222-4222-8222-222222222222',artifactVersion:'FICTIONAL/1',scope:'telehealth_recording',
  content:text,contentSha256:sha(text)};
const {contract:_old,fromReleaseSha256:_from,toReleaseSha256:_to,review:_review,...targetFields}=upgradeTarget;
const target={...targetFields,contract:'telehealth-consent-copy-target/112',migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,
  copySha256:sha(bytes(copy)),artifactId:copy.artifactId,organizationId:copy.organizationId,artifactVersion:copy.artifactVersion,
  contentSha256:copy.contentSha256,scope:copy.scope,
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-01-01T00:00:00.000Z',scope:'fictional-consent-copy-registration-only'}};
const receipt=(command:'inspect'|'rehearse'|'register',present=false):TelehealthConsentCopyReceipt=>({
  contract:'telehealth-consent-copy-registration/112',command,execution:'qualification',phiAllowed:false,activation:'blocked',
  migrationCount:112,migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,scope:'telehealth_recording',
  approvalsCreated:false,grantsCreated:false,copyInserted:command==='register'&&!present,
  copyPresent:command==='register'||present,artifactId:copy.artifactId,contentSha256:copy.contentSha256,rolledBack:command==='rehearse',
});
const retained=(present:boolean):RetainedTelehealthCopyObservation=>({
  contract:'telehealth-consent-copy-retained-observation/112',execution:'qualification',phiAllowed:false,activation:'blocked',
  migrationCount:112,migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,scope:'telehealth_recording',
  artifactId:copy.artifactId,organizationId:copy.organizationId,artifactVersion:copy.artifactVersion,contentSha256:copy.contentSha256,
  copyPresent:present,approvalAuthorityCertified:false,databaseMutationPerformed:false,retryPerformed:false,deletionCertified:false,
});
const settled={runId:'4'.repeat(32),journalSha256:'5'.repeat(64),custodySettled:true as const};
function setup(){
  let present=false;
  const writer={verify:vi.fn(async()=>{}),record:vi.fn(async(_stage:TelehealthCopyStage,_value:TelehealthCopyEvidence)=>{}),
    finding:vi.fn(async()=>{}),settle:vi.fn(async()=>({...settled}))};
  const recovery={baseline:receipt('inspect'),writeAdmitted:true,verify:vi.fn(async()=>{}),
    settle:vi.fn(async()=>({...settled,originalWriteOutcome:'unknown' as const}))};
  const d:TelehealthCopyCommandDependencies={readTarget:vi.fn(()=>bytes(target)),readCopy:vi.fn(()=>bytes(copy)),
    operatorSha256:()=>target.operatorSha256,observeCaller:vi.fn(()=>structuredClone(caller)),
    observeFoundation:vi.fn(()=>structuredClone(foundation)),loadMigrations:()=>m,
    createDatabase:vi.fn(()=>({transaction:async()=>{throw Error('unimplemented FICTIONAL transport');}})),
    run:vi.fn(async(_db,_m,_c,mode)=>{if(mode==='inventory')throw Error('not a command mode');
      const r=receipt(mode,present);if(mode==='register')present=true;return r;}),
    inspectRetained:vi.fn(async()=>retained(present)),
    withFence:vi.fn(work=>work({verify:vi.fn(async()=>{})})),createCustody:vi.fn(async()=>writer),
    openRecoveryCustody:vi.fn(async()=>recovery)};
  const args=(mode:string)=>[mode,'--target',resolve('FICTIONAL-target.json'),'--target-sha256',sha(bytes(target)),
    '--copy',resolve('FICTIONAL-copy.json'),'--copy-sha256',sha(bytes(copy)),
    ...(mode==='inspect'?[]:[mode==='reconcile'?'--reconcile-fictional-telehealth-copy':'--confirm-fictional-telehealth-copy'])];
  return {d,writer,recovery,args,setPresent:(v:boolean)=>{present=v;}};
}
describe('112 copy command source orchestration; fictional ports, not native/hosted qualification',()=>{
  it('requires current inspection, rollback, write admission, one write and exact retained readbacks',async()=>{
    const s=setup();const result=await executeTelehealthCopyCommand(s.args('register'),build,s.d);
    expect(result).toMatchObject({copyPresent:true,copyInserted:true,custodySettled:true,approvalsCreated:false,grantsCreated:false});
    expect(s.writer.record.mock.calls.map(v=>v[0])).toEqual(['rehearsal','write_admitted','write_reply','readback_one','readback_two']);
    expect(vi.mocked(s.d.run!).mock.calls.map(v=>v[3])).toEqual(['inspect','rehearse','register']);
    expect(s.d.inspectRetained).toHaveBeenCalledTimes(2);expect(JSON.stringify(result)).not.toContain(text);
  });
  it('an identical baseline remains idempotent, not newly inserted',async()=>{
    const s=setup();s.setPresent(true);
    expect(await executeTelehealthCopyCommand(s.args('register'),build,s.d)).toMatchObject({copyInserted:false,copyPresent:true,custodySettled:true});
  });
  it.each(['inspect','rehearse'])('does not publish writer custody for %s',async mode=>{
    const s=setup();await executeTelehealthCopyCommand(s.args(mode),build,s.d);
    expect(s.d.createCustody).not.toHaveBeenCalled();expect(s.d.openRecoveryCustody).not.toHaveBeenCalled();
  });
  it.each([2,6])('refuses relative path at argument %s before file reads or AWS',async index=>{
    const s=setup(),args=s.args('register');args[index]='relative.json';
    await expect(executeTelehealthCopyCommand(args,build,s.d)).rejects.toThrow('target_refused');
    expect(s.d.readTarget).not.toHaveBeenCalled();expect(s.d.observeCaller).not.toHaveBeenCalled();
  });
  it.each(['--profile','--region','--database','--phi-allowed','--custody-root','--endpoint-url'])('refuses override %s',async flag=>{
    const s=setup();await expect(executeTelehealthCopyCommand([...s.args('register'),flag,'bad'],build,s.d)).rejects.toThrow('target_refused');
    expect(s.d.observeCaller).not.toHaveBeenCalled();
  });
  it('refuses dirty or falsely truthy clean metadata before reading files',async()=>{
    for(const clean of [false,'yes',1]){
      const s=setup();await expect(executeTelehealthCopyCommand(s.args('register'),{...build,clean} as typeof build,s.d)).rejects.toThrow('target_refused');
      expect(s.d.readTarget).not.toHaveBeenCalled();
    }
  });
  it.each([{phiAllowed:true},{activation:'approved'},{account:'173535830222'},{qualificationDatabaseName:'clinical_core'},
    {operatorSha256:'0'.repeat(64)},{sourceCommit:'b'.repeat(40)},{artifactId:'33333333-3333-4333-8333-333333333333'},
    {contentSha256:'0'.repeat(64)},{scope:'messaging'},{migrationReleaseSha256:'0'.repeat(64)},
    {review:{...target.review,scope:'fictional-schema-transition-only'}},
    {review:{...target.review,reviewedAt:'2100-01-01T00:00:00.000Z'}},{unknown:true}])('refuses unsafe or schema-only target %j',async delta=>{
    const s=setup(),v={...target,...delta};s.d.readTarget=()=>bytes(v);const args=s.args('register');args[4]=sha(bytes(v));
    await expect(executeTelehealthCopyCommand(args,build,s.d)).rejects.toThrow('target_refused');expect(s.d.createDatabase).not.toHaveBeenCalled();
  });
  it('refuses duplicate keys and mismatched exact copy bytes before AWS observations',async()=>{
    const s=setup(),b=Buffer.from(bytes(copy).toString().replace('{','{"content":"bad",'));
    s.d.readCopy=()=>b;const args=s.args('register');args[8]=sha(b);
    await expect(executeTelehealthCopyCommand(args,build,s.d)).rejects.toThrow('target_refused');expect(s.d.observeCaller).not.toHaveBeenCalled();
  });
  it.each([
    'arn:aws:iam::588966314750:root','arn:aws:sts::588966314750:assumed-role/Other/FICTIONAL',
    'arn:aws:sts::173535830222:assumed-role/OrganizationAccountAccessRole/FICTIONAL',
  ])('refuses wrong caller %s',async Arn=>{
    const s=setup();s.d.observeCaller=()=>({...caller,Arn});
    await expect(executeTelehealthCopyCommand(s.args('register'),build,s.d)).rejects.toThrow();
    expect(s.d.createDatabase).not.toHaveBeenCalled();
  });
  it('changed foundation cluster refuses before SQL',async()=>{
    const s=setup();s.d.observeFoundation=()=>({Stacks:[{...foundation.Stacks[0],Outputs:foundation.Stacks[0].Outputs.map(v=>
      v.OutputKey==='DatabaseClusterArn'?{...v,OutputValue:target.clusterArn+'-changed'}:v)}]});
    await expect(executeTelehealthCopyCommand(s.args('register'),build,s.d)).rejects.toThrow('target_refused');
    expect(s.d.createDatabase).not.toHaveBeenCalled();
  });
  it('lost write reply retains custody and never retries or settles',async()=>{
    const s=setup(),original=s.d.run!;
    s.d.run=vi.fn(async(...args:Parameters<NonNullable<TelehealthCopyCommandDependencies['run']>>)=>{
      const r=await original(...args);if(args[3]==='register')throw Error('FICTIONAL lost write reply');return r;
    });
    await expect(executeTelehealthCopyCommand(s.args('register'),build,s.d)).rejects.toThrow('FICTIONAL lost write reply');
    expect(vi.mocked(s.d.run).mock.calls.filter(v=>v[3]==='register')).toHaveLength(1);
    expect(s.writer.finding).toHaveBeenCalledOnce();expect(s.writer.settle).not.toHaveBeenCalled();
  });
  it('lost approval during the write does not authorize a second registration during recovery',async()=>{
    const s=setup();s.setPresent(true);s.d.run=vi.fn(async()=>{throw Error('approval_required');});
    const r=await executeTelehealthCopyCommand(s.args('reconcile'),build,s.d);
    expect(r).toMatchObject({observation:'exact_retained_copy_observed',approvalAuthorityCertified:false,originalWriteOutcome:'unknown',
      databaseMutationPerformed:false,retryPerformed:false,deletionCertified:false});
    expect(s.d.run).not.toHaveBeenCalled();expect(s.d.inspectRetained).toHaveBeenCalledTimes(3);
    expect(s.d.createCustody).not.toHaveBeenCalled();
  });
  it('unadmitted new copy is refused, and a baseline copy cannot disappear',async()=>{
    for(const mode of ['unadmitted','disappeared']){
      const s=setup();s.recovery.writeAdmitted=false;
      if(mode==='unadmitted')s.setPresent(true);else s.recovery.baseline=receipt('inspect',true);
      await expect(executeTelehealthCopyCommand(s.args('reconcile'),build,s.d)).rejects.toThrow('verification_failed');
      expect(s.recovery.settle).not.toHaveBeenCalled();
    }
  });
  it('an absent admitted result is observed without deletion certification or retry',async()=>{
    const s=setup();expect(await executeTelehealthCopyCommand(s.args('reconcile'),build,s.d)).toMatchObject({
      observation:'copy_absence_observed',deletionCertified:false,retryPerformed:false,originalWriteOutcome:'unknown',
    });expect(s.d.run).not.toHaveBeenCalled();
  });
  it('changed copy bytes after admission stop before write without retiring custody',async()=>{
    const s=setup();s.writer.record.mockImplementation(async stage=>{if(stage==='write_admitted')s.d.readCopy=()=>bytes({...copy,content:'changed'});});
    await expect(executeTelehealthCopyCommand(s.args('register'),build,s.d)).rejects.toThrow('target_refused');
    expect(vi.mocked(s.d.run!).mock.calls.filter(v=>v[3]==='register')).toHaveLength(0);expect(s.writer.settle).not.toHaveBeenCalled();
  });
  it('inconsistent retained readbacks never settle',async()=>{
    const s=setup();let n=0;s.d.inspectRetained=vi.fn(async()=>retained(++n===1));
    await expect(executeTelehealthCopyCommand(s.args('reconcile'),build,s.d)).rejects.toThrow('verification_failed');
    expect(s.recovery.settle).not.toHaveBeenCalled();
  });
  it.each([{phiAllowed:true},{grantsCreated:true},{approvalsCreated:true},{copyPresent:false},{unknown:true}])
    ('refuses counterfeit register evidence %j',delta=>{
      expect(()=>verifyTelehealthCopyReceipt({...receipt('register'),...delta} as TelehealthConsentCopyReceipt,'register',copy)).toThrow();
    });
  it.each([{approvalAuthorityCertified:true},{deletionCertified:true},{retryPerformed:true},{organizationId:'33333333-3333-4333-8333-333333333333'},
    {content:'should not be logged'}])('refuses counterfeit retained evidence %j',delta=>{
      expect(()=>verifyRetainedTelehealthCopy({...retained(true),...delta} as RetainedTelehealthCopyObservation,copy)).toThrow();
    });
});
