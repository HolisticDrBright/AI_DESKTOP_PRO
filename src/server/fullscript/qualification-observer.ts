if(typeof window!=='undefined')throw new Error('Fullscript qualification observer is server-only.');
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {LambdaClient,GetFunctionConfigurationCommand} from '@aws-sdk/client-lambda';
import {ApiGatewayV2Client,GetRouteCommand,GetAuthorizerCommand,GetIntegrationCommand} from '@aws-sdk/client-apigatewayv2';
import {CognitoIdentityProviderClient,DescribeUserPoolCommand,DescribeUserPoolClientCommand,AdminGetUserCommand} from '@aws-sdk/client-cognito-identity-provider';
import {CognitoJwtVerifier} from 'aws-jwt-verify';
import type {ClinicalCoreDatabase} from '../clinical-core/database';
import {createRdsDataFullscriptDraftDatabase} from '../clinical-core/rds-data-database';
import {createCanonicalFullscriptDelivery} from './canonical-delivery-runtime';
import {createQualificationFullscriptApi,fullscriptSupportedQualificationTargetSchema,FullscriptQualificationReauth,type FullscriptQualificationEvent,
 type FullscriptLambdaContext,type FullscriptRequestIdentity} from './qualification-api';

interface Commands{send(command:unknown):Promise<Record<string,unknown>>}
type Clients={sts:Commands;lambda:Commands;gateway:Commands;cognito:Commands};
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('refused');return v as Record<string,unknown>;};
const strings=(v:unknown):string[]=>{if(!Array.isArray(v)||!v.every(n=>typeof n==='string'))throw new Error('refused');return v;};
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const requireTrue=(value:unknown)=>{if(!value)throw new Error('fullscript_target_refused');};
const requireIdentity=(value:unknown)=>{if(!value)throw new FullscriptQualificationReauth();};
const modified=(value:unknown):number=>{const n=value instanceof Date?value.getTime():NaN;requireTrue(Number.isFinite(n));return n;};

/** Observe each request, with no cache, boolean environment substitute, caller
 * credential, or migration/admin-role fallback. Injectable command transports
 * exist for fictional tests; native wiring below always creates AWS clients.
 * The supplied target is a separately reviewed SERVER artifact, not evidence
 * that it is deployed. All checks must actually succeed before it serves. */
