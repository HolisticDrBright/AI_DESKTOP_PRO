import {beforeEach,expect,it,vi} from 'vitest';
import type {DeploymentPlan,DeploymentPorts} from './qualification-deployment-execution';
const f=vi.hoisted(()=>({cli:vi.fn(),ini:vi.fn(),sts:vi.fn(),s3:vi.fn(),lambda:vi.fn(),rds:vi.fn(),clients:[] as Record<string,unknown>[]}));
vi.mock('node:child_process',()=>({execFileSync:f.cli}));
vi.mock('@aws-sdk/credential-provider-ini',()=>({fromIni:f.ini}));
vi.mock('@aws-sdk/client-sts',()=>({STSClient:class{constructor(c:Record<string,unknown>){f.clients.push(c);}send=f.sts;},GetCallerIdentityCommand:class{constructor(readonly input:unknown){}}}));
vi.mock('@aws-sdk/client-s3',()=>({S3Client:class{constructor(c:Record<string,unknown>){f.clients.push(c);}send=f.s3;},GetObjectCommand:class{constructor(readonly input:unknown){}}}));
vi.mock('@aws-sdk/client-lambda',()=>({LambdaClient:class{constructor(c:Record<string,unknown>){f.clients.push(c);}send=f.lambda;},GetFunctionConfigurationCommand:class{constructor(readonly input:unknown){}}}));
vi.mock('@aws-sdk/client-rds-data',()=>({RDSDataClient:class{constructor(c:Record<string,unknown>){f.clients.push(c);}send=f.rds;}}));
vi.mock('./qualification-deployment-resources',()=>({observeFullscriptDeploymentResources:vi.fn(async()=>({}))}));
vi.mock('./qualification-deployment-database',()=>({createFullscriptDeploymentDatabaseObserver:vi.fn(()=>vi.fn(async()=>({})))}));
import {createNativeFullscriptResourcePort,createNativeFullscriptDeploymentPorts,fullscriptNativeAwsJson} from './qualification-deployment-native';
import * as execution from './qualification-deployment-execution';
// Fictional SDK/CLI responses only. No cloud credentials, approvals or writes.
const id={Account:'588966314750',Arn:'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional',UserId:'fictional'};
const plan=()=>({target:{target:{functionArn:'arn:aws:lambda:us-east-2:588966314750:function:alp-fullscript-qualification-fictional',apiId:'fictionalapi'}},
 parameters:[{ParameterKey:'CodeKey',ParameterValue:'fictional.zip'},{ParameterKey:'CodeObjectVersion',ParameterValue:'code-version'},
 {ParameterKey:'TargetKey',ParameterValue:'fictional.json'},{ParameterKey:'TargetObjectVersion',ParameterValue:'target-version'}],
 review:{stackName:'alp-fullscript-qualification-fictional'},reviewSha256:'a'.repeat(64),changeSetName:'fullscript-fictional',clientToken:'fullscript-fictional',templateBody:'{}'} as DeploymentPlan);
beforeEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();f.clients.length=0;f.ini.mockReturnValue(async()=>({}));f.cli.mockReturnValue(JSON.stringify(id));f.sts.mockResolvedValue(id);
 f.lambda.mockRejectedValue({name:'ResourceNotFoundException',$metadata:{httpStatusCode:404}});
 f.s3.mockImplementation(async()=>({ContentLength:3,VersionId:'code-version',ServerSideEncryption:'AES256',Body:(async function*(){yield Buffer.from('abc');})()}));});
