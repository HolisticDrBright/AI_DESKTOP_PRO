if(typeof window!=='undefined')throw Error('Fullscript provider credentials are server-only.');
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {z} from 'zod';
import {readFullscriptConfiguration} from './client';

const arn=z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/);
const version=z.string().regex(/^[A-Za-z0-9-]{32,64}$/);
const redirect=z.string().url().refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password
 &&!u.search&&!u.hash&&u.pathname==='/api/live/fullscript/oauth/callback';}catch{return false;}});
export const fullscriptCredentialTargetSchema=z.object({providerSecretArn:arn,providerSecretVersion:version,
 tokenTable:z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),redirectUri:redirect}).strict();
const opaque=z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/);
export const fullscriptSandboxCredentialSchema=z.object({contract:z.literal('fullscript-sandbox-credentials/1'),
 environment:z.literal('sandbox_us'),clientId:opaque,clientSecret:opaque,
 stateSecret:z.string().min(32).max(512),redirectUri:redirect}).strict();
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const refuse=():never=>{throw Error('fullscript_credentials_refused');};
type Store={send(command:GetSecretValueCommand,options:{abortSignal:AbortSignal}):Promise<Record<string,unknown>>};

/** A fresh, request-scoped environment, never a process.env mutation or cached
 * secret. Invoke only from admitted workforce provider actions after native
 * identity/target/SQL checks. This does not install or authorize an OAuth app. */
export async function loadFullscriptQualificationProviderEnvironment(input:{env:NodeJS.ProcessEnv;store:Store;timeoutMs?:number}):Promise<NodeJS.ProcessEnv>{
 const env={...input.env};
 if(env.AWS_REGION!=='us-east-2'||env.PHI_ALLOWED!=='false'||env.PRODUCTION_ACTIVATION!=='blocked'
  ||env.QUALIFICATION_EXECUTION!=='true'||env.QUALIFICATION_ACCOUNT_ID!=='588966314750')return refuse();
 const parsed=fullscriptCredentialTargetSchema.safeParse({providerSecretArn:env.FULLSCRIPT_PROVIDER_SECRET_ARN,
  providerSecretVersion:env.FULLSCRIPT_PROVIDER_SECRET_VERSION,tokenTable:env.FULLSCRIPT_TOKEN_TABLE,redirectUri:env.FULLSCRIPT_REDIRECT_URI});
 if(!parsed.success)return refuse();
 const target=parsed.data;
 const timeout=input.timeoutMs??5000;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>5000)return refuse();
 const controller=new AbortController(),endsAt=Date.now()+timeout;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('fullscript_credentials_refused'));},timeout);});
 try{
  const result=await Promise.race([input.store.send(new GetSecretValueCommand({SecretId:target.providerSecretArn,
   VersionId:target.providerSecretVersion}),{abortSignal:controller.signal}),deadline]);
  if(controller.signal.aborted||Date.now()>endsAt||result.ARN!==target.providerSecretArn||result.VersionId!==target.providerSecretVersion
   ||(result.$metadata as {httpStatusCode?:unknown}|undefined)?.httpStatusCode!==200||result.SecretBinary!==undefined
   ||typeof result.SecretString!=='string'||Buffer.byteLength(result.SecretString,'utf8')>8192)return refuse();
  const raw:unknown=JSON.parse(result.SecretString);
  // Canonical bytes also reject duplicate keys and ignored/trailing content.
  if(result.SecretString!==canonical(raw)+'\n')return refuse();
  const secret=fullscriptSandboxCredentialSchema.parse(raw);
  if(secret.redirectUri!==target.redirectUri)return refuse();
  const scoped:NodeJS.ProcessEnv={NODE_ENV:'production',AWS_REGION:'us-east-2',PHI_ALLOWED:'false',FULLSCRIPT_ENVIRONMENT:'sandbox_us',
   FULLSCRIPT_CLIENT_ID:secret.clientId,FULLSCRIPT_CLIENT_SECRET:secret.clientSecret,FULLSCRIPT_OAUTH_STATE_SECRET:secret.stateSecret,
   FULLSCRIPT_REDIRECT_URI:secret.redirectUri,FULLSCRIPT_TOKEN_TABLE:target.tokenTable};
  readFullscriptConfiguration(scoped);
  if(controller.signal.aborted||Date.now()>endsAt)return refuse();
  return scoped;
 }catch{controller.abort();return refuse();}finally{if(timer)clearTimeout(timer);}
}

/** Construction is inert. The secret is read only when delivery's workforce
 * provider invokes the returned loader; consumer read/cancel/export do not. */
export function nativeFullscriptProviderEnvironmentLoader(env:NodeJS.ProcessEnv){
 const snapshot={...env};
 return ()=>loadFullscriptQualificationProviderEnvironment({env:snapshot,store:{send:async(command,options)=>{
  const client=new SecretsManagerClient({region:'us-east-2',endpoint:'https://secretsmanager.us-east-2.amazonaws.com',maxAttempts:1});
  return {...await client.send(command,options)};
 }}});
}
