import {describe,expect,it,vi} from 'vitest';
import {createConsumerIdentityDeleter,identityDeletionEvidence} from './owned-identity-deletion';
const poolId='us-east-2_Fictional1',subject='40000000-0000-4000-8000-000000000001';
const missing=()=>Object.assign(new Error('missing'),{name:'UserNotFoundException'});
function client(sequence:(unknown|Error)[]){
  const send=vi.fn();for(const step of sequence){if(step instanceof Error)send.mockRejectedValueOnce(step);else send.mockResolvedValueOnce(step);}
  return {send};
}
describe('consumer identity deleter',()=>{
  it('disables, signs out and deletes in order, reporting progress and provider-confirmed evidence',async()=>{
    const c=client([{},{},{}]);const progress:string[]=[];
    const outcome=await createConsumerIdentityDeleter({client:c,poolId,onProgress:async s=>{progress.push(s);}}).delete(subject);
    expect(outcome).toEqual({state:'deleted',evidenceSha256:identityDeletionEvidence(poolId,subject,'deleted')});
    expect(c.send.mock.calls.map(call=>call[0].constructor.name)).toEqual(['AdminDisableUserCommand','AdminUserGlobalSignOutCommand','AdminDeleteUserCommand']);
    expect(c.send.mock.calls.every(call=>call[0].input.UserPoolId===poolId&&call[0].input.Username===subject)).toBe(true);
    expect(progress).toEqual(['disabled','signed_out']);
  });
  it('treats an unknown user as absent at any step, and surfaces every other provider failure without inventing deletion',async()=>{
    for(const [sequence,calls] of [[[missing()],1],[[{},missing()],2],[[{},{},missing()],3]] as [(unknown|Error)[],number][]){
      const c=client(sequence);
      expect(await createConsumerIdentityDeleter({client:c,poolId}).delete(subject)).toEqual({state:'absent',evidenceSha256:identityDeletionEvidence(poolId,subject,'absent')});
      expect(c.send).toHaveBeenCalledTimes(calls);
    }
    const throttled=client([{},Object.assign(new Error('slow'),{name:'TooManyRequestsException'})]);
    await expect(createConsumerIdentityDeleter({client:throttled,poolId}).delete(subject)).rejects.toMatchObject({name:'TooManyRequestsException'});
    await expect(createConsumerIdentityDeleter({client:client([{}]),poolId}).delete('short')).rejects.toThrow('identity_deletion_invalid');
    expect(()=>createConsumerIdentityDeleter({client:client([]),poolId:'not a pool'})).toThrow('identity_deletion_configuration_invalid');
    expect(identityDeletionEvidence(poolId,subject,'deleted')).not.toBe(identityDeletionEvidence(poolId,subject,'absent'));
  });
});
