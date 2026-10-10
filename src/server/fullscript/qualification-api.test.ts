import {beforeEach,describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {CognitoJwtVerifier} from 'aws-jwt-verify';
import {createQualificationFullscriptApi,fullscriptQualificationTargetSchema,FULLSCRIPT_QUALIFICATION_ROUTES,FullscriptQualificationReauth,
 type FullscriptQualificationTarget,type FullscriptQualificationEvent,type FullscriptRequestIdentity} from './qualification-api';
import {createFullscriptQualificationObserver} from './qualification-observer';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from '../clinical-core/database';
const now=Math.floor(Date.now()/1000)*1000,earlier=new Date(now-60_000);
const org='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const issuer='https://cognito-idp.us-east-2.amazonaws.com/';
const target:FullscriptQualificationTarget={execution:'qualification',account:'588966314750',region:'us-east-2',phiAllowed:false,activation:'blocked',
 reviewSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40),apiId:'a123456789',functionArn:'arn:aws:lambda:us-east-2:588966314750:function:fictional-fullscript:1',
 codeSha256:Buffer.alloc(32,3).toString('base64'),clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-db',
 databaseName:'clinical_core_qualification',organizationId:org,consumerIssuer:issuer+'us-east-2_FictionalConsumer',consumerAudience:'c'.repeat(26),
 workforceIssuer:issuer+'us-east-2_FictionalWorkforce',workforceAudience:'w'.repeat(26),consumerSubjects:['fictional-consumer','fictional-consumer-2'],workforceSubjects:['fictional-workforce'],
 migrations:Array.from({length:110},(_,i)=>({version:String(20260000000000+i),name:i<107?'FICTIONAL_'+i:
  ['production_fullscript_draft_ledger','production_canonical_protocol_carts','production_fullscript_canonical_authority'][i-107],sha256:'d'.repeat(64)}))};
const context={invokedFunctionArn:target.functionArn,functionVersion:'1'};
function event(workforce=true,request:unknown={action:'read',id}):FullscriptQualificationEvent{return {
 routeKey:workforce?FULLSCRIPT_QUALIFICATION_ROUTES.workforce:FULLSCRIPT_QUALIFICATION_ROUTES.consumer,
 headers:{'content-type':'application/json',authorization:'Bearer FICTIONAL_NOT_A_TOKEN'},body:JSON.stringify(request),
 requestContext:{apiId:target.apiId,routeId:'fictionalroute',authorizer:{jwt:{claims:{iss:workforce?target.workforceIssuer:target.consumerIssuer,
  aud:workforce?target.workforceAudience:target.consumerAudience,token_use:'id',sub:workforce?'fictional-workforce':'fictional-consumer',
  email:'fictional@example.invalid',email_verified:true,'custom:person_id':person,'custom:organization_id':org,'custom:production_bound':'true',
  exp:now/1000+300,iat:now/1000-10,auth_time:now/1000-10}}}}};}
const who=(workforce=true):FullscriptRequestIdentity=>({actor:{organizationId:org,personId:person,identitySubject:workforce?'fictional-workforce':'fictional-consumer',
 identityPool:workforce?'workforce':'consumer',environment:'synthetic-staging',phiAllowed:false},claims:event(workforce).requestContext!.authorizer!.jwt!.claims!});
