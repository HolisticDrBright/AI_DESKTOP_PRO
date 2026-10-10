import {expect,it,vi} from 'vitest';
import {deploymentDigest,type DeploymentPlan} from './qualification-deployment-execution';
import {observeFullscriptDeploymentResources,type FullscriptResourcePort} from './qualification-deployment-resources';
type Obj=Record<string,unknown>;
// Fictional observations only. Neither a review nor hosted acceptance.
function fixture(){
 const now=Date.parse('2026-10-09T21:00:00Z'),code=Buffer.from('FICTIONAL ZIP'),targetBytes=Buffer.from('FICTIONAL TARGET');
 const target={apiId:'fictionalapi',clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',databaseName:'clinical_core_qualification',
  organizationId:'11111111-1111-4111-8111-111111111111',consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',
  workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce',consumerAudience:'fictional-consumer-client',workforceAudience:'fictional-workforce-client',
  consumerSubjects:['fictional-one','fictional-two'],workforceSubjects:['fictional-staff'],migrations:[{version:'fictional',sha256:'a'.repeat(64)}]};
 const credentials={tokenTable:'fictional-tokens',providerSecretVersion:'b'.repeat(32)};
 const parameters={DatabaseSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-db',DatabaseSecretKmsKeyArn:'',
  ProviderSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-provider',ProviderSecretKmsKeyArn:'',
  AlarmTopicArn:'arn:aws:sns:us-east-2:588966314750:fictional',CodeKey:'fictional-code.zip',CodeObjectVersion:'fictional-code-version',
  TargetKey:'fictional-target.json',TargetObjectVersion:'fictional-target-version'};
 const plan={sourceCommit:'c'.repeat(40),reviewSha256:'d'.repeat(64),zipSha256:deploymentDigest(code),targetSha256:deploymentDigest(targetBytes),
  target:{target,credentials},parameters:Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}))} as DeploymentPlan;
 const identity={Account:'588966314750',Arn:'arn:aws:sts::588966314750:assumed-role/FictionalRole/fictional'};
 const role=(name:string)=>({name,superuser:false,createRole:false,createDatabase:false,replication:false,bypassRls:false});
 const login='alp_fullscript_qualification_fictional',worker='fullscript_draft_worker';
 const sql:Obj={databaseName:target.databaseName,workerRole:worker,readOnly:true,rollbackConfirmed:true,loginName:login,
  reachableRoles:[role(login),role(worker)],workerRoles:[role(worker)],
  workerTablePrivileges:['fullscript_delivery.draft_intents:SELECT','fullscript_delivery.draft_intents:INSERT','fullscript_delivery.draft_intents:UPDATE'],
  loginTablePrivileges:[],loginSchemaCreate:[],workerSchemaCreate:[],ledger:target.migrations};
 const rawMetadata=async(service:string,action:string,input:Obj):Promise<Obj>=>{
  if(service==='apigatewayv2')return action==='get-api'?{ApiId:target.apiId,ProtocolType:'HTTP',ApiEndpoint:`https://${target.apiId}.execute-api.us-east-2.amazonaws.com`}:{Items:[]};
  if(service==='rds')return {DBClusters:[{DBClusterArn:target.clusterArn,Engine:'aurora-postgresql',Status:'available',HttpEndpointEnabled:true,StorageEncrypted:true}]};
  if(service==='secretsmanager')return {ARN:input.SecretId,VersionIdsToStages:input.SecretId===parameters.ProviderSecretArn?{[credentials.providerSecretVersion]:['AWSCURRENT']}:{'fictional-db-version':['AWSCURRENT']}};
  if(service==='kms')return {KeyMetadata:{Arn:input.KeyId,KeyState:'Enabled',KeyUsage:'ENCRYPT_DECRYPT',KeyManager:'CUSTOMER'}};
  if(service==='dynamodb')return {Table:{TableName:credentials.tokenTable,TableArn:`arn:aws:dynamodb:us-east-2:588966314750:table/${credentials.tokenTable}`,TableStatus:'ACTIVE',
   KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]}};
  if(service==='sns')return {Attributes:{TopicArn:parameters.AlarmTopicArn,Owner:'588966314750'}};
  if(service==='cognito-idp'){
   if(action==='describe-user-pool')return {UserPool:{Id:input.UserPoolId,Arn:`arn:aws:cognito-idp:us-east-2:588966314750:userpool/${input.UserPoolId}`,MfaConfiguration:'ON'}};
   if(action==='describe-user-pool-client')return {UserPoolClient:{UserPoolId:input.UserPoolId,ClientId:input.ClientId,SupportedIdentityProviders:['COGNITO'],ExplicitAuthFlows:['ALLOW_USER_PASSWORD_AUTH','ALLOW_REFRESH_TOKEN_AUTH']}};
   const n=['fictional-one','fictional-two','fictional-staff'].indexOf(String(input.Username))+1;
   return {Enabled:true,UserStatus:'CONFIRMED',UserMFASettingList:['SOFTWARE_TOKEN_MFA'],PreferredMfaSetting:'SOFTWARE_TOKEN_MFA',UserAttributes:Object.entries({
    sub:input.Username,'custom:organization_id':target.organizationId,email_verified:'true','custom:production_bound':'true',
    'custom:person_id':`${n}1111111-1111-4111-8111-111111111111`}).map(([Name,Value])=>({Name,Value}))};
  }
  throw Error('unrouted fictional metadata');
 };
 const port:FullscriptResourcePort={now:()=>now,identity:vi.fn(async()=>structuredClone(identity)),metadata:vi.fn(rawMetadata),
  database:vi.fn(async()=>structuredClone(sql)),object:vi.fn(async(key,version)=>{
   const bytes=key===parameters.CodeKey?code:targetBytes;
   return {bytes:Buffer.from(bytes),metadata:{VersionId:version,ContentLength:bytes.length,ServerSideEncryption:'AES256',ContentType:key===parameters.CodeKey?'application/zip':'application/json'}};
  })};
 return {plan,port,sql,rawMetadata,identity,now};
}
it('observes prerequisites without asserting deployment, provider use or alarm delivery',async()=>{
 const {plan,port}=fixture();const result=await observeFullscriptDeploymentResources(plan,port);
 expect(result).toMatchObject({resourcePrerequisitesObserved:true,deployed:false,providerCredentialRead:false,providerActionPerformed:false,alarmDeliveryProven:false,hostedQualified:false,phiAllowed:false});
 expect(JSON.stringify(result)).not.toContain('fictional-db');expect(vi.mocked(port.metadata).mock.calls.some(([,a])=>a==='get-secret-value')).toBe(false);
});
it.each(['superuser','createRole','createDatabase','replication','bypassRls'])('refuses reachable login privilege %s',async flag=>{
 const {plan,port,sql}=fixture();(sql.reachableRoles as Obj[])[0][flag]=true;
 await expect(observeFullscriptDeploymentResources(plan,port)).rejects.toThrow(/^fullscript_deployment_resources_refused$/);
});
it.each(['wrong-db','wrong-login','missing-rollback','wrong-ledger','foreign-role','duplicate-role','delete','other-table','missing-grant','duplicate-grant','login-extra','worker-admin','login-create','worker-create'])('refuses SQL authority %s',async kind=>{
 const {plan,port,sql}=fixture();
 if(kind==='wrong-db')sql.databaseName='clinical_core';if(kind==='wrong-login')sql.loginName='postgres';
 if(kind==='missing-rollback')delete sql.rollbackConfirmed;if(kind==='wrong-ledger')sql.ledger=[];
 if(kind==='foreign-role')(sql.reachableRoles as Obj[]).push({name:'rds_superuser'});
 if(kind==='duplicate-role')(sql.reachableRoles as Obj[]).push((sql.reachableRoles as Obj[])[0]);
 if(kind==='delete')(sql.workerTablePrivileges as string[]).push('fullscript_delivery.draft_intents:DELETE');
 if(kind==='other-table')(sql.workerTablePrivileges as string[]).push('clinical_core.patients:SELECT');
 if(kind==='missing-grant')(sql.workerTablePrivileges as string[]).pop();
 if(kind==='duplicate-grant')(sql.workerTablePrivileges as string[]).push((sql.workerTablePrivileges as string[])[0]);
 if(kind==='login-extra')sql.loginTablePrivileges=['clinical_core.patients:SELECT'];
 if(kind==='worker-admin')(sql.workerRoles as Obj[])[0].superuser=true;
 if(kind==='login-create')sql.loginSchemaCreate=['public'];if(kind==='worker-create')sql.workerSchemaCreate=['fullscript_delivery'];
 await expect(observeFullscriptDeploymentResources(plan,port)).rejects.toThrow();
});
it.each(['api','cluster','duplicate-cluster','encrypted','secret-arn','secret-deleted','secret-region','provider-version','db-current','token-key','token-encryption','mfa','federation','custom-auth','device','user-disabled','user-org','user-duplicate','user-person','same-person','same-subject','topic','page'])('refuses resource drift %s',async kind=>{
 const {plan,port,rawMetadata}=fixture();
 if(kind==='same-subject')plan.target.target.workforceSubjects=['fictional-one'];
 vi.mocked(port.metadata).mockImplementation(async(s,a,i)=>{
  const r=await rawMetadata(s,a,i);
  if(kind==='api'&&a==='get-api')r.ApiEndpoint='https://wrong.test';
  if(kind==='cluster'&&s==='rds')(r.DBClusters as Obj[])[0].DBClusterArn='wrong';
  if(kind==='duplicate-cluster'&&s==='rds')(r.DBClusters as Obj[]).push((r.DBClusters as Obj[])[0]);
  if(kind==='encrypted'&&s==='rds')(r.DBClusters as Obj[])[0].StorageEncrypted=false;
  if(s==='secretsmanager'){
   if(kind==='secret-arn')r.ARN='wrong';if(kind==='secret-deleted')r.DeletedDate='2026-10-01';
   if(kind==='secret-region')r.PrimaryRegion='us-east-1';
   if(kind==='provider-version')r.VersionIdsToStages={};
   if(kind==='db-current')r.VersionIdsToStages={one:['AWSCURRENT'],two:['AWSCURRENT']};
  }
  if(kind==='token-key'&&s==='dynamodb')(r.Table as Obj).KeySchema=[];
  if(kind==='token-encryption'&&s==='dynamodb')(r.Table as Obj).SSEDescription={Status:'DISABLED',SSEType:'KMS'};
  if(a==='describe-user-pool'&&String(i.UserPoolId).includes('Workforce')){
   if(kind==='mfa')(r.UserPool as Obj).MfaConfiguration='OFF';
   if(kind==='device')(r.UserPool as Obj).DeviceConfiguration={};
  }
  if(a==='describe-user-pool-client'){
   if(kind==='federation')(r.UserPoolClient as Obj).SupportedIdentityProviders=['COGNITO','Google'];
   if(kind==='custom-auth')(r.UserPoolClient as Obj).ExplicitAuthFlows=['ALLOW_CUSTOM_AUTH'];
  }
  if(a==='admin-get-user'){
   if(kind==='user-disabled')r.Enabled=false;
   const attrs=r.UserAttributes as {Name:string;Value:string}[];
   if(kind==='user-org')attrs.find(x=>x.Name==='custom:organization_id')!.Value='wrong';
   if(kind==='user-duplicate')attrs.push(attrs[0]);
   if(kind==='user-person')attrs.find(x=>x.Name==='custom:person_id')!.Value='------------------------------------';
   if(kind==='same-person')attrs.find(x=>x.Name==='custom:person_id')!.Value='11111111-1111-4111-8111-111111111111';
  }
  if(kind==='topic'&&s==='sns')(r.Attributes as Obj).Owner='173535830222';
  if(kind==='page'&&a==='get-routes')r.NextToken='unfinished';
  return r;
 });
 await expect(observeFullscriptDeploymentResources(plan,port)).rejects.toThrow();
});
it('treats DynamoDB key metadata as unordered rows, not a new schema when rows reorder',async()=>{
 const {plan,port,rawMetadata}=fixture();vi.mocked(port.metadata).mockImplementation(async(s,a,i)=>{
  const r=await rawMetadata(s,a,i);if(s==='dynamodb'){const t=r.Table as Obj;(t.KeySchema as Obj[]).reverse();(t.AttributeDefinitions as Obj[]).reverse();}return r;
 });expect(await observeFullscriptDeploymentResources(plan,port)).toMatchObject({resourcePrerequisitesObserved:true});
});
it.each(['hash','version','length','type','encoding','range','deleted','large'])('refuses immutable object mismatch %s',async kind=>{
 const {plan,port}=fixture(),original=port.object;
 port.object=vi.fn(async(k,v,m)=>{const r=await original(k,v,m);
  if(kind==='hash')r.bytes=Buffer.from('changed');if(kind==='version')r.metadata.VersionId='wrong';
  if(kind==='length')r.metadata.ContentLength=0;if(kind==='type')r.metadata.ContentType='text/plain';
  if(kind==='encoding')r.metadata.ContentEncoding='gzip';if(kind==='range')r.metadata.ContentRange='bytes 0-1/2';
  if(kind==='deleted')r.metadata.DeleteMarker=true;if(kind==='large')r.bytes=Buffer.alloc(m+1);
  return r;
 });await expect(observeFullscriptDeploymentResources(plan,port)).rejects.toThrow();
});
it.each(['changed','root','wrong-account'])('refuses current principal %s',async kind=>{
 const {plan,port,identity}=fixture();
 if(kind==='changed')vi.mocked(port.identity).mockResolvedValueOnce(identity).mockResolvedValueOnce({...identity,Arn:identity.Arn+'changed'});
 if(kind==='root')vi.mocked(port.identity).mockResolvedValue({...identity,Arn:'arn:aws:iam::588966314750:root'});
 if(kind==='wrong-account')vi.mocked(port.identity).mockResolvedValue({...identity,Account:'173535830222'});
 await expect(observeFullscriptDeploymentResources(plan,port)).rejects.toThrow();
});
it.each(['timeout','backwards','nan','opaque-error'])('bounds observations and hides failures: %s',async kind=>{
 const {plan,port,now}=fixture();
 if(kind==='opaque-error')vi.mocked(port.metadata).mockRejectedValue(Error('SECRET raw provider detail'));
 else {let calls=0;port.now=()=>++calls===1?now:kind==='timeout'?now+120001:kind==='backwards'?now-1:NaN;}
 await expect(observeFullscriptDeploymentResources(plan,port)).rejects.toThrow(/^fullscript_deployment_resources_refused$/);
});
