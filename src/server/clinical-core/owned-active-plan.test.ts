import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createOwnedConsumerRecordsAdapter,OwnedStorageError} from './owned-consumer-records';
import {ClinicalCoreDatabaseRejection,clinicalUuid,type ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
const uuid='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',request='33333333-3333-4333-8333-333333333333';
const digest=createHash('sha256').update('{}').digest('hex');
const context:ProductionClinicalRequestContext={actorPersonId:uuid,organizationId:uuid,identitySubject:'owned-consumer-a',identityPool:'consumer',purpose:'clinical_data',
  environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const pointer=(patch:Record<string,unknown>={})=>({recordId:uuid,revision:2,contentSha256:digest,consentRevision:1,adoptedAt:'2026-09-16T12:00:00.000Z',adoptionRequestId:request,
  supersedes:{recordId:other,revision:1},...patch});
const history=[{action:'adopted',requestId:request,recordId:uuid,revision:2,previousRecordId:other,previousRevision:1,recordedAt:'2026-09-16T12:00:00.000Z'}];
function setup(result:unknown={current:pointer(),history,historyLimit:100}){
  const query=vi.fn(async(sql:string,...args:unknown[])=>{void args;return {rows:[{result:sql.includes('get_owned_consumer_record(')?{recordId:uuid,revision:2,deleted:false,payload:{}}:result}]};});const transaction=vi.fn(async work=>work({query}));
  return {adapter:createOwnedConsumerRecordsAdapter({transaction} as unknown as ClinicalCoreDatabase),query,transaction};
}
describe('owned active plan pointer',()=>{
  it('decodes real Aurora Data API JSON text and refuses malformed JSON',async()=>{
    await expect(setup(JSON.stringify({current:pointer(),history,historyLimit:100})).adapter.activePlan(context)).resolves.toMatchObject({current:pointer()});
    await expect(setup('{bad').adapter.activePlan(context)).rejects.toMatchObject({code:'storage_unavailable'});
  });
  it('reads the pointer and lineage under the verified consumer context, never with an owner parameter',async()=>{
    const s=setup();const state=await s.adapter.activePlan(context);
    expect(state).toEqual({version:'owned-active-plan/1',current:pointer(),history,historyLimit:100});
    expect(s.query.mock.calls[0][0]).toContain('set_request_context');expect(s.query.mock.calls[1][0]).toBe('select clinical_core.get_owned_active_plan() as result');
    expect(s.query.mock.calls[1][1]).toBeUndefined();
  });
  it('adopts an exact record revision with an explicit predecessor and idempotent request identity',async()=>{
    const s=setup({current:pointer(),history,historyLimit:100,duplicate:false});
    const state=await s.adapter.adoptActivePlan(context,{recordId:uuid,revision:2,contentSha256:digest,consentRevision:1,requestId:request,expectedPrevious:{recordId:other,revision:1}});
    expect(state.current?.recordId).toBe(uuid);expect(state.duplicate).toBe(false);
    expect(s.query.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    expect(s.query.mock.calls[3][0]).toBe('select clinical_core.adopt_owned_active_plan($1,$2::integer,$3,$4::integer,$5,$6,$7::integer) as result');
    expect(s.query.mock.calls[3][1]).toEqual([clinicalUuid(uuid),2,digest,1,clinicalUuid(request),clinicalUuid(other),1]);
    const first=setup({current:pointer({supersedes:null}),history,historyLimit:100,duplicate:true});
    expect((await first.adapter.adoptActivePlan(context,{recordId:uuid,revision:2,contentSha256:digest,consentRevision:1,requestId:request,expectedPrevious:null})).duplicate).toBe(true);
    expect(first.query.mock.calls[3][1]).toEqual([clinicalUuid(uuid),2,digest,1,clinicalUuid(request),null,null]);
  });
  it.each([{recordId:'bad'},{revision:0},{contentSha256:'short'},{consentRevision:0},{requestId:'bad'},{expectedPrevious:{recordId:other}},{expectedPrevious:{recordId:other,revision:0}},{extra:true}])
    ('refuses malformed adoption input %j before the database',async patch=>{
      const s=setup();await expect(s.adapter.adoptActivePlan(context,{recordId:uuid,revision:2,contentSha256:'a'.repeat(64),consentRevision:1,requestId:request,expectedPrevious:null,...patch} as never)).rejects.toMatchObject({code:'request_invalid'});
      expect(s.transaction).not.toHaveBeenCalled();
    });
  it('maps database refusals to storage errors and refuses a pointer the database did not actually set',async()=>{
    const s=setup();s.query.mockRejectedValueOnce(new ClinicalCoreDatabaseRejection('conflict'));
    await expect(s.adapter.adoptActivePlan(context,{recordId:uuid,revision:2,contentSha256:'a'.repeat(64),consentRevision:1,requestId:request,expectedPrevious:null})).rejects.toMatchObject({code:'conflict'});
    const wrong=setup({current:pointer({recordId:other}),history,historyLimit:100,duplicate:false});
    await expect(wrong.adapter.adoptActivePlan(context,{recordId:uuid,revision:2,contentSha256:digest,consentRevision:1,requestId:request,expectedPrevious:null})).rejects.toMatchObject({code:'storage_unavailable'});
    const stale=setup({current:null,history:[],historyLimit:100,duplicate:false});
    await expect(stale.adapter.releaseActivePlan(context,{requestId:request,expected:{recordId:uuid,revision:2}})).resolves.toMatchObject({current:null});
    expect(stale.query.mock.calls[1][0]).toBe('select clinical_core.release_owned_active_plan($1,$2,$3::integer) as result');
    const notReleased=setup({current:pointer(),history,historyLimit:100,duplicate:false});
    await expect(notReleased.adapter.releaseActivePlan(context,{requestId:request,expected:{recordId:uuid,revision:2}})).rejects.toBeInstanceOf(OwnedStorageError);
  });
  it('refuses malformed pointer or lineage payloads instead of trusting them',async()=>{
    for(const bad of [{current:pointer({contentSha256:'x'}),history:[],historyLimit:100},{current:null,history:[{...history[0],action:'promoted'}],historyLimit:100},{current:null,history:[],historyLimit:50},{current:null,history:[{...history[0],previousRevision:null}],historyLimit:100}]){
      const s=setup(bad);await expect(s.adapter.activePlan(context)).rejects.toMatchObject({code:'storage_unavailable'});
    }
  });
  it('rejects a caller-provided digest that does not match the stored plan before adoption',async()=>{
    const s=setup();
    await expect(s.adapter.adoptActivePlan(context,{recordId:uuid,revision:2,contentSha256:'a'.repeat(64),consentRevision:1,requestId:request,expectedPrevious:null})).rejects.toMatchObject({code:'conflict'});
    expect(s.query.mock.calls.some(c=>c[0].includes('adopt_owned_active_plan('))).toBe(false);
  });
});