export function createFullscriptQualificationObserver(input:{target:unknown;database:ClinicalCoreDatabase;clients?:Clients;
 jwt?:{verify(token:string):Promise<unknown>}}){
 const c=fullscriptSupportedQualificationTargetSchema.parse(structuredClone(input.target));
 const verifier=input.jwt??CognitoJwtVerifier.create([
  {userPoolId:c.workforceIssuer.split('/').at(-1)!,tokenUse:'id',clientId:c.workforceAudience},
  {userPoolId:c.consumerIssuer.split('/').at(-1)!,tokenUse:'id',clientId:c.consumerAudience},
 ]);
 const clients=input.clients??{sts:new STSClient({region:c.region,maxAttempts:1}),lambda:new LambdaClient({region:c.region,maxAttempts:1}),
  gateway:new ApiGatewayV2Client({region:c.region,maxAttempts:1}),cognito:new CognitoIdentityProviderClient({region:c.region,maxAttempts:1})};
 return async(event:FullscriptQualificationEvent,context:FullscriptLambdaContext,who:FullscriptRequestIdentity)=>{
  requireTrue(event.requestContext?.apiId===c.apiId&&typeof event.requestContext.routeId==='string'
   &&/^[a-z0-9]+$/.test(event.requestContext.routeId)&&context.invokedFunctionArn===c.functionArn
   &&context.functionVersion===c.functionArn.split(':').at(-1));
  // Defense in depth against a fabricated direct Lambda event. Never decode an
  // unverified token or accept event claims alone as signature proof. The native
  // AWS verifier pins both Cognito issuers/clients and uses their public JWKS.
  try{
   const headers=Object.entries(event.headers??{}).filter(([key])=>key.toLowerCase()==='authorization');
   requireIdentity(headers.length===1&&typeof headers[0][1]==='string'&&headers[0][1].length<=16384);
   const bearer=headers[0][1]!.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
   requireIdentity(bearer);
   const verified=object(await verifier.verify(bearer![1]));
   const keys=['iss','aud','token_use','sub','email','email_verified','custom:person_id','custom:organization_id','custom:production_bound'];
   requireIdentity(keys.every(key=>String(verified[key])===String(who.claims[key]))
    &&['exp','iat','auth_time'].every(key=>Number(verified[key])===Number(who.claims[key]))
    &&verified['custom:synthetic_attested']!==true&&verified['custom:synthetic_attested']!=='true');
  }catch{throw new FullscriptQualificationReauth();}
  const identity=await clients.sts.send(new GetCallerIdentityCommand({}));
  requireTrue(identity.Account===c.account&&typeof identity.Arn==='string'
   &&identity.Arn.startsWith('arn:aws:sts::'+c.account+':assumed-role/'));
  const fn=await clients.lambda.send(new GetFunctionConfigurationCommand({FunctionName:c.functionArn}));
  requireTrue(fn.FunctionArn===c.functionArn&&fn.Version===context.functionVersion&&fn.CodeSha256===c.codeSha256
   &&fn.State==='Active'&&fn.LastUpdateStatus==='Successful');
  const env=object(object(fn.Environment).Variables);
  const required={PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',
   QUALIFICATION_ACCOUNT_ID:c.account,QUALIFICATION_REVIEW_SHA256:c.reviewSha256,
   CLINICAL_DATABASE_NAME:c.databaseName,CLINICAL_DATABASE_CLUSTER_ARN:c.clusterArn,CLINICAL_DATABASE_SECRET_ARN:c.secretArn,
   FULLSCRIPT_SOURCE_COMMIT:c.sourceCommit};
  requireTrue(Object.entries(required).every(([key,value])=>env[key]===value));
  const route=await clients.gateway.send(new GetRouteCommand({ApiId:c.apiId,RouteId:event.requestContext!.routeId!}));
  requireTrue(route.RouteKey===event.routeKey&&route.AuthorizationType==='JWT'&&typeof route.AuthorizerId==='string'
   &&typeof route.Target==='string'&&/^integrations\/[a-z0-9]+$/.test(route.Target));
  const authorizer=await clients.gateway.send(new GetAuthorizerCommand({ApiId:c.apiId,AuthorizerId:route.AuthorizerId as string}));
  const jwt=object(authorizer.JwtConfiguration),workforce=who.actor.identityPool==='workforce';
  const issuer=workforce?c.workforceIssuer:c.consumerIssuer,audience=workforce?c.workforceAudience:c.consumerAudience;
  requireTrue(authorizer.AuthorizerType==='JWT'&&canonical(authorizer.IdentitySource)===canonical(['$request.header.Authorization'])
   &&jwt.Issuer===issuer&&canonical(jwt.Audience)===canonical([audience]));
  const integration=await clients.gateway.send(new GetIntegrationCommand({ApiId:c.apiId,IntegrationId:(route.Target as string).slice('integrations/'.length)}));
  requireTrue(integration.IntegrationType==='AWS_PROXY'&&integration.PayloadFormatVersion==='2.0'&&integration.IntegrationUri===c.functionArn);
  const poolId=issuer.split('/').at(-1)!;
  const pool=object((await clients.cognito.send(new DescribeUserPoolCommand({UserPoolId:poolId}))).UserPool);
  // Cognito's deprecated pool Status is omitted by the live synthetic pool.
  // Existence/ID/account binding and the CURRENT USER's Enabled flag are the
  // authorities. Refuse an explicit disabled/unknown status, not absence.
  requireTrue(pool.Id===poolId&&pool.Arn===`arn:aws:cognito-idp:${c.region}:${c.account}:userpool/${poolId}`
   &&(pool.Status===undefined||pool.Status==='Enabled'));
  const app=object((await clients.cognito.send(new DescribeUserPoolClientCommand({UserPoolId:poolId,ClientId:audience}))).UserPoolClient);
  requireTrue(app.UserPoolId===poolId&&app.ClientId===audience);
  const user=await clients.cognito.send(new AdminGetUserCommand({UserPoolId:poolId,Username:who.actor.identitySubject}));
  requireIdentity(user.Enabled===true&&user.UserStatus==='CONFIRMED');
  const attributes=new Map<string,string>();
  requireTrue(Array.isArray(user.UserAttributes));
  for(const raw of user.UserAttributes as unknown[]){const a=object(raw);requireTrue(typeof a.Name==='string'&&typeof a.Value==='string'&&!attributes.has(a.Name as string));attributes.set(a.Name as string,a.Value as string);}
  requireIdentity(attributes.get('sub')===who.actor.identitySubject&&attributes.get('custom:person_id')===who.actor.personId
   &&attributes.get('custom:organization_id')===c.organizationId&&attributes.get('email')===who.claims.email
   &&attributes.get('email_verified')==='true'&&attributes.get('custom:production_bound')==='true'
   &&attributes.get('custom:synthetic_attested')!=='true');
  const signedAt=Number(who.claims.auth_time)*1000;
  requireIdentity(signedAt>=Math.ceil(modified(user.UserLastModifiedDate)/1000)*1000);
  if(workforce){
   // Current MFA registration alone does not prove a recent MFA sign-in. Pin a
   // required-MFA local-password pool, no remembered-device bypass/federation/
   // custom/passwordless flows, and auth_time AFTER current policy/user changes.
   const flows=strings(app.ExplicitAuthFlows),factors=strings(user.UserMFASettingList);
   requireTrue(pool.MfaConfiguration==='ON'&&pool.DeviceConfiguration===undefined
    &&canonical(app.SupportedIdentityProviders)===canonical(['COGNITO'])&&!attributes.has('identities')
    &&flows.length>0&&new Set(flows).size===flows.length
    &&flows.some(f=>['ALLOW_USER_PASSWORD_AUTH','ALLOW_USER_SRP_AUTH','ALLOW_ADMIN_USER_PASSWORD_AUTH'].includes(f))
    &&flows.every(f=>['ALLOW_USER_PASSWORD_AUTH','ALLOW_USER_SRP_AUTH','ALLOW_ADMIN_USER_PASSWORD_AUTH','ALLOW_REFRESH_TOKEN_AUTH'].includes(f))
    &&factors.includes('SOFTWARE_TOKEN_MFA')&&user.PreferredMfaSetting==='SOFTWARE_TOKEN_MFA');
   requireIdentity(signedAt>=Math.ceil(modified(pool.LastModifiedDate)/1000)*1000
    &&signedAt>=Math.ceil(modified(app.LastModifiedDate)/1000)*1000);
  }
  // This is the SAME role-restricted database object used by delivery, not an
  // administrative observer on an unrelated connection. Wrong DB/role, missing
  // or altered ledger, and extra migrations all refuse before construction.
  await input.database.transaction(async tx=>{
   const observed=(await tx.query<{database_name:string;role_name:string}>('select current_database() as database_name,current_user as role_name')).rows;
   requireTrue(observed.length===1&&observed[0].database_name===c.databaseName&&observed[0].role_name==='fullscript_draft_worker');
   const receipt=(await tx.query<{ledger:unknown}>('select fullscript_delivery.migration_ledger() as ledger')).rows;
   requireTrue(receipt.length===1);
   const rows=typeof receipt[0].ledger==='string'?JSON.parse(receipt[0].ledger):receipt[0].ledger;
   requireTrue(canonical(rows)===canonical(c.migrations));
  });
 };
}

/** Source-only entry point for the separately built candidate. Published numeric
 * versions only; no $LATEST/alias and no active production mode. No existing
 * HTTP stack installs it and no reviewed target is fabricated by this module. */
export function createNativeFullscriptQualificationApi(rawTarget:unknown,providerEnvironment?:()=>Promise<NodeJS.ProcessEnv>){
 const target=fullscriptSupportedQualificationTargetSchema.parse(structuredClone(rawTarget));
 const database=createRdsDataFullscriptDraftDatabase(target);
 const observe=createFullscriptQualificationObserver({target,database});
 return createQualificationFullscriptApi({target,observe,operations:who=>createCanonicalFullscriptDelivery({database,
  configuration:{execution:'qualification',account:target.account,phiAllowed:false},actor:who.actor,session:who.session,providerEnvironment})});
}
