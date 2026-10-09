import {describe,it,expect,vi} from 'vitest';
import {createOwnedExternalDeletionGuard} from './owned-external-deletion';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase,type ClinicalCoreTransaction} from './database';
const scope={ownerSub:'fictional-subject',personId:'10000000-0000-4000-8000-000000000001',organizationId:'10000000-0000-4000-8000-000000000002'};
describe('external deletion transaction guard',()=>{
  it('keeps the owner guard transaction open throughout the remote operation',async()=>{
    const calls:string[]=[];let open=false;
    const query=vi.fn(async(sql:string)=>{calls.push(sql);return {rows:sql.includes(' as owner')?[{owner:scope.personId}]:[]};});
    const database:ClinicalCoreDatabase={transaction:async work=>{open=true;try{const r=await work({query} as ClinicalCoreTransaction);calls.push('commit');return r;}finally{open=false;}}};
    const r=await createOwnedExternalDeletionGuard(database)(scope,async()=>{expect(open).toBe(true);expect(calls[1]).toContain('guard_owned_external_deletion');calls.push('remote');return 'receipt';});
    expect(r).toBe('receipt');expect(open).toBe(false);expect(calls.slice(-2)).toEqual(['remote','commit']);
    expect(query.mock.calls[0][0]).toContain('set_request_context');
  });
  it.each(['legal_hold','identity_refused'] as const)('never mutates after a database %s refusal',async category=>{
    const database:ClinicalCoreDatabase={transaction:async()=>{throw new ClinicalCoreDatabaseRejection(category);}};
    const work=vi.fn();await expect(createOwnedExternalDeletionGuard(database)(scope,work)).rejects.toThrow(category==='legal_hold'?'legal_hold':'owner_required');
    expect(work).not.toHaveBeenCalled();
  });
  it('does not acknowledge remote completion when the database commit fails',async()=>{
    const database:ClinicalCoreDatabase={transaction:async work=>{await work({query:async()=>({rows:[{owner:scope.personId}]})} as ClinicalCoreTransaction);throw new Error('private SDK detail');}};
    const operation=vi.fn(async()=>true);
    await expect(createOwnedExternalDeletionGuard(database)(scope,operation)).rejects.toThrow(/^storage_unavailable$/);
    expect(operation).toHaveBeenCalledOnce();
  });
  it('refuses invalid identity and mismatched database owner before a remote operation',async()=>{
    const operation=vi.fn();const transaction=vi.fn(async(work:(tx:ClinicalCoreTransaction)=>Promise<unknown>)=>work({query:async()=>({rows:[{owner:scope.organizationId}]})} as ClinicalCoreTransaction));
    const guard=createOwnedExternalDeletionGuard({transaction} as ClinicalCoreDatabase);
    await expect(guard({...scope,personId:'invalid'},operation)).rejects.toThrow('owner_required');expect(transaction).not.toHaveBeenCalled();
    await expect(guard(scope,operation)).rejects.toThrow('owner_required');expect(operation).not.toHaveBeenCalled();
  });
});
