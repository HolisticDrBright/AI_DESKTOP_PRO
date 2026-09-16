import {describe,it,expect,vi} from 'vitest';
import {fulfillOwnerDeletion,type LabStore,type IdentityStore} from './owned-privacy-fulfillment';
const scope={ownerSub:'33333333-3333-4333-8333-333333333333',organizationId:'11111111-1111-4111-8111-111111111111',personId:'11111111-1111-4111-8111-111111111111'};
const job=(n:number,state='completed')=>({jobId:`1000000${n}-0000-4000-8000-000000000001`,state});
function stores(){
  const pages=[{jobs:[job(1),job(2,'queued')],nextCursor:'c1'},{jobs:[job(3)],nextCursor:null}];let page=0;
  const lab:LabStore={listOwnedJobs:vi.fn(async()=>pages[page++]),deleteOrCancel:vi.fn(async()=>({deleted:true as const,cleanupStatus:'late_upload_watch'}))};
  const identity:IdentityStore={disable:vi.fn(async()=>{}),globalSignOut:vi.fn(async()=>{}),delete:vi.fn(async()=>{})};
  return {lab,identity};
}
describe('owner deletion fulfillment',()=>{
  it('drives every owned lab job through deletion or cancellation and reports counts plus fingerprints only',async()=>{
    const s=stores();const {receipts,complete}=await fulfillOwnerDeletion({ownerScope:scope,lab:s.lab,identity:s.identity,confirmIdentityDeletion:true});
    expect(complete).toBe(false);
    const lab=receipts.find(r=>r.store==='lab_jobs_and_documents')!;expect(lab).toMatchObject({outcome:'tombstoned',count:3});
    expect((s.lab.deleteOrCancel as ReturnType<typeof vi.fn>).mock.calls.map(c=>c[1])).toEqual([false,true,false]);
    expect(JSON.stringify(receipts)).not.toMatch(/10000001|queued/);
    expect(receipts.find(r=>r.store==='identity')).toMatchObject({outcome:'pending',count:0});
    expect(s.identity.disable).not.toHaveBeenCalled();
    expect(s.identity.globalSignOut).not.toHaveBeenCalled();
    expect(s.identity.delete).not.toHaveBeenCalled();
    expect(receipts.find(r=>r.store==='voice_jobs_and_transcripts')?.outcome).toBe('not_enumerable');
    expect(receipts.find(r=>r.store==='backups_and_audit')?.outcome).toBe('pending');
  });
  it('never deletes identity without explicit confirmation or while another store is pending',async()=>{
    const s=stores();const noConfirm=await fulfillOwnerDeletion({ownerScope:scope,lab:s.lab,identity:s.identity});
    expect(noConfirm.receipts.find(r=>r.store==='identity')?.outcome).toBe('pending');expect(s.identity.delete).not.toHaveBeenCalled();
    const t=stores();(t.lab.deleteOrCancel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({deleted:false,cleanupStatus:'refused'});
    const pending=await fulfillOwnerDeletion({ownerScope:scope,lab:t.lab,identity:t.identity,confirmIdentityDeletion:true});
    expect(pending.receipts.find(r=>r.store==='lab_jobs_and_documents')?.outcome).toBe('pending');
    expect(pending.receipts.find(r=>r.store==='identity')?.outcome).toBe('pending');expect(t.identity.delete).not.toHaveBeenCalled();
  });
  it('refuses malformed scope and invalid or looping inventories without claiming progress',async()=>{
    await expect(fulfillOwnerDeletion({ownerScope:{...scope,ownerSub:'x'}})).rejects.toThrow('privacy_fulfillment_scope_invalid');
    const lab:LabStore={listOwnedJobs:vi.fn(async()=>({jobs:[job(1)],nextCursor:'same'})),deleteOrCancel:vi.fn(async()=>({deleted:true as const,cleanupStatus:'x'}))};
    const result=await fulfillOwnerDeletion({ownerScope:scope,lab});
    expect(result.receipts.find(r=>r.store==='lab_jobs_and_documents')).toMatchObject({outcome:'pending'});
    const unattached=await fulfillOwnerDeletion({ownerScope:scope});
    expect(unattached.receipts).toHaveLength(9);
    expect(unattached.receipts.every(r=>['pending','not_enumerable'].includes(r.outcome))).toBe(true);
  });
  it('blocks identity deletion even when lab inventory is empty and redacts provider failures',async()=>{
    const s=stores();vi.mocked(s.lab.listOwnedJobs).mockResolvedValue({jobs:[],nextCursor:null});
    await fulfillOwnerDeletion({ownerScope:scope,lab:s.lab,identity:s.identity,confirmIdentityDeletion:true});
    expect(s.identity.disable).not.toHaveBeenCalled();expect(s.identity.delete).not.toHaveBeenCalled();
    vi.mocked(s.lab.listOwnedJobs).mockRejectedValue(new Error('Bearer secret-token patient@example.test sensitive health payload'));
    const result=await fulfillOwnerDeletion({ownerScope:scope,lab:s.lab});
    expect(JSON.stringify(result)).not.toMatch(/secret-token|patient@example|sensitive health/);
    expect(result.receipts[0].detail).toBe('privacy_fulfillment_retry_required');
  });
});
