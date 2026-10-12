import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AI_CONSENT_VERSION,AI_CONSENT_COPY,AI_CONSENT_SHA256,AI_CONSENT_APPROVER,assertAiConsentTarget,classifyAiConsentRows} from './qualification-ai-consent.mjs';

const parameters={QualificationAccountId:'588966314750',ApiId:'6zt8e9qz04',DatabaseName:'clinical_core_qualification',
  PhiAllowed:'false',Activation:'blocked',QualificationExecution:'enabled',SourceCommit:'52cbda3fe5b7882210265a5a8fa5d817a066f9e4',
  AllowedScopes:'forms_checkins,lab_history',ActivationEvidenceSha256:'',
  QualificationReviewSha256:'a4bf8c50ff4622205af82b3f59b5ed3ecdc35ac59fba0a7ed6238022b8f8fdf3',
  DatabaseReviewSha256:'8ba8c615789f893627dd13d9653a9bf6b1c2567010e90800d2d92744dda7ca39'};
const stack=values=>({StackStatus:'UPDATE_COMPLETE',Parameters:Object.entries(values).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}))});
const row={scope:'ai_context',version:AI_CONSENT_VERSION,contentSha256:AI_CONSENT_SHA256,content:AI_CONSENT_COPY,approvedBy:AI_CONSENT_APPROVER};

test('register only to the exact PHI-off qualification stack while AI is disabled',()=>{
  assert.deepEqual(assertAiConsentTarget(stack(parameters)),parameters);
  for(const [key,value] of Object.entries({QualificationAccountId:'173535830222',ApiId:'wxv734oi12',DatabaseName:'clinical_core',
    PhiAllowed:'true',Activation:'approved',QualificationExecution:'disabled',SourceCommit:'other',
    AllowedScopes:'forms_checkins,lab_history,ai_context',ActivationEvidenceSha256:'a'.repeat(64),
    QualificationReviewSha256:'b'.repeat(64),DatabaseReviewSha256:'c'.repeat(64)})){
    assert.throws(()=>assertAiConsentTarget(stack({...parameters,[key]:value})),/qualification_ai_consent_target_refused/);
  }
  assert.throws(()=>assertAiConsentTarget({...stack(parameters),StackStatus:'UPDATE_IN_PROGRESS'}),/qualification_ai_consent_target_refused/);
});
test('idempotent exact release; refuse different or multiple AI releases',()=>{
  assert.equal(classifyAiConsentRows([]),'missing');
  assert.equal(classifyAiConsentRows([row]),'registered');
  for(const key of Object.keys(row))assert.throws(()=>classifyAiConsentRows([{...row,[key]:'different'}]),/qualification_ai_consent_existing_refused/);
  assert.throws(()=>classifyAiConsentRows([row,row]),/qualification_ai_consent_existing_refused/);
});
