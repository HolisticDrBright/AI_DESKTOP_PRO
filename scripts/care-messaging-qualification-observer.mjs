import {createHash} from 'node:crypto';
import {careMessagingZip} from './care-messaging-zip.mjs';
import {QUALIFICATION_CONSENT_LEDGER} from './qualification-consent-ledger.mjs';

export const CARE_OBSERVER=Object.freeze({account:'588966314750',region:'us-east-2',database:'clinical_core_qualification',
 foundation:'ai-clinical-core-qualification-foundation',stack:'ai-clinical-core-qualification-care-messaging'});
export const CARE_CONNECTION_OBSERVER=Object.freeze({...CARE_OBSERVER,stack:'ai-clinical-core-qualification-care-connections'});
export class CareObservationError extends Error{constructor(category){super(category);this.category=category;}}
const refuse=category=>{throw new CareObservationError(category);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(record(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const same=(a,b,category)=>{if(canonical(a)!==canonical(b))refuse(category);};
function pairs(rows,key,value){
 if(!Array.isArray(rows))refuse('observation_shape_refused');const result={};
 for(const row of rows){if(!record(row)||typeof row[key]!=='string'||typeof row[value]!=='string'||Object.hasOwn(result,row[key]))refuse('observation_shape_refused');result[row[key]]=row[value];}
 return result;
}
export function assertCareArtifact({manifest,code,templateBytes,zip},head){
 return assertArtifact({manifest,code,templateBytes,zip},head,'care-messaging');
}
export function assertCareConnectionsArtifact(artifact,head){return assertArtifact(artifact,head,'care-connections');}
function assertArtifact({manifest,code,templateBytes,zip},head,candidate){
 if(!record(manifest)||manifest.contract!==candidate+'-deployment/1'||manifest.sourceClean!==true
  ||manifest.sourceCommit!==head||!/^[a-f0-9]{40}$/.test(head)||manifest.migrationCount!==106
  ||manifest.migrationReleaseSha256!==QUALIFICATION_CONSENT_LEDGER||manifest.deploymentPerformed!==false
  ||!Buffer.isBuffer(code)||!Buffer.isBuffer(templateBytes)||!Buffer.isBuffer(zip)
  ||manifest.codeSha256!==sha(code)||manifest.templateSha256!==sha(templateBytes)
  ||manifest.deploymentZipSha256!==sha(zip)||manifest.deploymentZipBytes!==zip.length)refuse('artifact_refused');
 if(!careMessagingZip(code).equals(zip))refuse('artifact_refused');
 same(manifest.defaults,{phiAllowed:false,activation:'blocked',qualification:'disabled',
  ...(candidate==='care-connections'?{claimRecoveryEnabled:false}:{})},'artifact_refused');
 if(candidate==='care-connections'&&(!Array.isArray(manifest.functions)||manifest.functions.length!==7
  ||!Array.isArray(manifest.claimFunctions)||manifest.claimFunctions.length!==2))refuse('artifact_refused');
 let template;try{template=JSON.parse(templateBytes.toString('utf8'));}catch{refuse('artifact_refused');}
 same(template.Parameters?.SourceCommit?.AllowedValues,[head],'artifact_refused');
 same(template.Parameters?.MigrationReleaseSha256?.AllowedValues,[QUALIFICATION_CONSENT_LEDGER],'artifact_refused');
 return {manifest,code,template,zip};
}
export function assertCareFoundation(stack){
 const c=CARE_OBSERVER;
 if(!record(stack)||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus)
  ||!stack.StackId?.startsWith(`arn:aws:cloudformation:${c.region}:${c.account}:stack/${c.foundation}/`))refuse('foundation_refused');
 const o=pairs(stack.Outputs,'OutputKey','OutputValue');
 if(o.PhiAllowed!=='false'||o.Activation!=='blocked'||o.QualificationExecution!=='disabled'
  ||o.QualificationInfrastructure!=='prepared_no_candidates'||o.DatabaseName!==c.database
  ||!/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(o.DatabaseClusterArn??'')
  ||!/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(o.DatabaseSecretArn??'')
  ||!/^[a-z0-9]{10}$/.test(o.ApiId??'')||o.ApiOrigin!==`https://${o.ApiId}.execute-api.${c.region}.amazonaws.com`)refuse('foundation_refused');
 return o;
}
export function assertCareBinding(binding,artifact,foundation){
 return assertBinding(binding,artifact,foundation,'care-messaging');
}
export function assertCareConnectionsBinding(binding,artifact,foundation){return assertBinding(binding,artifact,foundation,'care-connections');}
const scopes=['programs','protocols_supplements','nutrition','appointments','messaging','forms_checkins','symptoms_adherence',
 'wearables','reproductive_health','lab_summaries','lab_results_import','lab_specimen_context','billing_links','research_n_of_1'];
function assertBinding(binding,artifact,foundation,candidate){
 const keys=['contract','sourceCommit','migrationReleaseSha256','apiId','organizationId','consumerIssuer','consumerAudience',
  'workforceIssuer','workforceAudience','codeBucket','codeKey','codeVersion','secretKmsKeyArn','logsKmsKeyArn','alarmTopicArn','subjects','reviews'];
 if(candidate==='care-connections')keys.push('claimRecoveryEnabled','enabledConsentScopes');
 if(!record(binding)||Object.keys(binding).length!==keys.length||keys.some(k=>!Object.hasOwn(binding,k))
  ||binding.contract!==candidate+'-qualification-binding/1'||binding.sourceCommit!==artifact.manifest.sourceCommit
  ||binding.migrationReleaseSha256!==QUALIFICATION_CONSENT_LEDGER||binding.apiId!==foundation.ApiId||!uuid.test(binding.organizationId??''))refuse('binding_refused');
 for(const pool of ['consumer','workforce']){
  if(!/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(binding[pool+'Issuer']??'')
   ||!/^[a-zA-Z0-9]{20,128}$/.test(binding[pool+'Audience']??''))refuse('binding_refused');
 }
 if(binding.consumerIssuer===binding.workforceIssuer||binding.consumerAudience===binding.workforceAudience
  ||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(binding.codeBucket??'')
  ||!/^[A-Za-z0-9/_.-]{1,1024}$/.test(binding.codeKey??'')||typeof binding.codeVersion!=='string'
  ||!binding.codeVersion.length||binding.codeVersion==='null'||binding.codeVersion.length>1024)refuse('binding_refused');
 for(const key of ['secretKmsKeyArn','logsKmsKeyArn'])if(!/^arn:aws:kms:us-east-2:588966314750:key\/[a-f0-9-]{36}$/.test(binding[key]??''))refuse('binding_refused');
 if(!/^arn:aws:sns:us-east-2:588966314750:[A-Za-z0-9_-]+$/.test(binding.alarmTopicArn??''))refuse('binding_refused');
 if(!Array.isArray(binding.subjects)||binding.subjects.length<3||binding.subjects.length>4||binding.subjects.some(s=>!uuid.test(s))
  ||new Set(binding.subjects).size!==binding.subjects.length)refuse('binding_refused');
 const reviews=['database','workforceMfa',...(candidate==='care-connections'?['connection','consent']:['messaging']),'retention','qualification'];
 if(candidate==='care-connections'){
  if(typeof binding.claimRecoveryEnabled!=='boolean'||!Array.isArray(binding.enabledConsentScopes)
   ||binding.enabledConsentScopes.some(s=>!scopes.includes(s))||new Set(binding.enabledConsentScopes).size!==binding.enabledConsentScopes.length)
   refuse('binding_refused');
  if(binding.claimRecoveryEnabled)reviews.push('claimRecovery');
 }
 if(!record(binding.reviews)||Object.keys(binding.reviews).length!==reviews.length||reviews.some(k=>!hash.test(binding.reviews[k]??'')
  ||/^0+$/.test(binding.reviews[k])))refuse('review_binding_refused');
 // Hash syntax and exact equality never claim a human review actually occurred.
 return binding;
}
function expectedParameters(b,f,candidate){return {ApiId:b.apiId,ConsumerIssuer:b.consumerIssuer,ConsumerAudience:b.consumerAudience,
 WorkforceIssuer:b.workforceIssuer,WorkforceAudience:b.workforceAudience,OrganizationId:b.organizationId,PhiAllowed:'false',Activation:'blocked',
 ActivationEvidenceSha256:'',DatabaseReviewSha256:b.reviews.database,WorkforceMfaReviewSha256:b.reviews.workforceMfa,
 ...(candidate==='care-connections'?{ConnectionReviewSha256:b.reviews.connection,ConsentReviewSha256:b.reviews.consent,
  ClaimRecoveryEnabled:String(b.claimRecoveryEnabled),ClaimRecoveryReviewSha256:b.reviews.claimRecovery??'',EnabledConsentScopes:b.enabledConsentScopes.join(',')}
  :{MessagingReviewSha256:b.reviews.messaging}),RetentionReviewSha256:b.reviews.retention,DatabaseClusterArn:f.DatabaseClusterArn,
 DatabaseSecretArn:f.DatabaseSecretArn,DatabaseName:CARE_OBSERVER.database,SecretKmsKeyArn:b.secretKmsKeyArn,LogsKmsKeyArn:b.logsKmsKeyArn,
 AlarmTopicArn:b.alarmTopicArn,CodeBucket:b.codeBucket,CodeKey:b.codeKey,CodeVersion:b.codeVersion,SourceCommit:b.sourceCommit,
 MigrationReleaseSha256:b.migrationReleaseSha256,QualificationExecution:'enabled',QualificationAccountId:CARE_OBSERVER.account,
 QualificationDatabaseName:CARE_OBSERVER.database,QualificationReviewSha256:b.reviews.qualification,QualificationIdentitySubjects:b.subjects.join(',')};}
function resources(value){
 if(!Array.isArray(value?.StackResourceSummaries)||value.NextToken)refuse('resources_refused');const out={};
 for(const r of value.StackResourceSummaries){if(!r.LogicalResourceId||typeof r.PhysicalResourceId!=='string'||Object.hasOwn(out,r.LogicalResourceId)
  ||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(r.ResourceStatus))refuse('resources_refused');out[r.LogicalResourceId]=r;}
 return out;
}
function evaluate(value,parameters,attrs){
 if(Array.isArray(value))return value.map(v=>evaluate(v,parameters,attrs));
 if(!record(value))return value;
 if(Object.hasOwn(value,'Ref')){if(!Object.hasOwn(parameters,value.Ref))refuse('template_expression_refused');return parameters[value.Ref];}
 if(Object.hasOwn(value,'Fn::GetAtt')){const key=value['Fn::GetAtt'].join('.');if(!Object.hasOwn(attrs,key))refuse('template_expression_refused');return attrs[key];}
 if(Object.hasOwn(value,'Fn::Sub'))return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g,(_m,k)=>{if(!Object.hasOwn(parameters,k))refuse('template_expression_refused');return parameters[k];});
 if(Object.hasOwn(value,'Fn::If')){if(!['Enabled','Qualification'].includes(value['Fn::If'][0]))refuse('template_expression_refused');return evaluate(value['Fn::If'][1],parameters,attrs);}
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,evaluate(v,parameters,attrs)]));
}
function policy(value){
 if(typeof value==='string'){try{value=JSON.parse(decodeURIComponent(value));}catch{refuse('iam_refused');}}
 if(!record(value)||!Array.isArray(value.Statement))refuse('iam_refused');
 const normalize=v=>{
  if(Array.isArray(v))return v.map(normalize).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  if(!record(v))return v;return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='Sid')
   .map(([k,x])=>[k,['Action','Resource'].includes(k)?normalize(Array.isArray(x)?x:[x]):normalize(x)]));
 };return normalize(value);
}
const messagingRoutes=[['RouteConsumerMessages','ConsumerAuthorizer','POST /clinical-core/consumer/messages'],
 ['RouteWorkforceMessages','WorkforceAuthorizer','POST /clinical-core/workforce/messages'],
 ['RouteConsumerExport','ConsumerAuthorizer','POST /clinical-core/consumer/messages/export']];
