import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fullscriptQualificationTemplate,fullscriptConsentQualificationTemplate} from './fullscript-qualification-template.mjs';
const digest=Buffer.alloc(32,7),build={contract:'fullscript-api-build/1',clean:true,sourceCommit:'a'.repeat(40),zipSha256:digest.toString('hex'),
 codeSha256:digest.toString('base64'),handler:'index.handler',runtime:'nodejs22.x',phiAllowed:false,activation:'blocked',
 execution:'qualification_only',deployed:false,targetEmbedded:false,hostedQualified:false};
const ref=name=>({Ref:name});
test('separate112 template preserves restricted resources and111 identity unchanged',()=>{
 const old=fullscriptQualificationTemplate(build),successor=fullscriptConsentQualificationTemplate(build);
 assert.equal(old.Metadata.MigrationCount,111);assert.equal(old.Metadata.TargetContract,'fullscript-qualification-target-release/2');
 assert.equal(successor.Metadata.MigrationCount,112);assert.equal(successor.Metadata.TargetContract,'fullscript-qualification-target-release/3');
 assert.equal(successor.Metadata.SchemaRelease,'telehealth-consent-copy/112');
 assert.equal(successor.Metadata.MigrationReleaseSha256,'45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4');
 assert.deepEqual(successor.Resources,old.Resources);assert.deepEqual(successor.Parameters,old.Parameters);
 assert.equal(successor.Metadata.ApprovedForPhi,false);assert.equal(successor.Metadata.HostedQualified,false);
});
function values(t){return {...Object.fromEntries(Object.entries(t.Parameters).map(([key,p])=>[key,p.Default??'FICTIONAL'])),
 'AWS::AccountId':'588966314750','AWS::Region':'us-east-2',QualificationExecution:'true',ProviderSecretArn:'FICTIONAL-provider',DatabaseSecretArn:'FICTIONAL-db',
 ConsumerAudience:'consumer',WorkforceAudience:'workforce',ConsumerPoolId:'consumer',WorkforcePoolId:'workforce'};}
function evaluate(v,parameters){if(v.Ref)return parameters[v.Ref];if(v['Fn::Equals'])return evaluate(v['Fn::Equals'][0],parameters)===evaluate(v['Fn::Equals'][1],parameters);
 if(v['Fn::Not'])return !evaluate(v['Fn::Not'][0],parameters);if(v['Fn::And'])return v['Fn::And'].every(x=>evaluate(x,parameters));return v;}
test('default creates only retained logs; source cannot enable PHI, production, another account or staging',()=>{
 const t=fullscriptQualificationTemplate(build),p=values(t);p.QualificationExecution='false';assert.equal(evaluate(t.Conditions.Enabled,p),false);
 assert.deepEqual(Object.entries(t.Resources).filter(([,r])=>!r.Condition).map(([name])=>name),['Logs']);
 assert.deepEqual(t.Parameters.PhiAllowed.AllowedValues,['false']);assert.deepEqual(t.Parameters.Activation.AllowedValues,['blocked']);
 assert.deepEqual(t.Parameters.DatabaseName.AllowedValues,['clinical_core_qualification']);assert.equal(t.Metadata.ApprovedForPhi,false);
});
for(const [key,value] of [['AWS::AccountId','173535830222'],['AWS::Region','us-east-1'],['QualificationExecution','false'],
 ['ProviderSecretArn','FICTIONAL-db'],['ConsumerAudience','workforce'],['ConsumerPoolId','workforce'],['TargetObjectVersion','null'],['CodeObjectVersion','null']])
 test('refuses candidate enablement with '+key+'='+value,()=>{const t=fullscriptQualificationTemplate(build),p=values(t);p[key]=value;assert.equal(evaluate(t.Conditions.Enabled,p),false);});
