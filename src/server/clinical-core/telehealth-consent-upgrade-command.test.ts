import {beforeAll,describe,expect,it,vi} from 'vitest';
import {resolve} from 'node:path';
import type {ClinicalCoreMigration} from './migrations';
import {executeTelehealthConsentUpgradeCommand,verifyTelehealthConsentUpgradeObservation,type TelehealthConsentUpgradeDependencies,type TelehealthConsentCustodyStage} from './telehealth-consent-upgrade-command';
import type {TelehealthConsentUpgradeResult} from './telehealth-consent-schema-upgrade';
import {build,bytes,caller,foundation,migrations,result,sha,target} from './__fixtures__/telehealth-consent-upgrade';
let m:ClinicalCoreMigration[];beforeAll(()=>{m=migrations();});
function setup() {
  let count:111|112=111;
  const custody={verify:vi.fn(async()=>{}),record:vi.fn(async(_stage:TelehealthConsentCustodyStage,_value:TelehealthConsentUpgradeResult)=>{}),finding:vi.fn(async()=>{}),
    settle:vi.fn(async()=>({runId:'fictional',journalSha256:'4'.repeat(64),custodySettled:true as const}))};
  const recovery={baseline:result('inspect-settled'),writeAdmitted:true,verify:vi.fn(async()=>{}),
    settle:vi.fn(async()=>({runId:'fictional',journalSha256:'4'.repeat(64),custodySettled:true as const,originalWriteOutcome:'unknown' as const}))};
  const d:TelehealthConsentUpgradeDependencies={readTarget:vi.fn(()=>bytes(target)),operatorSha256:()=>target.operatorSha256,
    observeCaller:vi.fn(()=>structuredClone(caller)),observeFoundation:vi.fn(()=>structuredClone(foundation)),loadMigrations:()=>m,
    createDatabase:vi.fn(()=>({transaction:async()=>{throw Error('unexpected_uninstrumented_database');}})),
    run:vi.fn(async(_db,_m,_c,mode)=>{if(mode==='upgrade')count=112;return result(mode,count);}),
    withFence:vi.fn(work=>work({verify:async()=>{}})),createCustody:vi.fn(async()=>custody),openRecoveryCustody:vi.fn(async()=>recovery)};
  const args=(command:string)=>[command,'--target',resolve('FICTIONAL-target.json'),'--target-sha256',sha(bytes(target)),
    ...(command==='inspect'?[]:[command==='reconcile'?'--reconcile-fictional-telehealth-consent-upgrade':'--confirm-fictional-telehealth-consent-upgrade'])];
  return {d,custody,recovery,args,setCount:(v:111|112)=>{count=v;}};
}
describe('Telehealth consent command orchestration with fictional AWS/custody; not hosted evidence',()=>{
  it('rejects relative target paths before reading a target or observing AWS',async()=>{
    const s=setup(),args=s.args('inspect');args[2]='FICTIONAL-target.json';
    await expect(executeTelehealthConsentUpgradeCommand(args,build,s.d)).rejects.toMatchObject({stage:'arguments'});
    expect(s.d.readTarget).not.toHaveBeenCalled();expect(s.d.observeCaller).not.toHaveBeenCalled();
  });
  it('requires real rollback response, write admission and two locked readbacks before settlement',async()=>{
    const s=setup();const r=await executeTelehealthConsentUpgradeCommand(s.args('upgrade'),build,s.d);
    expect(r).toMatchObject({observedMigrationCount:112,custodySettled:true,phiAllowed:false,activation:'blocked'});
    expect(s.custody.record.mock.calls.map(v=>v[0])).toEqual(['rehearsal','write_admitted','write_reply','readback_one','readback_two']);
    expect(vi.mocked(s.d.run!).mock.calls.map(v=>v[3])).toEqual(['inspect-settled','rehearse','upgrade','inspect-settled','inspect-settled']);
    expect(s.custody.settle).toHaveBeenCalledTimes(1);
  });
  it.each(['inspect','rehearse'])('does not create lasting write custody for %s',async cmd=>{
    const s=setup();await executeTelehealthConsentUpgradeCommand(s.args(cmd),build,s.d);
    expect(s.d.createCustody).not.toHaveBeenCalled();expect(s.d.openRecoveryCustody).not.toHaveBeenCalled();
  });
  it.each(['--profile','--region','--endpoint-url','--database','--phi-allowed'])('rejects override %s before observations',async override=>{
    const s=setup();await expect(executeTelehealthConsentUpgradeCommand([...s.args('upgrade'),override,'anything'],build,s.d)).rejects.toMatchObject({category:'boundary_refused'});
    expect(s.d.observeCaller).not.toHaveBeenCalled();expect(s.d.createDatabase).not.toHaveBeenCalled();
  });
  it.each([
    {phiAllowed:true},{activation:'approved'},{account:'173535830222'},{qualificationDatabaseName:'clinical_core'},
    {sourceCommit:'b'.repeat(40)},{operatorSha256:'8'.repeat(64)},{unknown:'override'},
    {review:{...target.review,reviewedAt:'2100-01-01T00:00:00.000Z'}},
  ])('rejects changed target %j before database access',async delta=>{
    const s=setup(),v={...target,...delta};s.d.readTarget=()=>bytes(v);const args=s.args('upgrade');args[4]=sha(bytes(v));
    await expect(executeTelehealthConsentUpgradeCommand(args,build,s.d)).rejects.toMatchObject({category:'boundary_refused'});expect(s.d.createDatabase).not.toHaveBeenCalled();
  });
  it('refuses supplied bytes whose review hash no longer matches',async()=>{
    const s=setup();s.d.readTarget=()=>bytes({...target,secretArn:target.secretArn+'other'});
    await expect(executeTelehealthConsentUpgradeCommand(s.args('upgrade'),build,s.d)).rejects.toMatchObject({stage:'target_bytes'});
  });
  it('rejects duplicate JSON keys despite a correctly recomputed outer digest',async()=>{
    const s=setup(),b=Buffer.from(bytes(target).toString().replace('{','{"phiAllowed":true,'));s.d.readTarget=()=>b;
    const args=s.args('upgrade');args[4]=sha(b);await expect(executeTelehealthConsentUpgradeCommand(args,build,s.d)).rejects.toMatchObject({stage:'target_encoding'});
  });
  it('rejects a foundation bound to another actual cluster before custody or SQL',async()=>{
    const s=setup();s.d.observeFoundation=()=>({Stacks:[{...foundation.Stacks[0],Outputs:foundation.Stacks[0].Outputs.map(v=>
      v.OutputKey==='DatabaseClusterArn'?{...v,OutputValue:target.clusterArn+'-changed'}:v)}]});
    await expect(executeTelehealthConsentUpgradeCommand(s.args('upgrade'),build,s.d)).rejects.toMatchObject({stage:'observed_target'});
    expect(s.d.createDatabase).not.toHaveBeenCalled();
  });
  it.each(['arn:aws:iam::588966314750:root','arn:aws:sts::588966314750:assumed-role/OtherRole/FICTIONAL',
    'arn:aws:sts::173535830222:assumed-role/OrganizationAccountAccessRole/FICTIONAL'])('refuses operator principal %s',async Arn=>{
    const s=setup();s.d.observeCaller=()=>({...caller,Arn});await expect(executeTelehealthConsentUpgradeCommand(s.args('upgrade'),build,s.d)).rejects.toThrow();
    expect(s.d.createDatabase).not.toHaveBeenCalled();expect(s.d.createCustody).not.toHaveBeenCalled();
  });
  it('a stale current AWS observation stops after admission without a SQL retry or custody retirement',async()=>{
    const s=setup();s.custody.record.mockImplementation(async stage=>{if(stage==='write_admitted')s.d.observeCaller=()=>({...caller,Arn:caller.Arn+'-changed'});});
    await expect(executeTelehealthConsentUpgradeCommand(s.args('upgrade'),build,s.d)).rejects.toMatchObject({stage:'observations_changed'});
    expect(vi.mocked(s.d.run!).mock.calls.filter(v=>v[3]==='upgrade')).toHaveLength(0);
    expect(s.custody.finding).toHaveBeenCalledOnce();expect(s.custody.settle).not.toHaveBeenCalled();
  });
  it('lost commit reply never causes a second forward call or removal of custody',async()=>{
    const s=setup(),original=s.d.run!;s.d.run=vi.fn(async(...args:Parameters<NonNullable<TelehealthConsentUpgradeDependencies['run']>>)=>{
      const r=await original(...args);if(args[3]==='upgrade')throw Error('FICTIONAL lost commit reply');return r;});
    await expect(executeTelehealthConsentUpgradeCommand(s.args('upgrade'),build,s.d)).rejects.toThrow('FICTIONAL lost commit reply');
    expect(vi.mocked(s.d.run).mock.calls.filter(v=>v[3]==='upgrade')).toHaveLength(1);expect(s.custody.settle).not.toHaveBeenCalled();
  });
  it('read-only reconciliation observes a committed successor three times without any write call',async()=>{
    const s=setup();s.setCount(112);const r=await executeTelehealthConsentUpgradeCommand(s.args('reconcile'),build,s.d);
    expect(r).toMatchObject({observation:'preserved_successor_observed',originalWriteOutcome:'unknown',databaseMutationPerformed:false,retryPerformed:false});
    expect(vi.mocked(s.d.run!).mock.calls.map(v=>v[3])).toEqual(['inspect-settled','inspect-settled','inspect-settled']);
    expect(s.d.createCustody).not.toHaveBeenCalled();
  });
  it('an unadmitted successor refuses reconciliation even if a ledger says 112',async()=>{
    const s=setup();s.setCount(112);s.recovery.writeAdmitted=false;
    await expect(executeTelehealthConsentUpgradeCommand(s.args('reconcile'),build,s.d)).rejects.toMatchObject({category:'recovery_refused'});
    expect(s.recovery.settle).not.toHaveBeenCalled();
  });
  it('a predecessor is observed, not silently retried during interrupted recovery',async()=>{
    const s=setup();const r=await executeTelehealthConsentUpgradeCommand(s.args('reconcile'),build,s.d);
    expect(r).toMatchObject({observation:'preserved_predecessor_observed',retryPerformed:false});
    expect(vi.mocked(s.d.run!).mock.calls.every(v=>v[3]==='inspect-settled')).toBe(true);
  });
  it('changing readback data refuses certification and preserves custody',async()=>{
    const s=setup();s.d.run=vi.fn(async(_db,_m,_c,mode)=>({...result(mode),rowCount:999}));
    await expect(executeTelehealthConsentUpgradeCommand(s.args('reconcile'),build,s.d)).rejects.toMatchObject({stage:'preservation'});
    expect(s.recovery.settle).not.toHaveBeenCalled();
  });
  it.each([{applied:false},{newTableCount:1},{newRows:1},{newFunctionCount:0},{phiAllowed:true},{unknown:'not_admitted'}])
    ('refuses counterfeit successor observation %j',delta=>{
      expect(()=>verifyTelehealthConsentUpgradeObservation({...result('upgrade'),...delta} as ReturnType<typeof result>,'upgrade')).toThrow();
    });
});