const connectionRoutes=[['RouteConsumerConnection','ConsumerAuthorizer','POST /clinical-core/consumer/connection'],
 ['RouteWorkforceConnection','WorkforceAuthorizer','POST /clinical-core/workforce/connection'],
 ['RouteConsumerClaimRecovery','ConsumerAuthorizer','POST /clinical-core/consumer/connection-claims']];

/** Dependencies must make their own actual read-only AWS/ledger observations.
 * This verifies deployment bindings, NOT approvals, runtime acceptance or PHI.
 * Repeated metadata reads detect ordinary concurrent deployment drift, not an
 * atomic AWS snapshot or subsequent changes after this inspection. */
export async function inspectCareMessagingQualification(input){return inspectCareQualification(input,'care-messaging');}
export async function inspectCareConnectionsQualification(input){return inspectCareQualification(input,'care-connections');}
async function inspectCareQualification({artifact,head,binding,readAws,readCodeVersion,inspectLedger},candidate){
 const a=assertArtifact(artifact,head,candidate),c=candidate==='care-connections'?CARE_CONNECTION_OBSERVER:CARE_OBSERVER;
 const routes=candidate==='care-connections'?connectionRoutes:messagingRoutes;
 const transport=readAws,observations=[];
 readAws=async(service,operation,parameters)=>{
  const result=await transport(service,operation,parameters);
  observations.push({service,operation,parameters:structuredClone(parameters),result:structuredClone(result)});
  return result;
 };
 const repeat=async()=>{
  for(const observation of observations)same(await transport(observation.service,observation.operation,observation.parameters),observation.result,'observation_changed');
  same(await inspectLedger(f),ledger,'observation_changed');
 };
 const caller=await readAws('sts','get-caller-identity',{});
 if(caller?.Account!==c.account||!/^arn:aws:sts::588966314750:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(caller?.Arn??''))refuse('principal_refused');
 const startFoundation=await readAws('cloudformation','describe-stacks',{StackName:c.foundation});
 if(startFoundation?.Stacks?.length!==1)refuse('foundation_refused');const f=assertCareFoundation(startFoundation.Stacks[0]);
 if(binding)assertBinding(binding,a,f,candidate);
 const ledger=await inspectLedger(f);
 if(ledger?.database!==c.database||ledger?.release!==QUALIFICATION_CONSENT_LEDGER||ledger?.rolledBack!==true||ledger?.rows!==106)refuse('ledger_refused');
 const api=await readAws('apigatewayv2','get-api',{ApiId:f.ApiId});
 if(api?.ApiId!==f.ApiId||api.ApiEndpoint!==f.ApiOrigin||api.ProtocolType!=='HTTP'||api.DisableExecuteApiEndpoint===true)refuse('api_refused');
 let start;
 try{start=await readAws('cloudformation','describe-stacks',{StackName:c.stack});}
 catch(e){if(e instanceof CareObservationError&&e.category==='stack_missing'){
  await repeat();
  try{await transport('cloudformation','describe-stacks',{StackName:c.stack});refuse('observation_changed');}
  catch(final){if(!(final instanceof CareObservationError)||final.category!=='stack_missing')throw final;}
  return {status:'not_deployed',mutations:false,acceptance:false,phiAllowed:false,account:c.account,database:c.database,
   sourceCommit:head,migrationReleaseSha256:QUALIFICATION_CONSENT_LEDGER,wholeLedgerVerified:true,codeUploadedVerified:false};
 }throw e;}
 if(!binding)refuse('reviewed_binding_required');
 if(start?.Stacks?.length!==1)refuse('stack_refused');const stack=start.Stacks[0];
 if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus)||!stack.StackId?.startsWith(`arn:aws:cloudformation:${c.region}:${c.account}:stack/${c.stack}/`))refuse('stack_refused');
 const p=expectedParameters(binding,f,candidate);same(pairs(stack.Parameters,'ParameterKey','ParameterValue'),p,'parameters_refused');
 const output=pairs(stack.Outputs,'OutputKey','OutputValue');
 same(output,{PhiAllowed:'false',Activation:'blocked',SourceCommit:head,MigrationReleaseSha256:QUALIFICATION_CONSENT_LEDGER,
  DatabaseName:c.database,QualificationExecution:'enabled',FunctionName:f.ApiId+'-'+candidate,
  ...(candidate==='care-connections'?{ClaimRecoveryEnabled:String(binding.claimRecoveryEnabled)}:{})},'outputs_refused');
 const template=await readAws('cloudformation','get-template',{StackName:c.stack,TemplateStage:'Original'});
 let actualTemplate=template?.TemplateBody;try{if(typeof actualTemplate==='string')actualTemplate=JSON.parse(actualTemplate);}catch{refuse('template_refused');}
 same(actualTemplate,a.template,'template_refused');
 const r=resources(await readAws('cloudformation','list-stack-resources',{StackName:c.stack}));
 same(Object.keys(r).sort(),Object.keys(a.template.Resources).sort(),'resources_refused');
 for(const [id,value] of Object.entries(r))if(value.ResourceType!==a.template.Resources[id].Type)refuse('resources_refused');
 const arn=`arn:aws:lambda:${c.region}:${c.account}:function:${f.ApiId}-${candidate}`;
 if(r.Function.PhysicalResourceId!==output.FunctionName)refuse('function_refused');
 const fn=await readAws('lambda','get-function-configuration',{FunctionName:arn});
 const vars=evaluate(a.template.Resources.Function.Properties.Environment.Variables,{...p,'AWS::AccountId':c.account},{});
 if(fn?.FunctionArn!==arn||fn.FunctionName!==output.FunctionName||fn.State!=='Active'||fn.LastUpdateStatus!=='Successful'
  ||fn.Runtime!=='nodejs22.x'||fn.Handler!=='index.handler'||fn.Timeout!==29||fn.MemorySize!==256||fn.PackageType!=='Zip'
  ||fn.CodeSize!==a.zip.length||fn.CodeSha256!==Buffer.from(a.manifest.deploymentZipSha256,'hex').toString('base64')
  ||!fn.RevisionId||fn.Environment?.Error||fn.Layers?.length||fn.FileSystemConfigs?.length||fn.VpcConfig?.VpcId)refuse('function_refused');
 same(fn.Environment?.Variables,vars,'environment_refused');
 if(fn.LoggingConfig?.LogGroup!==`/aws/lambda/${output.FunctionName}`)refuse('logs_refused');
 const concurrency=await readAws('lambda','get-function-concurrency',{FunctionName:arn});
 if(concurrency?.ReservedConcurrentExecutions!==2)refuse('concurrency_refused');
 const stored=await readCodeVersion({Bucket:p.CodeBucket,Key:p.CodeKey,VersionId:p.CodeVersion,ExpectedBucketOwner:c.account},a.zip.length);
 if(!Buffer.isBuffer(stored)||!stored.equals(a.zip))refuse('uploaded_code_refused');
 const logGroup=await readAws('logs','describe-log-groups',{LogGroupNamePrefix:`/aws/lambda/${output.FunctionName}`});
 const log=(logGroup?.logGroups??[]).filter(l=>l.logGroupName===`/aws/lambda/${output.FunctionName}`);
 if(log.length!==1||log[0].kmsKeyId!==p.LogsKmsKeyArn||log[0].retentionInDays!==30)refuse('logs_refused');
 const logArn=`arn:aws:logs:${c.region}:${c.account}:log-group:/aws/lambda/${output.FunctionName}:*`;
 if(log[0].arn!==logArn)refuse('logs_refused');
 const roleName=r.Role.PhysicalResourceId,role=await readAws('iam','get-role',{RoleName:roleName});
 if(role?.Role?.Arn!==fn.Role||role.Role.RoleName!==roleName||!fn.Role?.startsWith(`arn:aws:iam::${c.account}:role/`)
  ||role.Role.PermissionsBoundary)refuse('iam_refused');
 same(policy(role.Role.AssumeRolePolicyDocument),policy(a.template.Resources.Role.Properties.AssumeRolePolicyDocument),'iam_refused');
 const attached=await readAws('iam','list-attached-role-policies',{RoleName:roleName});
 if(!Array.isArray(attached?.AttachedPolicies)||attached.AttachedPolicies.length||attached.IsTruncated)refuse('iam_refused');
 const policies=await readAws('iam','list-role-policies',{RoleName:roleName});
 const wanted=evaluate(a.template.Resources.Role.Properties.Policies,{...p,'AWS::AccountId':c.account,'AWS::Region':c.region},{'Logs.Arn':logArn});
 if(policies?.IsTruncated)refuse('iam_refused');same([...(policies?.PolicyNames??[])].sort(),wanted.map(p=>p.PolicyName).sort(),'iam_refused');
 for(const expected of wanted){const actual=await readAws('iam','get-role-policy',{RoleName:roleName,PolicyName:expected.PolicyName});
  same(policy(actual?.PolicyDocument),policy(expected.PolicyDocument),'iam_refused');}
 const allRoutes=await readAws('apigatewayv2','get-routes',{ApiId:f.ApiId});
 if(!Array.isArray(allRoutes?.Items)||allRoutes.NextToken)refuse('routes_refused');
 const integrationId=r.Integration.PhysicalResourceId;
 if(allRoutes.Items.filter(route=>route.Target===`integrations/${integrationId}`).length!==3)refuse('routes_refused');
 for(const [logical,authorizer,key] of routes){const matches=allRoutes.Items.filter(route=>route.RouteKey===key);
  if(matches.length!==1||matches[0].RouteId!==r[logical].PhysicalResourceId||matches[0].Target!==`integrations/${integrationId}`
   ||matches[0].AuthorizationType!=='JWT'||matches[0].AuthorizerId!==r[authorizer].PhysicalResourceId)refuse('routes_refused');}
 for(const pool of ['Consumer','Workforce']){
  const auth=await readAws('apigatewayv2','get-authorizer',{ApiId:f.ApiId,AuthorizerId:r[pool+'Authorizer'].PhysicalResourceId});
  if(auth?.AuthorizerType!=='JWT'||auth.AuthorizerId!==r[pool+'Authorizer'].PhysicalResourceId)refuse('authorizer_refused');
  same(auth.IdentitySource,['$request.header.Authorization'],'authorizer_refused');
  same(auth.JwtConfiguration,{Issuer:p[pool+'Issuer'],Audience:[p[pool+'Audience']]},'authorizer_refused');
 }
 const integration=await readAws('apigatewayv2','get-integration',{ApiId:f.ApiId,IntegrationId:integrationId});
 if(integration?.IntegrationUri!==arn||integration.IntegrationType!=='AWS_PROXY'||integration.PayloadFormatVersion!=='2.0'
  ||integration.TimeoutInMillis!==30000||integration.IntegrationId!==integrationId||integration.CredentialsArn)refuse('integration_refused');
 const invoke=await readAws('lambda','get-policy',{FunctionName:arn});
 let invokePolicy;try{invokePolicy=JSON.parse(invoke.Policy);}catch{refuse('invoke_refused');}
 same(policy(invokePolicy),policy({Version:'2012-10-17',Statement:routes.map(([, ,key])=>({Effect:'Allow',Action:'lambda:InvokeFunction',
  Resource:arn,Principal:{Service:'apigateway.amazonaws.com'},Condition:{StringEquals:{'AWS:SourceAccount':c.account},
   ArnLike:{'AWS:SourceArn':`arn:aws:execute-api:${c.region}:${c.account}:${f.ApiId}/*/POST/${key.slice(6)}`}}}))}),'invoke_refused');
 // The API uses its default stage; a route not yet deployed cannot qualify.
 const stages=await readAws('apigatewayv2','get-stages',{ApiId:f.ApiId});
 const stage=(stages?.Items??[]).filter(s=>s.StageName==='$default');
 if(stage.length!==1||stage[0].AutoDeploy!==true||!stage[0].DeploymentId)refuse('stage_refused');
 const alarms=await readAws('cloudwatch','describe-alarms',{AlarmNames:[r.Errors.PhysicalResourceId,r.ApiServerErrors.PhysicalResourceId]});
 if(alarms?.MetricAlarms?.length!==2||alarms.CompositeAlarms?.length)refuse('alarms_refused');
 for(const [id,namespace,metric,dimension,value] of [['Errors','AWS/Lambda','Errors','FunctionName',output.FunctionName],['ApiServerErrors','AWS/ApiGateway','5xx','ApiId',f.ApiId]]){
  const alarm=alarms.MetricAlarms.find(x=>x.AlarmName===r[id].PhysicalResourceId);
  if(!alarm||alarm.Namespace!==namespace||alarm.MetricName!==metric||alarm.Statistic!=='Sum'||alarm.Period!==60
   ||alarm.EvaluationPeriods!==1||alarm.Threshold!==1||alarm.ComparisonOperator!=='GreaterThanOrEqualToThreshold'
   ||alarm.TreatMissingData!=='notBreaching'||alarm.ActionsEnabled!==true)refuse('alarms_refused');
  same(alarm.Dimensions,[{Name:dimension,Value:value}],'alarms_refused');same(alarm.AlarmActions,[p.AlarmTopicArn],'alarms_refused');
 }
 // Repeat the actual snapshots. This is drift detection, not an atomic lock.
 await repeat();
 const finalStored=await readCodeVersion({Bucket:p.CodeBucket,Key:p.CodeKey,VersionId:p.CodeVersion,ExpectedBucketOwner:c.account},a.zip.length);
 if(!Buffer.isBuffer(finalStored)||!finalStored.equals(stored))refuse('observation_changed');
 return {status:'deployment_bindings_verified',mutations:false,acceptance:false,humanReviewsVerified:false,phiAllowed:false,
  account:c.account,database:c.database,sourceCommit:head,migrationReleaseSha256:QUALIFICATION_CONSENT_LEDGER,
  wholeLedgerVerified:true,uploadedVersionVerified:true,deploymentZipSha256:a.manifest.deploymentZipSha256,
  remaining:['human evidence review','actual positive/negative API acceptance','matched fleet and device acceptance']};
}
