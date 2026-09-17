import {describe,it,expect} from 'vitest';
import {parsePrivacyOperationResult,privacyOperationSchema,type PrivacyOperation} from './privacyOperations';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const preview={privacyRequestId:id,policyVersion:'fictional',policySha256:'a'.repeat(64),inventorySha256:'b'.repeat(64),
  records:2,consents:1,activePlans:1,planHistory:2,completeAccountDeletion:false,policyContent:'Fictional only'};
const command:PrivacyOperation={action:'purgePersonal',privacyRequestId:id,commandId:other,policyVersion:'fictional',
  policySha256:preview.policySha256,inventorySha256:preview.inventorySha256,confirmation:'PURGE PERSONAL HISTORY'};
const base=Object.fromEntries(Object.entries(preview).filter(([key])=>key!=='policyContent'));
const receipt={...base,commandId:other,outcome:'purged',verifiedAt:'2026-09-17T00:00:00Z',evidenceSha256:'c'.repeat(64)};
describe('preview-bound purge contracts',()=>{
  it('accepts exact preview and receipt but never whole-account completion claims',()=>{
    expect(parsePrivacyOperationResult({action:'previewPersonalPurge',privacyRequestId:id,policyVersion:'fictional'},preview)).toEqual(preview);
    expect(parsePrivacyOperationResult(command,receipt)).toEqual(receipt);
    for(const patch of [{privacyRequestId:other},{commandId:id},{policyVersion:'other'},{policySha256:'d'.repeat(64)},
      {inventorySha256:'e'.repeat(64)},{records:-1},{records:100001},{completeAccountDeletion:true},{outcome:'completed'},{evidenceSha256:''}])
      expect(()=>parsePrivacyOperationResult(command,{...receipt,...patch})).toThrow();
  });
  it('rejects owner selection, non-exact confirmation and incomplete preview binding',()=>{
    expect(privacyOperationSchema.safeParse(command).success).toBe(true);
    for(const patch of [{ownerId:other},{confirmation:'yes'},{confirmation:'PURGE PERSONAL HISTORY '},{policySha256:null},
      {inventorySha256:undefined},{commandId:'bad'},{policyVersion:''}])
      expect(privacyOperationSchema.safeParse({...command,...patch}).success).toBe(false);
  });
});
