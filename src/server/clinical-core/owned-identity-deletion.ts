import {AdminDeleteUserCommand,AdminDisableUserCommand,AdminUserGlobalSignOutCommand,type CognitoIdentityProviderClient} from '@aws-sdk/client-cognito-identity-provider';
import {createHash} from 'node:crypto';

/** Deletes one consumer identity in the provider after the database identity
 * was disabled. Steps run in order and are idempotent: a user the provider no
 * longer knows counts as absent. Any other provider failure throws so the
 * ledger keeps its last confirmed state and the operator retries; nothing is
 * recorded as deleted without the provider's own confirmation. */
export type IdentityProviderState='disabled'|'signed_out'|'deleted'|'absent';
export type ConsumerIdentityDeleter={delete(subject:string):Promise<{state:'deleted'|'absent';evidenceSha256:string}>};
const SUBJECT=/^[A-Za-z0-9:_-]{8,128}$/;
const absent=(error:unknown)=>(error as {name?:unknown})?.name==='UserNotFoundException';
export function identityDeletionEvidence(poolId:string,subject:string,state:'deleted'|'absent'){
  return createHash('sha256').update(JSON.stringify(['owned-identity-deletion/1',poolId,subject,state])).digest('hex');
}
export function createConsumerIdentityDeleter(input:{client:Pick<CognitoIdentityProviderClient,'send'>;poolId:string;
  onProgress?:(state:IdentityProviderState)=>Promise<void>}):ConsumerIdentityDeleter{
  if(!/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(input.poolId))throw new Error('identity_deletion_configuration_invalid');
  const send=(command:unknown)=>(input.client.send as (c:unknown,o?:unknown)=>Promise<unknown>)(command,{abortSignal:AbortSignal.timeout(8000)});
  return {async delete(subject){
    if(!SUBJECT.test(subject))throw new Error('identity_deletion_invalid');
    const finish=async(state:'deleted'|'absent')=>({state,evidenceSha256:identityDeletionEvidence(input.poolId,subject,state)});
    try{await send(new AdminDisableUserCommand({UserPoolId:input.poolId,Username:subject}));}
    catch(error){if(absent(error))return finish('absent');throw error;}
    await input.onProgress?.('disabled');
    try{await send(new AdminUserGlobalSignOutCommand({UserPoolId:input.poolId,Username:subject}));}
    catch(error){if(absent(error))return finish('absent');throw error;}
    await input.onProgress?.('signed_out');
    try{await send(new AdminDeleteUserCommand({UserPoolId:input.poolId,Username:subject}));}
    catch(error){if(absent(error))return finish('absent');throw error;}
    return finish('deleted');
  }};
}
