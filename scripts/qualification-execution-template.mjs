// Deployment artifact only: the qualification execution profile shared by every production candidate template.
// A candidate deployed with QualificationExecution=enabled serves only the designated fictional identities against the
// isolated qualification database with PHI disabled and its production activation blocked (docs/aws-qualification-target.md).
// The condition is false, and the profile therefore inert, unless every boundary holds; the rule refuses a stack that names
// the profile without them. It never widens the production Active condition, and the two can never be true together.
const ref = name => ({Ref: name});
const nonempty = name => ({'Fn::Not': [{'Fn::Equals': [ref(name), '']}]});
export const PRODUCTION_ACCOUNT_ID = '173535830222';
export const SUBJECT = '[A-Za-z0-9:_-]{8,128}';
export function qualificationParameters() {
  return {
    QualificationExecution: {Type:'String',Default:'disabled',AllowedValues:['disabled','enabled']},
    QualificationReviewSha256: {Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
    QualificationAccountId: {Type:'String',Default:'',AllowedPattern:'^$|^[0-9]{12}$'},
    QualificationIdentitySubjects: {Type:'String',Default:'',AllowedPattern:`^$|^${SUBJECT}(,${SUBJECT}){0,15}$`},
  };
}
/** `Qualification` (the profile holds), `Enabled` (production Active or Qualification). `reviewed` names the candidate's own
 * reviewed-configuration parameters that must be present in either mode (never the production activation evidence). */
export function qualificationConditions(reviewed, {activation='Activation', active='Active'} = {}) {
  return {
    QualificationPosture: {'Fn::And':[
      {'Fn::Equals':[ref('QualificationExecution'),'enabled']},
      {'Fn::Equals':[ref('PhiAllowed'),'false']},
      {'Fn::Equals':[ref(activation),'blocked']},
      {'Fn::Not':[{'Fn::Equals':[ref('DatabaseName'),'clinical_core']}]},
      {'Fn::Equals':[ref('AWS::AccountId'),ref('QualificationAccountId')]},
      {'Fn::Not':[{'Fn::Equals':[ref('QualificationAccountId'),PRODUCTION_ACCOUNT_ID]}]},
    ]},
    Qualification: {'Fn::And':[{Condition:'QualificationPosture'},
      nonempty('QualificationReviewSha256'),nonempty('QualificationIdentitySubjects'),...reviewed.map(nonempty)]},
    Enabled: {'Fn::Or':[{Condition:active},{Condition:'Qualification'}]},
  };
}
export function qualificationRules({activation='Activation', extra=[]} = {}) {
  return {QualificationRequiresSyntheticPosture: {
    RuleCondition: {'Fn::Equals':[ref('QualificationExecution'),'enabled']},
    Assertions: [
      {Assert:{'Fn::Equals':[ref('PhiAllowed'),'false']},AssertDescription:'Qualification execution requires PhiAllowed=false'},
      {Assert:{'Fn::Equals':[ref(activation),'blocked']},AssertDescription:'Qualification execution requires the production activation to stay blocked'},
      {Assert:nonempty('QualificationReviewSha256'),AssertDescription:'QualificationReviewSha256 required for qualification execution'},
      {Assert:nonempty('QualificationAccountId'),AssertDescription:'QualificationAccountId required for qualification execution'},
      {Assert:{'Fn::Not':[{'Fn::Equals':[ref('QualificationAccountId'),PRODUCTION_ACCOUNT_ID]}]},AssertDescription:'The production account is never a qualification target'},
      {Assert:nonempty('QualificationIdentitySubjects'),AssertDescription:'QualificationIdentitySubjects required for qualification execution'},
      {Assert:{'Fn::Not':[{'Fn::Equals':[ref('DatabaseName'),'clinical_core']}]},AssertDescription:'The staging or canonical clinical_core database is never a qualification target'},
      ...extra,
    ],
  }};
}
/** Environment the function reads; every value is empty or disabled unless the Qualification condition holds. */
export function qualificationEnvironment() {
  return {
    QUALIFICATION_EXECUTION:{'Fn::If':['Qualification','enabled','disabled']},
    QUALIFICATION_REVIEW_SHA256:{'Fn::If':['Qualification',ref('QualificationReviewSha256'),'']},
    QUALIFICATION_ACCOUNT_ID:{'Fn::If':['Qualification',ref('QualificationAccountId'),'']},
    QUALIFICATION_IDENTITY_SUBJECTS:{'Fn::If':['Qualification',ref('QualificationIdentitySubjects'),'']},
  };
}