test('JWT routes and invoke permissions bind only the published numeric version and exact two POST paths',()=>{
 const t=fullscriptQualificationTemplate(build);assert.equal(evaluate(t.Conditions.Enabled,values(t)),true);
 assert.deepEqual(t.Resources.Version.Properties.CodeSha256,ref('CodeSha256'));assert.deepEqual(t.Resources.Integration.Properties.IntegrationUri,ref('Version'));
 for(const role of ['Consumer','Workforce']){const route=t.Resources[role+'Route'].Properties,permission=t.Resources[role+'Permission'].Properties;
  assert.equal(route.AuthorizationType,'JWT');assert.deepEqual(route.AuthorizerId,ref(role+'Authorizer'));assert.deepEqual(permission.FunctionName,ref('Version'));
  const authorizer=t.Resources[role+'Authorizer'];assert.equal(authorizer.Condition,'Enabled');assert.equal(authorizer.Properties.AuthorizerType,'JWT');
  assert.deepEqual(authorizer.Properties.IdentitySource,['$request.header.Authorization']);
  assert.deepEqual(authorizer.Properties.JwtConfiguration.Audience,[ref(role+'Audience')]);
  assert.deepEqual(authorizer.Properties.JwtConfiguration.Issuer,{'Fn::Sub':'https://cognito-idp.us-east-2.amazonaws.com/${'+role+'PoolId}'});
  assert.equal(permission.SourceAccount,'588966314750');assert.equal(permission.Principal,'apigateway.amazonaws.com');
  assert.equal(route.RouteKey,'POST /clinical-core/'+role.toLowerCase()+'/fullscript/draft');assert.ok(permission.SourceArn['Fn::Sub'].endsWith('/POST'+route.RouteKey.slice(5)));
 }
 assert.equal(Object.values(t.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route').length,2);
 assert.equal(Object.values(t.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Authorizer').length,2);
 assert.equal(Object.values(t.Resources).some(r=>r.Type==='AWS::Lambda::Url'||r.Type==='AWS::Lambda::Alias'),false);
});
test('secrets, target and tokens are individually scoped; no plaintext credential, provider mutation or broad clinical storage grant',()=>{
 const t=fullscriptQualificationTemplate(build),variables=t.Resources.Function.Properties.Environment.Variables;
 for(const key of ['FULLSCRIPT_CLIENT_SECRET','FULLSCRIPT_OAUTH_STATE_SECRET','FULLSCRIPT_CLIENT_ID'])assert.equal(key in variables,false);
 const statements=t.Resources.Role.Properties.Policies[0].PolicyDocument.Statement.filter(s=>s.Sid),get=id=>statements.find(s=>s.Sid===id);
 assert.deepEqual(get('ExactTargetVersion').Action,['s3:GetObjectVersion']);assert.deepEqual(get('ExactTargetVersion').Condition.StringEquals['s3:VersionId'],ref('TargetObjectVersion'));
 assert.deepEqual(get('PinnedProviderCredential').Resource,ref('ProviderSecretArn'));assert.deepEqual(get('PinnedProviderCredential').Condition.StringEquals['secretsmanager:VersionId'],ref('ProviderSecretVersion'));
 assert.deepEqual(get('ClinicCredentialCustody').Action,['dynamodb:GetItem','dynamodb:PutItem']);
 assert.deepEqual(get('ClinicCredentialCustody').Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'],[{'Fn::Sub':'ORG#${OrganizationId}'}]);
 const actions=statements.flatMap(s=>s.Action);assert.ok(actions.every(a=>!a.includes('*')));assert.ok(statements.every(s=>s.Resource!=='*'));
 assert.ok(!actions.some(a=>/PutSecret|Delete|Scan|Query|InvokeFunction|UpdateFunction|PassRole|Publish|s3:Put/.test(a)));
 assert.equal(t.Resources.Function.Properties.ReservedConcurrentExecutions,1);
 for(const name of ['ErrorsAlarm','ThrottlesAlarm'])assert.deepEqual(t.Resources[name].Properties.AlarmActions,[ref('AlarmTopicArn')]);
});
for(const delta of [{clean:false},{phiAllowed:true},{activation:'approved'},{codeSha256:Buffer.alloc(32,9).toString('base64')},
 {targetEmbedded:true},{deployed:true},{hostedQualified:true},{sourceCommit:'bad'}])test('refuses unsafe build '+JSON.stringify(delta),()=>{
 assert.throws(()=>fullscriptQualificationTemplate({...build,...delta}),/fullscript_template_build_refused/);
});