const operations={prepare:vi.fn(),send:vi.fn(),read:vi.fn(),cancel:vi.fn(),reconcile:vi.fn(),exportForOwner:vi.fn()};
const observe=vi.fn(),construct=vi.fn<(identity:FullscriptRequestIdentity)=>typeof operations>(()=>operations);
const api=(c:unknown=target)=>createQualificationFullscriptApi({target:c,observe,operations:construct,now:()=>now});
beforeEach(()=>{vi.clearAllMocks();observe.mockResolvedValue(undefined);Object.values(operations).forEach(fn=>fn.mockResolvedValue({id,state:'prepared'}));});
describe('strict source-only qualification API',()=>{
 it.each(['prepare','send','read','cancel','reconcile','export'])('dispatches workforce %s only after observer',async action=>{
  observe.mockImplementation(async()=>{expect(construct).not.toHaveBeenCalled();});
  const request=action==='prepare'?{action,manifestId:id,patientRecordId:person}:{action,id};
  const result=await api()(event(true,request),context);expect(result.statusCode).toBe(200);
  expect(result.headers['x-clinical-execution']).toBe('qualification');expect(construct).toHaveBeenCalledTimes(1);
  const supplied=construct.mock.calls[0][0] as unknown as FullscriptRequestIdentity;
  expect(supplied.actor).toEqual(who().actor);expect(supplied.session).toMatchObject({email:'fictional@example.invalid',orgId:org,signedIn:true,token:null});
  expect(JSON.parse(result.body)).toMatchObject({phiAllowed:false,patientSent:false});
 });
 it.each(['read','cancel','export'])('consumer %s has no workforce credential session',async action=>{
  expect((await api()(event(false,{action,id}),context)).statusCode).toBe(200);
  expect(construct.mock.calls[0][0]).not.toHaveProperty('session');
 });
 it.each(['prepare','send','reconcile'])('consumer cannot %s',async action=>{
  const request=action==='prepare'?{action,manifestId:id,patientRecordId:person}:{action,id};
  expect((await api()(event(false,request),context)).statusCode).toBe(503);expect(observe).not.toHaveBeenCalled();expect(construct).not.toHaveBeenCalled();
 });
 it.each(['actor','review','provider','target','phiAllowed','organizationId','email'])('request cannot override %s',async key=>{
  expect((await api()(event(true,{action:'read',id,[key]:'malicious'}),context)).statusCode).toBe(400);expect(observe).not.toHaveBeenCalled();
 });
 it.each(['expired','stale-auth','unverified','wrong-pool','other-subject','other-org','no-claims','header-only'])('refuses %s before observations',async kind=>{
  const e=event(),claims=e.requestContext!.authorizer!.jwt!.claims!;
  if(kind==='expired')claims.exp=now/1000;
  if(kind==='stale-auth')claims.auth_time=now/1000-901;
  if(kind==='unverified')claims.email_verified=false;
  if(kind==='wrong-pool')claims.iss=target.consumerIssuer;
  if(kind==='other-subject')claims.sub='fictional-other';
  if(kind==='other-org')claims['custom:organization_id']=id;
  if(kind==='no-claims'||kind==='header-only')delete e.requestContext!.authorizer;
  expect((await api()(e,context)).statusCode).toBe(401);expect(observe).not.toHaveBeenCalled();expect(construct).not.toHaveBeenCalled();
 });
 it.each(['query','content-type','oversized','invalid-json','invalid-utf8','invalid-base64'])('refuses %s bodies',async kind=>{
  const e=event();if(kind==='query')e.queryStringParameters={action:'send'};
  if(kind==='content-type')e.headers!['content-type']='text/plain';
  if(kind==='oversized')e.body=' '.repeat(4097);
  if(kind==='invalid-json')e.body='{';
  if(kind==='invalid-utf8'){e.body=Buffer.from([0xff]).toString('base64');e.isBase64Encoded=true;}
  if(kind==='invalid-base64'){e.body=Buffer.from(e.body!).toString('base64')+'\n';e.isBase64Encoded=true;}
  expect((await api()(e,context)).statusCode).toBe(400);expect(observe).not.toHaveBeenCalled();
 });
 it('opaque target refusal prevents every delivery/provider construction',async()=>{
  observe.mockRejectedValue(new Error('secret token fictional clinical payload'));
  const r=await api()(event(),context);expect(r.statusCode).toBe(503);expect(r.body).not.toContain('secret');expect(construct).not.toHaveBeenCalled();
 });
 it('observed identity loss returns reauthentication, not an endless temporary-service retry',async()=>{
  observe.mockRejectedValue(new FullscriptQualificationReauth());const r=await api()(event(),context);
  expect(r.statusCode).toBe(401);expect(JSON.parse(r.body).error).toBe('reauth_required');expect(construct).not.toHaveBeenCalled();
 });
 it.each([{phiAllowed:true},{activation:'approved'},{account:'173535830222'},{databaseName:'clinical_core'},{functionArn:target.functionArn.replace(':1',':$LATEST')},
  {consumerSubjects:['fictional-workforce','fictional-consumer']},{migrations:[...target.migrations,target.migrations[0]]},
  {migrations:target.migrations.slice(0,107)}])('rejects configuration %j',patch=>{
  expect(()=>api({...target,...patch})).toThrow();
 });
});

