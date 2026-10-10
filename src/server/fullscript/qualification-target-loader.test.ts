import {beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {loadFullscriptQualificationTarget} from './qualification-target-loader';

const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const bytes=(v:unknown)=>Buffer.from(canonical(v)+'\n');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
let release:Record<string,unknown>;
beforeAll(()=>{
 const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],
  {encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
 release={contract:'fullscript-qualification-target-release/2',target:{execution:'qualification',account:'588966314750',region:'us-east-2',
  phiAllowed:false,activation:'blocked',sourceCommit:'a'.repeat(40),apiId:'a123456789',
  functionArn:'arn:aws:lambda:us-east-2:588966314750:function:FICTIONAL-fullscript',codeSha256:Buffer.alloc(32,7).toString('base64'),
  clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  databaseName:'clinical_core_qualification',organizationId:'11111111-1111-4111-8111-111111111111',
  consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',consumerAudience:'c'.repeat(26),
  workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce',workforceAudience:'w'.repeat(26),
  consumerSubjects:['FICTIONAL-consumer-1','FICTIONAL-consumer-2'],workforceSubjects:['FICTIONAL-workforce'],
  migrations:artifact.manifest.migrations.map((m:{version:string;file:string})=>({version:m.version,name:m.file.slice(15,-4),
   sha256:sha(Buffer.from(artifact.files[m.file]))}))},
  credentials:{providerSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:FICTIONAL-fullscript',
   providerSecretVersion:'f'.repeat(32),tokenTable:'FICTIONAL-fullscript-tokens',redirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback'},
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-10-01T00:00:00.000Z',decision:'approved',scope:'fictional-fullscript-api-target-only',
   versionBinding:'observed-numeric-version-of-exact-reviewed-code'}};
 // This approval is explicitly FICTIONAL fixture metadata, not a real release.
});
function setup(value:unknown=release){
 const content=bytes(value),target=(release.target as Record<string,string>);
 const env:Record<string,string|undefined>={AWS_REGION:'us-east-2',PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',
  QUALIFICATION_ACCOUNT_ID:'588966314750',FULLSCRIPT_SOURCE_COMMIT:'a'.repeat(40),FULLSCRIPT_TARGET_BUCKET:'alp-qualification-code-588966314750-us-east-2',
  FULLSCRIPT_TARGET_KEY:'fullscript/qualification-target/'+ '1'.repeat(32)+'/target.json',FULLSCRIPT_TARGET_VERSION:'FICTIONAL-version',
  QUALIFICATION_REVIEW_SHA256:sha(content),CLINICAL_DATABASE_NAME:target.databaseName,
  CLINICAL_DATABASE_CLUSTER_ARN:target.clusterArn,CLINICAL_DATABASE_SECRET_ARN:target.secretArn,
  FULLSCRIPT_PROVIDER_SECRET_ARN:'arn:aws:secretsmanager:us-east-2:588966314750:secret:FICTIONAL-fullscript',
  FULLSCRIPT_PROVIDER_SECRET_VERSION:'f'.repeat(32),FULLSCRIPT_TOKEN_TABLE:'FICTIONAL-fullscript-tokens',
  FULLSCRIPT_REDIRECT_URI:'https://fictional.example.test/api/live/fullscript/oauth/callback'};
 const body=Readable.from([content.subarray(0,31),content.subarray(31)]),destroy=vi.spyOn(body,'destroy');
 const object:Record<string,unknown>={$metadata:{httpStatusCode:200},VersionId:'FICTIONAL-version',ContentLength:content.length,ContentType:'application/json',ServerSideEncryption:'AES256',Body:body};
 const send=vi.fn(async()=>object),context={invokedFunctionArn:target.functionArn+':7',functionVersion:'7'},build={sourceCommit:'a'.repeat(40),clean:true};
 return {env,object,body,destroy,send,context,build,run:()=>loadFullscriptQualificationTarget({env,build,context,store:{send}})};
}
describe('immutable Fullscript target loader with fictional S3; not hosted acceptance',()=>{
 it('fetches the exact version under expected-owner binding and derives only AWS numeric context',async()=>{
  const s=setup(),target=await s.run();expect(target).toMatchObject({functionArn:s.context.invokedFunctionArn,reviewSha256:s.env.QUALIFICATION_REVIEW_SHA256,phiAllowed:false});
  expect(s.send.mock.calls).toHaveLength(1);
  expect((s.send.mock.calls[0] as unknown as [{input:unknown}])[0].input).toEqual({Bucket:s.env.FULLSCRIPT_TARGET_BUCKET,
   Key:s.env.FULLSCRIPT_TARGET_KEY,VersionId:s.env.FULLSCRIPT_TARGET_VERSION,ExpectedBucketOwner:'588966314750'});
 });
 it.each(['PHI_ALLOWED','PRODUCTION_ACTIVATION','QUALIFICATION_EXECUTION','QUALIFICATION_ACCOUNT_ID','AWS_REGION','FULLSCRIPT_SOURCE_COMMIT',
  'FULLSCRIPT_TARGET_BUCKET','FULLSCRIPT_TARGET_KEY','FULLSCRIPT_TARGET_VERSION','QUALIFICATION_REVIEW_SHA256'])('refuses invalid %s before S3',async key=>{
  const s=setup();s.env[key]='invalid value';await expect(s.run()).rejects.toThrow('fullscript_target_release_refused');expect(s.send).not.toHaveBeenCalled();
 });
 it.each(['null',''])('refuses unversioned pointer %s',async version=>{const s=setup();s.env.FULLSCRIPT_TARGET_VERSION=version;
  await expect(s.run()).rejects.toThrow();expect(s.send).not.toHaveBeenCalled();});
 it.each(['$LATEST','alias','0'])('refuses nonpublished context %s before S3',async version=>{const s=setup();s.context.functionVersion=version;
  await expect(s.run()).rejects.toThrow();expect(s.send).not.toHaveBeenCalled();});
 it('refuses dirty builds before storage access',async()=>{const s=setup();s.build.clean=false;await expect(s.run()).rejects.toThrow();expect(s.send).not.toHaveBeenCalled();});
 it.each([{VersionId:'changed'},{ContentLength:65537},{ContentLength:0},{ContentLength:-1},{ContentLength:1.1},
  {ContentType:'text/plain'},{ContentEncoding:'gzip'},{DeleteMarker:true},{ServerSideEncryption:undefined},
  {$metadata:{httpStatusCode:206}},{ContentRange:'bytes 0-100/200'}])('refuses wrong object metadata %j',async delta=>{
  const s=setup();Object.assign(s.object,delta);await expect(s.run()).rejects.toThrow('fullscript_target_release_refused');expect(s.destroy).toHaveBeenCalled();
 });
 it.each(['short','long','digest','utf8'])('refuses %s body without constructing a target',async kind=>{
  const s=setup();if(kind==='short')s.object.ContentLength=Number(s.object.ContentLength)+1;
  if(kind==='long')s.object.ContentLength=Number(s.object.ContentLength)-1;
  if(kind==='digest')s.env.QUALIFICATION_REVIEW_SHA256='b'.repeat(64);
  if(kind==='utf8'){const b=Buffer.from([0xff]);s.object.Body=Readable.from([b]);s.object.ContentLength=1;s.env.QUALIFICATION_REVIEW_SHA256=sha(b);}
  await expect(s.run()).rejects.toThrow('fullscript_target_release_refused');
 });
 it('refuses duplicate keys even when the outer digest matches',async()=>{
  const s=setup(),b=Buffer.from(bytes(release).toString().replace('{','{"contract":"unapproved",'));
  s.object.Body=Readable.from([b]);s.object.ContentLength=b.length;s.env.QUALIFICATION_REVIEW_SHA256=sha(b);await expect(s.run()).rejects.toThrow();
 });
 it.each(['review','source','ledger','function','duplicate-subject','database','unknown'])('refuses malformed reviewed release %s',async kind=>{
  const v=structuredClone(release),t=v.target as Record<string,unknown>;
  if(kind==='review')delete v.review;if(kind==='source')t.sourceCommit='c'.repeat(40);if(kind==='ledger')t.migrations=[];
  if(kind==='function')t.functionArn='arn:aws:lambda:us-east-2:588966314750:function:Other';
  if(kind==='duplicate-subject')t.consumerSubjects=['FICTIONAL-consumer-1','FICTIONAL-consumer-1'];
  if(kind==='database')t.databaseName='clinical_core';if(kind==='unknown')t.override='unsafe';
  await expect(setup(v).run()).rejects.toThrow('fullscript_target_release_refused');
 });
 it('bounds a stalled stream and aborts storage rather than hanging',async()=>{
  const s=setup(),destroy=vi.fn();s.object.Body={async *[Symbol.asyncIterator](){await new Promise(()=>{});yield Buffer.from('never');},destroy};
  await expect(loadFullscriptQualificationTarget({env:s.env,build:s.build,context:s.context,store:{send:s.send},timeoutMs:10})).rejects.toThrow();
  expect(destroy).toHaveBeenCalled();
 });
 it('a throwing stream destroy cannot suppress deadline refusal',async()=>{
  const s=setup();s.object.Body={async *[Symbol.asyncIterator](){await new Promise(()=>{});yield Buffer.from('never');},destroy:()=>{throw Error('FICTIONAL stream detail');}};
  await expect(loadFullscriptQualificationTarget({env:s.env,build:s.build,context:s.context,store:{send:s.send},timeoutMs:10}))
   .rejects.toThrow('fullscript_target_release_refused');
 });
 it('a storage response arriving after the deadline has its body closed and is never admitted',async()=>{
  const s=setup();let deliver:(v:Record<string,unknown>)=>void=()=>{};
  const send=vi.fn(()=>new Promise<Record<string,unknown>>(resolve=>{deliver=resolve;}));
  await expect(loadFullscriptQualificationTarget({env:s.env,build:s.build,context:s.context,store:{send},timeoutMs:10})).rejects.toThrow();
  deliver(s.object);await new Promise(resolve=>setTimeout(resolve,0));expect(s.destroy).toHaveBeenCalled();
 });
 it.each(['pending','future','different-scope'])('refuses %s review metadata even with its content hash',async kind=>{
  const v=structuredClone(release),review=v.review as Record<string,unknown>;
  if(kind==='pending')review.decision='pending';if(kind==='future')review.reviewedAt='2100-01-01T00:00:00.000Z';
  if(kind==='different-scope')review.scope='production-activation';await expect(setup(v).run()).rejects.toThrow();
 });
 it('refuses empty chunks rather than collecting an unbounded stream of them',async()=>{
  const s=setup();s.object.Body=Readable.from([Buffer.alloc(0),Buffer.from('never')]);await expect(s.run()).rejects.toThrow();
 });
 it('does not cache target observations across requests',async()=>{
  const s=setup();await s.run();s.object.VersionId='changed';await expect(s.run()).rejects.toThrow();expect(s.send).toHaveBeenCalledTimes(2);
 });
 it.each(['FULLSCRIPT_PROVIDER_SECRET_ARN','FULLSCRIPT_PROVIDER_SECRET_VERSION','FULLSCRIPT_TOKEN_TABLE','FULLSCRIPT_REDIRECT_URI'])
  ('refuses changed credential pointer %s despite the same target digest',async key=>{
   const s=setup();s.env[key]='changed';await expect(s.run()).rejects.toThrow('fullscript_target_release_refused');
  });
 it.each(['missing','legacy','wrong-account','wrong-version'])('refuses %s credential binding in a hash-matched artifact',async kind=>{
  const v=structuredClone(release),credentials=v.credentials as Record<string,unknown>;
  if(kind==='missing')delete v.credentials;if(kind==='legacy')v.contract='fullscript-qualification-target-release/1';
  if(kind==='wrong-account')credentials.providerSecretArn='arn:aws:secretsmanager:us-east-2:173535830222:secret:FICTIONAL';
  if(kind==='wrong-version')credentials.providerSecretVersion='AWSCURRENT';
  await expect(setup(v).run()).rejects.toThrow('fullscript_target_release_refused');
 });
});