it('pins explicit profile, regional endpoints and one attempt; SDK and CLI identities must agree',async()=>{
 const r=createNativeFullscriptResourcePort(plan());expect(await r.identity()).toEqual(id);
 expect(f.ini).toHaveBeenCalledWith({profile:'ai-synthetic-member',ignoreCache:true,clientConfig:{region:'us-east-2',maxAttempts:1}});
 for(const c of f.clients)expect(c).toMatchObject({region:'us-east-2',maxAttempts:1,credentials:expect.any(Function),endpoint:expect.stringMatching(/^https:\/\/.*\.us-east-2\.amazonaws\.com$/)});
 const [,args,opts]=f.cli.mock.calls[0];expect(args).toContain('ai-synthetic-member');expect(opts).toMatchObject({stdio:'pipe',timeout:10000,windowsHide:true});
 expect(opts.env).not.toHaveProperty('AWS_ACCESS_KEY_ID');expect(opts.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
 f.sts.mockResolvedValue({...id,UserId:'different'});await expect(r.identity()).rejects.toThrow(/^fullscript_deployment_native_refused$/);
});
it.each(['root','foreign','role','malformed'])('refuses %s principal without exposing SDK errors',async kind=>{
 const value={...id};if(kind==='root')value.Arn='arn:aws:iam::588966314750:root';if(kind==='foreign')value.Account='173535830222';
 if(kind==='role')value.Arn=id.Arn.replace('OrganizationAccountAccessRole','OtherRole');if(kind==='malformed')value.Arn='SECRET';
 f.sts.mockResolvedValue(value);await expect(createNativeFullscriptResourcePort(plan()).identity()).rejects.toThrow(/^fullscript_deployment_native_refused$/);
});
it.each([['secretsmanager','get-secret-value'],['cloudformation','create-change-set'],['cloudformation','execute-change-set'],['s3','put-object'],['configure','export-credentials']])('public transport refuses %s/%s before dispatch', (s,a)=>{
 expect(()=>fullscriptNativeAwsJson(s,a,{})).toThrow(/^fullscript_deployment_native_refused$/);expect(f.cli).not.toHaveBeenCalled();
});
it('does not interpret empty metadata, raw CLI errors or oversized inputs as evidence',()=>{
 f.cli.mockReturnValue('');expect(()=>fullscriptNativeAwsJson('sts','get-caller-identity',{})).toThrow(/^fullscript_deployment_native_refused$/);
 f.cli.mockImplementation(()=>{throw Error('SECRET health payload');});expect(()=>fullscriptNativeAwsJson('sts','get-caller-identity',{})).toThrow(/^fullscript_deployment_native_refused$/);
 vi.clearAllMocks();expect(()=>fullscriptNativeAwsJson('sts','get-caller-identity',{blob:'x'.repeat(131073)})).toThrow();expect(f.cli).not.toHaveBeenCalled();
});
it('reads only exact object versions and enforces actual bytes with stream destruction',async()=>{
 const destroy=vi.fn(),body=Object.assign((async function*(){yield Buffer.from('abc');})(),{destroy});f.s3.mockResolvedValue({ContentLength:3,VersionId:'code-version',Body:body});
 const r=createNativeFullscriptResourcePort(plan());expect((await r.object('fictional.zip','code-version',16*1024*1024)).bytes.toString()).toBe('abc');expect(destroy).toHaveBeenCalledOnce();
 expect(f.s3.mock.calls[0][0].input).toEqual({Bucket:'alp-qualification-code-588966314750-us-east-2',Key:'fictional.zip',VersionId:'code-version',ExpectedBucketOwner:'588966314750'});
 await expect(r.object('other','code-version',16*1024*1024)).rejects.toThrow();expect(f.s3).toHaveBeenCalledOnce();
});
it.each(['missing','oversized','short','overrun','version','deleted','bad-chunk','destroy'])('refuses object %s and destroys its body',async kind=>{
 const destroy=vi.fn(()=>{if(kind==='destroy')throw Error('SECRET');});
 const body=Object.assign((async function*(){yield kind==='bad-chunk'?'abc':Buffer.from(kind==='short'?'ab':kind==='overrun'?'abcd':'abc');})(),{destroy});
 const response:Record<string,unknown>={ContentLength:3,VersionId:'code-version',Body:body};
 if(kind==='missing')delete response.ContentLength;if(kind==='oversized')response.ContentLength=16*1024*1024+1;if(kind==='version')response.VersionId='wrong';if(kind==='deleted')response.DeleteMarker=true;
 f.s3.mockResolvedValue(response);await expect(createNativeFullscriptResourcePort(plan()).object('fictional.zip','code-version',16*1024*1024)).rejects.toThrow(/^fullscript_deployment_native_refused$/);expect(destroy).toHaveBeenCalledOnce();
});
it.each([403,500,undefined])('never treats Lambda %s as absence',async status=>{
 f.lambda.mockRejectedValue({name:'ResourceNotFoundException',$metadata:{httpStatusCode:status}});
 const p=plan();await expect(createNativeFullscriptResourcePort(p).functionConfiguration(p.target.target.functionArn)).rejects.toThrow(/^fullscript_deployment_native_refused$/);
});
it('accepts only modeled Lambda not-found and refuses unrelated function lookup',async()=>{
 const p=plan(),r=createNativeFullscriptResourcePort(p);expect(await r.functionConfiguration(p.target.target.functionArn)).toBeNull();
 await expect(r.functionConfiguration(p.target.target.functionArn+'evil')).rejects.toThrow();expect(f.lambda).toHaveBeenCalledOnce();
});
it('joins complete route pages and refuses repeated tokens instead of returning partial evidence',async()=>{
 const r=createNativeFullscriptResourcePort(plan());f.cli.mockReturnValueOnce(JSON.stringify({Items:[{RouteId:'one'}],NextToken:'token'})).mockReturnValueOnce(JSON.stringify({Items:[{RouteId:'two'}]}));
 expect((await r.metadata('apigatewayv2','get-routes',{ApiId:'fictionalapi'})).Items).toEqual([{RouteId:'one'},{RouteId:'two'}]);
 f.cli.mockReturnValue(JSON.stringify({Items:[],NextToken:'again'}));await expect(r.metadata('apigatewayv2','get-routes',{})).rejects.toThrow();
});
it('does not dispatch a create without durable admission or when a route was claimed',async()=>{
 const custody={verify:vi.fn(async()=>{}),stages:()=>[],record:vi.fn(),finish:vi.fn()} as DeploymentPorts['custody'];
 const p=plan(),port=createNativeFullscriptDeploymentPorts(p,custody,vi.fn(async()=>{}));await expect(port.create(p)).rejects.toThrow();expect(f.cli).not.toHaveBeenCalled();
 custody.stages=()=>['create_admitted'];f.cli.mockImplementation((_cmd,args)=>{
  const [s,a]=args;if(s==='sts')return JSON.stringify(id);if(a==='list-stacks')return JSON.stringify({StackSummaries:[]});
  if(a==='get-routes')return JSON.stringify({Items:[{RouteKey:'POST /clinical-core/consumer/fullscript/draft'}]});throw Error('unexpected');
 });await expect(port.create(p)).rejects.toThrow();expect(f.cli.mock.calls.some(([,args])=>args[1]==='create-change-set')).toBe(false);
});
it.each(['success','lost-response'])('dispatches create once after fresh absence, %s cannot permit another write',async outcome=>{
 const p=plan(),custody={verify:vi.fn(async()=>{}),stages:()=>['create_admitted'],record:vi.fn(),finish:vi.fn()} as DeploymentPorts['custody'];
 f.cli.mockImplementation((_cmd,args)=>{
  if(args[0]==='sts')return JSON.stringify(id);if(args[1]==='list-stacks')return JSON.stringify({StackSummaries:[]});
  if(args[1]==='get-routes')return JSON.stringify({Items:[]});if(args[1]==='create-change-set'){
   if(outcome==='lost-response')throw Error('SECRET unknown response');
   return JSON.stringify({StackId:`arn:aws:cloudformation:us-east-2:588966314750:stack/${p.review.stackName}/fictional`,Id:`arn:aws:cloudformation:us-east-2:588966314750:changeSet/${p.changeSetName}/fictional`});
  }throw Error('unexpected');
 });const guard=vi.fn(async()=>{}),port=createNativeFullscriptDeploymentPorts(p,custody,guard);
 if(outcome==='success')await port.create(p);else await expect(port.create(p)).rejects.toThrow(/^fullscript_deployment_native_refused$/);
 await expect(port.create(p)).rejects.toThrow();expect(f.cli.mock.calls.filter(([,a])=>a[1]==='create-change-set')).toHaveLength(1);expect(guard.mock.calls.length).toBeGreaterThan(1);
});
it.each(['empty-success','lost-response','changed-proposal'])('execute handles %s with fresh proposal binding and no repeat',async outcome=>{
 // This test isolates transport admission. The real proposal validator has
 // its own unchanged regression suite; this seam returns the observed ids.
 const p=plan(),stackId=`arn:aws:cloudformation:us-east-2:588966314750:stack/${p.review.stackName}/fictional`,
  changeSetId=`arn:aws:cloudformation:us-east-2:588966314750:changeSet/${p.changeSetName}/fictional`;
 const verify=vi.spyOn(execution,'verifyFullscriptPreparation').mockImplementation((_p,o)=>{
  if(o.proposal?.changed)throw Error('changed');return {stackId,changeSetId};
 });
 const custody={verify:vi.fn(async()=>{}),stages:()=>['execute_admitted'],record:vi.fn(),finish:vi.fn()} as DeploymentPorts['custody'];
 f.cli.mockImplementation((_cmd,args)=>{
  if(args[0]==='sts')return JSON.stringify(id);
  const a=args[1];if(a==='list-stacks')return JSON.stringify({StackSummaries:[{StackId:stackId,StackName:p.review.stackName}]});
  if(a==='describe-stacks')return JSON.stringify({Stacks:[{StackId:stackId,StackName:p.review.stackName,StackStatus:'REVIEW_IN_PROGRESS'}]});
  if(a==='list-change-sets')return JSON.stringify({Summaries:[{ChangeSetName:p.changeSetName,ChangeSetId:changeSetId}]});
  if(a==='describe-change-set')return JSON.stringify({ChangeSetId:changeSetId,Status:'CREATE_COMPLETE',changed:outcome==='changed-proposal'});
  if(a==='get-template')return JSON.stringify({TemplateBody:{}});if(a==='list-stack-resources')return JSON.stringify({StackResourceSummaries:[]});
  if(['get-routes','get-authorizers','get-integrations'].includes(a))return JSON.stringify({Items:[]});
  if(a==='execute-change-set'){if(outcome==='lost-response')throw Error('SECRET');return '';}
  throw Error('unexpected');
 });const port=createNativeFullscriptDeploymentPorts(p,custody,vi.fn(async()=>{}));
 if(outcome==='empty-success')await port.execute(p,stackId,changeSetId);else await expect(port.execute(p,stackId,changeSetId)).rejects.toThrow(/^fullscript_deployment_native_refused$/);
 expect(verify).toHaveBeenCalled();
 if(outcome!=='changed-proposal')await expect(port.execute(p,stackId,changeSetId)).rejects.toThrow();
 const calls=f.cli.mock.calls.filter(([,a])=>a[1]==='execute-change-set');expect(calls).toHaveLength(outcome==='changed-proposal'?0:1);
 if(calls.length)expect(JSON.parse(calls[0][1][calls[0][1].indexOf('--cli-input-json')+1])).toMatchObject({StackName:stackId,ChangeSetName:changeSetId,DisableRollback:true});
});