function transports(workforce=true){
 const calls:string[]=[],claims=who(workforce).claims,poolId=(workforce?target.workforceIssuer:target.consumerIssuer).split('/').at(-1)!;
 const replies:Record<string,Record<string,unknown>>={GetCallerIdentityCommand:{Account:target.account,Arn:'arn:aws:sts::588966314750:assumed-role/fictional/session'},
  GetFunctionConfigurationCommand:{FunctionArn:target.functionArn,Version:'1',CodeSha256:target.codeSha256,State:'Active',LastUpdateStatus:'Successful',Environment:{Variables:{
   PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',QUALIFICATION_ACCOUNT_ID:target.account,QUALIFICATION_REVIEW_SHA256:target.reviewSha256,
   CLINICAL_DATABASE_NAME:target.databaseName,CLINICAL_DATABASE_CLUSTER_ARN:target.clusterArn,CLINICAL_DATABASE_SECRET_ARN:target.secretArn,FULLSCRIPT_SOURCE_COMMIT:target.sourceCommit}}},
  GetRouteCommand:{RouteKey:event(workforce).routeKey,AuthorizationType:'JWT',AuthorizerId:'fictionalauth',Target:'integrations/fictionalintegration'},
  GetAuthorizerCommand:{AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],JwtConfiguration:{Issuer:claims.iss,Audience:[claims.aud]}},
  GetIntegrationCommand:{IntegrationType:'AWS_PROXY',PayloadFormatVersion:'2.0',IntegrationUri:target.functionArn},
  DescribeUserPoolCommand:{UserPool:{Id:poolId,Arn:`arn:aws:cognito-idp:us-east-2:588966314750:userpool/${poolId}`,MfaConfiguration:'ON',LastModifiedDate:earlier}},
  DescribeUserPoolClientCommand:{UserPoolClient:{UserPoolId:poolId,ClientId:claims.aud,SupportedIdentityProviders:['COGNITO'],ExplicitAuthFlows:['ALLOW_USER_SRP_AUTH','ALLOW_REFRESH_TOKEN_AUTH'],LastModifiedDate:earlier}},
  AdminGetUserCommand:{Enabled:true,UserStatus:'CONFIRMED',UserLastModifiedDate:earlier,PreferredMfaSetting:'SOFTWARE_TOKEN_MFA',UserMFASettingList:['SOFTWARE_TOKEN_MFA'],
   UserAttributes:Object.entries({sub:claims.sub,'custom:person_id':person,'custom:organization_id':org,email:claims.email,email_verified:'true','custom:production_bound':'true'}).map(([Name,Value])=>({Name,Value}))},
 };
 const send=vi.fn(async(command:unknown)=>{const cmd=command as {constructor:{name:string};input:Record<string,unknown>};calls.push(cmd.constructor.name);return structuredClone(replies[cmd.constructor.name]);});
 let observedDatabase:{database_name:string;role_name:string}={database_name:target.databaseName,role_name:'fullscript_draft_worker'},rows=structuredClone(target.migrations);
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('current_database')?[observedDatabase]:[{ledger:rows}]})) as unknown as ClinicalCoreTransaction['query'];
 const database:ClinicalCoreDatabase={transaction:async work=>work({query})};
 const jwt=CognitoJwtVerifier.create([{userPoolId:'us-east-2_FictionalWorkforce',tokenUse:'id',clientId:target.workforceAudience},
  {userPoolId:'us-east-2_FictionalConsumer',tokenUse:'id',clientId:target.consumerAudience}]);
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const exported=publicKey.export({format:'jwk'});
 const jwks={keys:[{kty:'RSA',n:exported.n!,e:exported.e!,kid:'FICTIONAL_KEY',alg:'RS256',use:'sig'}]};
 jwt.cacheJwks(jwks,'us-east-2_FictionalWorkforce');jwt.cacheJwks(jwks,'us-east-2_FictionalConsumer');
 const signedEvent=(e=event(workforce),extra:Record<string,unknown>={}):FullscriptQualificationEvent=>{
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const content=encode({kid:'FICTIONAL_KEY',alg:'RS256',typ:'JWT'})+'.'+encode({...e.requestContext!.authorizer!.jwt!.claims,...extra});
  return {...e,headers:{...e.headers,authorization:'Bearer '+content+'.'+sign('RSA-SHA256',Buffer.from(content),privateKey).toString('base64url')}};
 };
 const observer=createFullscriptQualificationObserver({target,database,jwt,clients:{sts:{send},lambda:{send},gateway:{send},cognito:{send}}});
 // The transport wrapper uses a real locally signed token and the real AWS
 // verifier with fictional cached JWKS. No signature-accepting mock is used.
 const observed=(e:FullscriptQualificationEvent,ctx:typeof context,w:FullscriptRequestIdentity)=>observer(signedEvent(e),ctx,w);
 return {observer:observed,rawObserver:observer,signedEvent,replies,send,calls,query,setDatabase:(v:typeof observedDatabase)=>{observedDatabase=v;},setLedger:(v:typeof rows)=>{rows=v;}};
}
describe('native target and identity observations with fictional AWS transports',()=>{
 it('observes real command shapes and exact same worker ledger',async()=>{
  const t=transports();await t.observer(event(),context,who());
  expect(t.calls).toEqual(['GetCallerIdentityCommand','GetFunctionConfigurationCommand','GetRouteCommand','GetAuthorizerCommand','GetIntegrationCommand','DescribeUserPoolCommand','DescribeUserPoolClientCommand','AdminGetUserCommand']);
  expect(t.send.mock.calls[1][0]).toMatchObject({input:{FunctionName:target.functionArn}});
  expect(t.send.mock.calls.at(-1)![0]).toMatchObject({input:{UserPoolId:'us-east-2_FictionalWorkforce',Username:'fictional-workforce'}});
  expect(t.query).toHaveBeenCalledTimes(2);
 });
 it('checks current consumer user but never requires workforce MFA or a provider credential',async()=>{
  const t=transports(false);delete (t.replies.DescribeUserPoolCommand.UserPool as Record<string,unknown>).MfaConfiguration;
  delete t.replies.AdminGetUserCommand.UserMFASettingList;await t.observer(event(false),context,who(false));
  expect(t.calls).not.toContain('GetSecretValueCommand');
 });
 it('allows the observed required-MFA server password flow, not custom auth',async()=>{
  const t=transports();(t.replies.DescribeUserPoolClientCommand.UserPoolClient as Record<string,unknown>).ExplicitAuthFlows=
   ['ALLOW_ADMIN_USER_PASSWORD_AUTH','ALLOW_REFRESH_TOKEN_AUTH','ALLOW_USER_PASSWORD_AUTH','ALLOW_USER_SRP_AUTH'];
  await t.observer(event(),context,who());expect(t.query).toHaveBeenCalledTimes(2);
 });
 const cases:Array<[string,(t:ReturnType<typeof transports>)=>void]>=[
  ['account',t=>{t.replies.GetCallerIdentityCommand.Account='173535830222';}],
  ['root',t=>{t.replies.GetCallerIdentityCommand.Arn='arn:aws:iam::588966314750:root';}],
  ['artifact',t=>{t.replies.GetFunctionConfigurationCommand.CodeSha256='e'.repeat(43)+'=';}],
  ['unfinished function',t=>{t.replies.GetFunctionConfigurationCommand.LastUpdateStatus='InProgress';}],
  ['wrong database env',t=>{(t.replies.GetFunctionConfigurationCommand.Environment as {Variables:Record<string,unknown>}).Variables.CLINICAL_DATABASE_NAME='clinical_core';}],
  ['no JWT',t=>{t.replies.GetRouteCommand.AuthorizationType='NONE';}],
  ['wrong route',t=>{t.replies.GetRouteCommand.RouteKey=FULLSCRIPT_QUALIFICATION_ROUTES.consumer;}],
  ['wrong issuer',t=>{(t.replies.GetAuthorizerCommand.JwtConfiguration as Record<string,unknown>).Issuer=target.consumerIssuer;}],
  ['extra audience',t=>{(t.replies.GetAuthorizerCommand.JwtConfiguration as Record<string,unknown>).Audience=[target.workforceAudience,target.consumerAudience];}],
  ['other integration',t=>{t.replies.GetIntegrationCommand.IntegrationUri=target.functionArn.replace(':1',':2');}],
  ['wrong pool account',t=>{(t.replies.DescribeUserPoolCommand.UserPool as Record<string,unknown>).Arn='arn:aws:cognito-idp:us-east-2:173535830222:userpool/us-east-2_FictionalWorkforce';}],
  ['explicit disabled pool',t=>{(t.replies.DescribeUserPoolCommand.UserPool as Record<string,unknown>).Status='Disabled';}],
  ['optional MFA',t=>{(t.replies.DescribeUserPoolCommand.UserPool as Record<string,unknown>).MfaConfiguration='OPTIONAL';}],
  ['remembered device bypass',t=>{(t.replies.DescribeUserPoolCommand.UserPool as Record<string,unknown>).DeviceConfiguration={ChallengeRequiredOnNewDevice:true};}],
  ['policy after sign-in',t=>{(t.replies.DescribeUserPoolCommand.UserPool as Record<string,unknown>).LastModifiedDate=new Date(now);}],
  ['custom auth',t=>{(t.replies.DescribeUserPoolClientCommand.UserPoolClient as Record<string,unknown>).ExplicitAuthFlows=['ALLOW_CUSTOM_AUTH','ALLOW_USER_SRP_AUTH'];}],
  ['federation',t=>{(t.replies.DescribeUserPoolClientCommand.UserPoolClient as Record<string,unknown>).SupportedIdentityProviders=['COGNITO','Google'];}],
  ['app after sign-in',t=>{(t.replies.DescribeUserPoolClientCommand.UserPoolClient as Record<string,unknown>).LastModifiedDate=new Date(now);}],
  ['disabled user',t=>{t.replies.AdminGetUserCommand.Enabled=false;}],
  ['user changed since sign-in',t=>{t.replies.AdminGetUserCommand.UserLastModifiedDate=new Date(now);}],
  ['no TOTP',t=>{t.replies.AdminGetUserCommand.UserMFASettingList=['SMS_MFA'];}],
  ['external user',t=>{t.replies.AdminGetUserCommand.UserStatus='EXTERNAL_PROVIDER';}],
  ['changed subject',t=>{(t.replies.AdminGetUserCommand.UserAttributes as Array<{Name:string;Value:unknown}>)[0].Value='fictional-other';}],
  ['actual staging database',t=>{t.setDatabase({database_name:'clinical_core_staging',role_name:'fullscript_draft_worker'});}],
  ['admin role',t=>{t.setDatabase({database_name:target.databaseName,role_name:'postgres'});}],
  ['missing ledger',t=>{t.setLedger(target.migrations.slice(0,-1));}],
  ['renamed ledger',t=>{t.setLedger(target.migrations.map((m,i)=>i===0?{...m,name:'changed'}:m));}],
  ['changed ledger digest',t=>{t.setLedger(target.migrations.map((m,i)=>i===0?{...m,sha256:'e'.repeat(64)}:m));}],
  ['extra ledger',t=>{t.setLedger([...target.migrations,{version:'20269999999999',name:'extra',sha256:'e'.repeat(64)}]);}],
 ];
 it.each(cases)('refuses %s',async(_name,alter)=>{const t=transports();alter(t);await expect(t.observer(event(),context,who())).rejects.toThrow();});
 it.each(['api','version','function'])('refuses runtime %s before any command',async kind=>{
  const t=transports(),e=event(),ctx={...context};if(kind==='api')e.requestContext!.apiId='wrong';
  if(kind==='version')ctx.functionVersion='$LATEST';if(kind==='function')ctx.invokedFunctionArn=target.functionArn.replace(':1',':2');
  await expect(t.observer(e,ctx,who())).rejects.toThrow();expect(t.send).not.toHaveBeenCalled();
 });
 it('does not cache a formerly valid account',async()=>{
  const t=transports();await t.observer(event(),context,who());t.replies.GetCallerIdentityCommand.Account='173535830222';
  await expect(t.observer(event(),context,who())).rejects.toThrow();expect(t.send).toHaveBeenCalledTimes(9);
 });
 it('the fixture target is strict, not a deployable review',()=>expect(fullscriptQualificationTargetSchema.parse(target)).toEqual(target));
 it.each(['unsigned','bad-signature','changed-subject','wrong-pool','expired','duplicate-header'])('direct event with %s refuses before AWS',async kind=>{
  const t=transports();let e=t.signedEvent();
  if(kind==='unsigned')e.headers!.authorization='Bearer e30.e30.e30';
  if(kind==='bad-signature'){const parts=e.headers!.authorization!.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);e.headers!.authorization=parts.join('.');}
  if(kind==='changed-subject')e=t.signedEvent(event(),{sub:'fictional-other'});
  if(kind==='wrong-pool')e=t.signedEvent(event(),{iss:target.consumerIssuer});
  if(kind==='expired')e=t.signedEvent(event(),{exp:now/1000-1});
  if(kind==='duplicate-header')e.headers!.Authorization=e.headers!.authorization;
  await expect(t.rawObserver(e,context,who())).rejects.toThrow();expect(t.send).not.toHaveBeenCalled();
 });
});
