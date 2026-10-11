import {test} from 'node:test';
import assert from 'node:assert/strict';
import {successorFullscriptTemplate} from './successor-fullscript-template.mjs';
import {SUCCESSOR_QUALIFICATION_RELEASE as release} from './successor-qualification-release.mjs';
// Explicit source-test fixture, not a built artifact or human review.
const build={contract:'successor-fullscript-api-build/1',...release,sourceCommit:'a'.repeat(40),sourceInputSha256:'b'.repeat(64),
 sourceClean:true,zipSha256:'c'.repeat(64),codeSha256:Buffer.from('c'.repeat(64),'hex').toString('base64'),
 handler:'index.handler',runtime:'nodejs22.x',phiAllowed:false,activation:'blocked',execution:'qualification_only',
 deployed:false,targetEmbedded:false,hostedQualified:false};
function evaluate(v,t,p){
 if(!v||typeof v!=='object')return v;
 if('Ref' in v)return p[v.Ref];
 if('Condition' in v)return evaluate(t.Conditions[v.Condition],t,p);
 if('Fn::Equals' in v)return evaluate(v['Fn::Equals'][0],t,p)===evaluate(v['Fn::Equals'][1],t,p);
 if('Fn::And' in v)return v['Fn::And'].every(x=>evaluate(x,t,p));
 if('Fn::Not' in v)return !evaluate(v['Fn::Not'][0],t,p);
 throw Error('Unknown condition');
}
test('separate template retains exact IAM, alarms, routes, code versions and default-off execution',()=>{
 const {parent,template:t}=successorFullscriptTemplate(build);
 assert.equal(t.Metadata.MigrationCount,117);assert.equal(t.Metadata.TargetContract,'fullscript-qualification-target-release/4');
 assert.deepEqual(t.Parameters.QualificationExecution,parent.Parameters.QualificationExecution);
 assert.deepEqual(t.Parameters.PhiAllowed.AllowedValues,['false']);assert.deepEqual(t.Parameters.Activation.AllowedValues,['blocked']);
 for(const [id,resource] of Object.entries(parent.Resources))if(id!=='Function')assert.deepEqual(t.Resources[id],resource);
 assert.deepEqual(t.Conditions.HistoricalEnabled,parent.Conditions.Enabled);
 assert.deepEqual(t.Resources.Function.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN,{Ref:'DatabaseSecretArn'});
 assert.equal(new RegExp(t.Parameters.DatabaseSecretArn.AllowedPattern).test('arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-operator-X'),false);
});
test('enabled fictional template is possible only with exact successor and parent constraints',()=>{
 const {template:t}=successorFullscriptTemplate(build);
 const p={...Object.fromEntries(Object.entries(t.Parameters).map(([k,v])=>[k,v.Default??'fictional'])),
  QualificationExecution:'true',ProviderSecretArn:'fictional-provider',DatabaseSecretArn:'fictional-worker',
  ConsumerAudience:'consumer',WorkforceAudience:'workforce',ConsumerPoolId:'consumer',WorkforcePoolId:'workforce',
  TargetObjectVersion:'version',CodeObjectVersion:'version','AWS::AccountId':'588966314750','AWS::Region':'us-east-2'};
 assert.equal(evaluate(t.Conditions.Enabled,t,p),true);
 for(const [k,v] of Object.entries({QualificationExecution:'false',SourceClean:'false',SourceInputSha256:'d'.repeat(64),
  MigrationAssemblySha256:'d'.repeat(64),MigrationReleaseSha256:'d'.repeat(64),SuccessorQualificationProfile:'old',
  'AWS::AccountId':'173535830222',TargetObjectVersion:'null'}))
  assert.equal(evaluate(t.Conditions.Enabled,t,{...p,[k]:v}),false,k);
});
for(const patch of [{sourceClean:false},{sourceInputSha256:'0'.repeat(64)},{migrationCount:112},
 {migrationAssemblySha256:'d'.repeat(64)},{phiAllowed:true},{activation:'approved'}])
 test('template refuses '+JSON.stringify(patch),()=>assert.throws(()=>successorFullscriptTemplate({...build,...patch})));
