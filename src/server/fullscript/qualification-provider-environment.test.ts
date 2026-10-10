import {afterEach,describe,expect,it,vi} from 'vitest';
import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import type {GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {loadFullscriptQualificationProviderEnvironment,nativeFullscriptProviderEnvironmentLoader} from './qualification-provider-environment';
const canonical=(v:unknown):string=>v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
function setup(){
 const secret={contract:'fullscript-sandbox-credentials/1',environment:'sandbox_us',clientId:'FICTIONAL-client-1234567890',
  clientSecret:'FICTIONAL-secret-1234567890',stateSecret:'FICTIONAL-state-secret-longer-than-thirty-two',
  redirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback'};
 const env:NodeJS.ProcessEnv={NODE_ENV:'test',AWS_REGION:'us-east-2',PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',
  QUALIFICATION_ACCOUNT_ID:'588966314750',FULLSCRIPT_PROVIDER_SECRET_ARN:'arn:aws:secretsmanager:us-east-2:588966314750:secret:FICTIONAL-fullscript',
  FULLSCRIPT_PROVIDER_SECRET_VERSION:'f'.repeat(32),FULLSCRIPT_TOKEN_TABLE:'FICTIONAL-token-table',FULLSCRIPT_REDIRECT_URI:secret.redirectUri};
 const object:Record<string,unknown>={ARN:env.FULLSCRIPT_PROVIDER_SECRET_ARN,VersionId:env.FULLSCRIPT_PROVIDER_SECRET_VERSION,
  SecretString:canonical(secret)+'\n',$metadata:{httpStatusCode:200}};
 const send=vi.fn(async(_command:GetSecretValueCommand,_options:{abortSignal:AbortSignal})=>object);
 return {env,secret,object,send,run:()=>loadFullscriptQualificationProviderEnvironment({env,store:{send}})};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('fictional version-bound secret loading, not a provider release or hosted proof',()=>{
 it('requests one exact secret version and returns only a sandbox request-scoped environment',async()=>{
  const s=setup(),before={...process.env};s.env.FULLSCRIPT_ENVIRONMENT='production_us';s.env.FULLSCRIPT_CLIENT_SECRET='untrusted-env-value';
  const result=await s.run();expect(s.send).toHaveBeenCalledOnce();expect(s.send.mock.calls[0][0]).toMatchObject({input:{
   SecretId:s.env.FULLSCRIPT_PROVIDER_SECRET_ARN,VersionId:s.env.FULLSCRIPT_PROVIDER_SECRET_VERSION}});
  expect(result).toEqual({NODE_ENV:'production',AWS_REGION:'us-east-2',PHI_ALLOWED:'false',FULLSCRIPT_ENVIRONMENT:'sandbox_us',FULLSCRIPT_CLIENT_ID:s.secret.clientId,
   FULLSCRIPT_CLIENT_SECRET:s.secret.clientSecret,FULLSCRIPT_OAUTH_STATE_SECRET:s.secret.stateSecret,FULLSCRIPT_REDIRECT_URI:s.secret.redirectUri,
   FULLSCRIPT_TOKEN_TABLE:s.env.FULLSCRIPT_TOKEN_TABLE});expect(process.env).toEqual(before);
 });
 it.each(['AWS_REGION','PHI_ALLOWED','PRODUCTION_ACTIVATION','QUALIFICATION_EXECUTION','QUALIFICATION_ACCOUNT_ID',
  'FULLSCRIPT_PROVIDER_SECRET_ARN','FULLSCRIPT_PROVIDER_SECRET_VERSION','FULLSCRIPT_TOKEN_TABLE','FULLSCRIPT_REDIRECT_URI'])
 ('refuses invalid %s before secret I/O',async key=>{const s=setup();s.env[key]='invalid value';await expect(s.run()).rejects.toThrow('fullscript_credentials_refused');expect(s.send).not.toHaveBeenCalled();});
 it.each([{ARN:'changed'},{VersionId:'changed'},{$metadata:{httpStatusCode:206}},{SecretBinary:Buffer.from('FICTIONAL')},
  {SecretString:undefined},{SecretString:'x'.repeat(8193)},{SecretString:'not json'}])('refuses mismatched secret response %j',async delta=>{
  const s=setup();Object.assign(s.object,delta);await expect(s.run()).rejects.toThrow('fullscript_credentials_refused');
 });
 it.each(['production','redirect','client','state','unknown','duplicate','noncanonical'])('refuses %s secret content',async kind=>{
  const s=setup(),v:Record<string,unknown>={...s.secret};
  if(kind==='production')v.environment='production_us';if(kind==='redirect')v.redirectUri='https://other.example.test/api/live/fullscript/oauth/callback';
  if(kind==='client')v.clientSecret='short';if(kind==='state')v.stateSecret='short';if(kind==='unknown')v.unknown='unsafe';
  s.object.SecretString=canonical(v)+'\n';if(kind==='duplicate')s.object.SecretString=String(s.object.SecretString).replace('{','{"clientId":"ignored",');
  if(kind==='noncanonical')s.object.SecretString=JSON.stringify(v);
  await expect(s.run()).rejects.toThrow('fullscript_credentials_refused');
 });
 it('does not cache an earlier version observation',async()=>{const s=setup();await s.run();s.object.VersionId='different';
  await expect(s.run()).rejects.toThrow();expect(s.send).toHaveBeenCalledTimes(2);});
 it('has a deadline even if transport ignores abort, and does not expose secret/provider errors',async()=>{
  const s=setup();let signal:AbortSignal|undefined;
  const send=vi.fn((_command:unknown,options:{abortSignal:AbortSignal})=>{signal=options.abortSignal;return new Promise<Record<string,unknown>>(()=>{});});
  await expect(loadFullscriptQualificationProviderEnvironment({env:s.env,store:{send},timeoutMs:5})).rejects.toThrow('fullscript_credentials_refused');
  expect(signal?.aborted).toBe(true);
  await expect(loadFullscriptQualificationProviderEnvironment({env:s.env,store:{send:async()=>{throw Error('FICTIONAL raw key or provider payload');}}})).rejects.toThrow('fullscript_credentials_refused');
 });
 it.each([0,-1,5001,1.2])('refuses invalid timeout %s without I/O',async timeoutMs=>{const s=setup();
  await expect(loadFullscriptQualificationProviderEnvironment({env:s.env,store:{send:s.send},timeoutMs})).rejects.toThrow();expect(s.send).not.toHaveBeenCalled();});
 it('native construction is inert, takes a snapshot and never mutates the shared environment',async()=>{
  const s=setup(),send=vi.spyOn(SecretsManagerClient.prototype,'send').mockResolvedValue(s.object as never),before={...process.env};
  const load=nativeFullscriptProviderEnvironmentLoader(s.env);expect(send).not.toHaveBeenCalled();s.env.FULLSCRIPT_PROVIDER_SECRET_VERSION='changed';
  expect((await load()).FULLSCRIPT_ENVIRONMENT).toBe('sandbox_us');expect(send).toHaveBeenCalledOnce();expect(process.env).toEqual(before);
 });
});
