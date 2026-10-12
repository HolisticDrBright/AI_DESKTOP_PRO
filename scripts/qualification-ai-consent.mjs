import {createHash} from 'node:crypto';

export const AI_CONSENT_VERSION='qualification-ask-alp-2026-10-12';
export const AI_CONSENT_COPY='I agree that Ask ALP may use my fictional test intake and lab-history records to generate AI responses for software testing. No real personal or health information may be entered.';
export const AI_CONSENT_SHA256=createHash('sha256').update(AI_CONSENT_COPY,'utf8').digest('hex');
export const AI_CONSENT_APPROVER='Brandon Bright — fictional-only Ask ALP consent approval via Codex chat, 2026-10-12';

/** This release is registered while AI remains disabled in the serving stack.
 * Registration alone never grants a consumer consent or enables the feature. */
export function assertAiConsentTarget(stack){
  const p=Object.fromEntries((stack?.Parameters??[]).map(row=>[row.ParameterKey,row.ParameterValue]));
  if(stack?.StackStatus!=='UPDATE_COMPLETE'||p.QualificationAccountId!=='588966314750'
    ||p.ApiId!=='6zt8e9qz04'||p.DatabaseName!=='clinical_core_qualification'
    ||p.PhiAllowed!=='false'||p.Activation!=='blocked'||p.QualificationExecution!=='enabled'
    ||p.SourceCommit!=='52cbda3fe5b7882210265a5a8fa5d817a066f9e4'
    ||p.QualificationReviewSha256!=='a4bf8c50ff4622205af82b3f59b5ed3ecdc35ac59fba0a7ed6238022b8f8fdf3'
    ||p.DatabaseReviewSha256!=='8ba8c615789f893627dd13d9653a9bf6b1c2567010e90800d2d92744dda7ca39'
    ||p.AllowedScopes!=='forms_checkins,lab_history'
    ||p.ActivationEvidenceSha256!=='')throw new Error('qualification_ai_consent_target_refused');
  return p;
}

export function classifyAiConsentRows(rows){
  if(!Array.isArray(rows)||rows.length>1)throw new Error('qualification_ai_consent_existing_refused');
  if(!rows.length)return 'missing';
  const row=rows[0];
  if(row.scope!=='ai_context'||row.version!==AI_CONSENT_VERSION
    ||row.contentSha256!==AI_CONSENT_SHA256||row.content!==AI_CONSENT_COPY
    ||row.approvedBy!==AI_CONSENT_APPROVER)throw new Error('qualification_ai_consent_existing_refused');
  return 'registered';
}
