import {describe,it,expect,vi} from 'vitest';
import {finishSchemaUpgradeFence,type SchemaUpgradeSettlement} from './schema-upgrade-fenced-settlement';

const setup=()=>({runId:'f'.repeat(32),journalSha256:'4'.repeat(64),retire:vi.fn(async()=>{})});
describe('schema settlement admits only the completed original outer fence',()=>{
  it('retires exactly once after exit and returns no closure to the public result',async()=>{
    const s=setup();let exited=false;s.retire.mockImplementation(async()=>{expect(exited).toBe(true);});
    const result=await finishSchemaUpgradeFence(async work=>{const r=await work({});exited=true;return r;},async()=>({value:{phiAllowed:false},settlement:s}));
    expect(result).toMatchObject({phiAllowed:false,custodySettled:true});expect(result).not.toHaveProperty('retire');expect(s.retire).toHaveBeenCalledOnce();
  });
  it.each(['skip','twice','substitute','mutate','change_retire','lost_exit'])('refuses %s without retirement',async mode=>{
    const s=setup();
    await expect(finishSchemaUpgradeFence(async work=>{
      if(mode==='skip')return undefined as never;
      const value=await work({});
      const exposed=value as unknown as {value:object;settlement:SchemaUpgradeSettlement};
      if(mode==='twice')await work({});
      if(mode==='substitute')return {...value};
      if(mode==='mutate')Object.assign(exposed.value,{phiAllowed:true});
      if(mode==='change_retire')exposed.settlement.retire=async()=>{};
      if(mode==='lost_exit')throw Error('lost exit');
      return value;
    },async()=>({value:{phiAllowed:false},settlement:s}))).rejects.toThrow();
    expect(s.retire).not.toHaveBeenCalled();
  });
  it.each([
    {runId:'fictional'}, {journalSha256:'bad'}, {custodySettled:true}, {retire:null},
  ])('refuses malformed settlement preparation %j',async delta=>{
    const s=setup(),bad={...s,...delta};
    await expect(finishSchemaUpgradeFence(work=>work({}),async()=>({value:{},settlement:bad as SchemaUpgradeSettlement})))
      .rejects.toMatchObject({stage:'settlement_preparation'});expect(s.retire).not.toHaveBeenCalled();
  });
  it('never reports completed custody when the local retirement fails',async()=>{
    const s=setup();s.retire.mockRejectedValue(Error('local custody changed'));
    await expect(finishSchemaUpgradeFence(work=>work({}),async()=>({value:{},settlement:s})))
      .rejects.toMatchObject({stage:'local_retirement'});expect(s.retire).toHaveBeenCalledOnce();
  });
  it('a callback retained beyond fence return cannot begin an admitted workflow',async()=>{
    const s=setup(),work=vi.fn(async()=>({value:{},settlement:s}));let late:(()=>Promise<unknown>)|undefined;
    await expect(finishSchemaUpgradeFence(callback=>{late=()=>callback({});return Promise.resolve(undefined as never);},work))
      .rejects.toMatchObject({stage:'fence_result'});
    await expect(late!()).rejects.toMatchObject({stage:'fence_callback'});expect(work).not.toHaveBeenCalled();
    expect(s.retire).not.toHaveBeenCalled();
  });
});
