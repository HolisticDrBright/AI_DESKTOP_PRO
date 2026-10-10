import {beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {fullscriptQualificationTemplate} from '../../../scripts/fullscript-qualification-template.mjs';
import {deploymentCanonical,deploymentDigest,prepareFullscriptDeployment,runFullscriptDeployment,verifyFullscriptDeployed,
 type DeploymentInput,type DeploymentObservation,type DeploymentPlan,type DeploymentPorts,type DeploymentStage} from './qualification-deployment-execution';
import {preflightFullscriptDeployment} from './qualification-deployment-preflight';
// Execution tests use fictional control-plane ports. Real artifact composition
// is tested separately in qualification-deployment-preflight.test.ts.
vi.mock('./qualification-deployment-preflight',()=>({preflightFullscriptDeployment:vi.fn()}));
const bytes=(v:unknown)=>Buffer.from(deploymentCanonical(v)+'\n');
const now=Date.parse('2026-10-09T21:00:00Z'),zip=Buffer.from('FICTIONAL'),source='a'.repeat(40);
let input:DeploymentInput,plan:DeploymentPlan;
beforeEach(()=>{
 const build={contract:'fullscript-api-build/1',clean:true,sourceCommit:source,zipSha256:deploymentDigest(zip),codeSha256:createHash('sha256').update(zip).digest('base64'),
  handler:'index.handler',runtime:'nodejs22.x',phiAllowed:false,activation:'blocked',execution:'qualification_only',deployed:false,targetEmbedded:false,hostedQualified:false};
 const template=fullscriptQualificationTemplate(build);
 const target={target:{functionArn:'arn:aws:lambda:us-east-2:588966314750:function:alp-fullscript-qualification-fictional',codeSha256:build.codeSha256,
  consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce'}};
 const values={ConsumerAudience:'c'.repeat(26),WorkforceAudience:'w'.repeat(26),TargetKey:'FICTIONAL',TargetObjectVersion:'FICTIONAL',TargetReviewSha256:'b'.repeat(64),
  DatabaseName:'clinical_core_qualification',DatabaseClusterArn:'FICTIONAL',DatabaseSecretArn:'FICTIONAL',ProviderSecretArn:'FICTIONAL',ProviderSecretVersion:'FICTIONAL',TokenTableName:'FICTIONAL',RedirectUri:'https://fictional.test'};
 const parameterBytes=bytes(Object.entries(values).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})));
 const templateBytes=Buffer.from(JSON.stringify(template,null,2)+'\n'),targetBytes=bytes(target);
 const review={contract:'fullscript-qualification-deployment-review/1',reviewer:'Brandon Bright',reviewedAt:'2026-10-09T20:59:00.000Z',decision:'approved',
  scope:'create-one-fictional-fullscript-stack-only',sourceCommit:source,zipSha256:deploymentDigest(zip),templateSha256:deploymentDigest(templateBytes),
  targetSha256:deploymentDigest(targetBytes),parameterSha256:deploymentDigest(parameterBytes),stackName:'alp-fullscript-qualification-fictional',runId:'1'.repeat(32),
  resourceReviewSha256:'2'.repeat(64),sqlPrivilegeReviewSha256:'3'.repeat(64),credentialReviewSha256:'4'.repeat(64),phiAllowed:false,activation:'blocked',providerActionsAllowed:false};
 input={sourceCommit:source,clean:true,now,zipBytes:zip,buildBytes:bytes(build),templateBytes,targetBytes,parameterBytes,reviewBytes:bytes(review)};
 vi.mocked(preflightFullscriptDeployment).mockReturnValue({contract:'fullscript-deployment-preflight/1',verdict:'locally_consistent',sourceCommit:source,
  zipSha256:review.zipSha256,templateSha256:review.templateSha256,targetSha256:review.targetSha256,parameterSha256:review.parameterSha256,parameterCount:27,
  awsObserved:false,ownerDeploymentReviewRequired:true,approvedForDeployment:false,deployed:false,hostedQualified:false,phiAllowed:false,activation:'blocked'});
 plan=prepareFullscriptDeployment(input);
});
function observation(final=false):DeploymentObservation{
 const stackId='arn:aws:cloudformation:us-east-2:588966314750:stack/'+plan.review.stackName+'/11111111-1111-4111-8111-111111111111';
 const changeSetId='arn:aws:cloudformation:us-east-2:588966314750:changeSet/'+plan.changeSetName+'/22222222-2222-4222-8222-222222222222';
 const tags=[{Key:'FullscriptDeploymentReview',Value:plan.reviewSha256}],version=plan.target.target.functionArn+':1';
 const physical=(id:string)=>id==='Version'?version:id==='Role'?'FICTIONAL-role':id==='Integration'?'fictional-integration':'fictional-'+id;
 const resources=plan.resources.map(r=>({...r,ResourceStatus:'CREATE_COMPLETE',PhysicalResourceId:physical(r.LogicalResourceId)}));
 const env={NODE_ENV:'production',PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',QUALIFICATION_ACCOUNT_ID:'588966314750',
  FULLSCRIPT_SOURCE_COMMIT:source,FULLSCRIPT_TARGET_BUCKET:'alp-qualification-code-588966314750-us-east-2'};
 const mapping={TargetKey:'FULLSCRIPT_TARGET_KEY',TargetObjectVersion:'FULLSCRIPT_TARGET_VERSION',TargetReviewSha256:'QUALIFICATION_REVIEW_SHA256',DatabaseName:'CLINICAL_DATABASE_NAME',
  DatabaseClusterArn:'CLINICAL_DATABASE_CLUSTER_ARN',DatabaseSecretArn:'CLINICAL_DATABASE_SECRET_ARN',ProviderSecretArn:'FULLSCRIPT_PROVIDER_SECRET_ARN',
  ProviderSecretVersion:'FULLSCRIPT_PROVIDER_SECRET_VERSION',TokenTableName:'FULLSCRIPT_TOKEN_TABLE',RedirectUri:'FULLSCRIPT_REDIRECT_URI'};
 for(const [k,v] of Object.entries(mapping))(env as Record<string,string>)[v]=plan.parameters.find(p=>p.ParameterKey===k)!.ParameterValue;
 return {stack:{StackId:stackId,StackStatus:final?'CREATE_COMPLETE':'REVIEW_IN_PROGRESS',Capabilities:['CAPABILITY_IAM'],Parameters:plan.parameters,Tags:tags},
  proposal:{StackId:stackId,StackName:plan.review.stackName,ChangeSetId:changeSetId,ChangeSetName:plan.changeSetName,Status:'CREATE_COMPLETE',
   ExecutionStatus:final?'EXECUTE_COMPLETE':'AVAILABLE',Capabilities:['CAPABILITY_IAM'],Parameters:plan.parameters,Tags:tags,CreationTime:'2026-10-09T21:00:00Z',
   Changes:plan.resources.map(r=>({Type:'Resource',ResourceChange:{...r,Action:'Add'}}))},template:JSON.parse(plan.templateBody),resources:final?resources:[],
  function:final?{FunctionArn:version,CodeSha256:plan.target.target.codeSha256,Version:'1',State:'Active',LastUpdateStatus:'Successful',Runtime:'nodejs22.x',
   Handler:'index.handler',Timeout:30,MemorySize:512,Role:'arn:aws:iam::588966314750:role/FICTIONAL-role',Environment:{Variables:env}}:null,
  routes:final?['Consumer','Workforce'].map(role=>({RouteId:physical(role+'Route'),RouteKey:`POST /clinical-core/${role.toLowerCase()}/fullscript/draft`,AuthorizationType:'JWT',
   AuthorizerId:physical(role+'Authorizer'),Target:'integrations/'+physical('Integration')})):[],
  authorizers:final?['Consumer','Workforce'].map(role=>({AuthorizerId:physical(role+'Authorizer'),AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],
   JwtConfiguration:{Issuer:plan.target.target[role.toLowerCase()+'Issuer'],Audience:[plan.parameters.find(p=>p.ParameterKey===role+'Audience')!.ParameterValue]}})):[],
  integrations:final?[{IntegrationId:physical('Integration'),IntegrationType:'AWS_PROXY',PayloadFormatVersion:'2.0',IntegrationUri:version}]:[]};
}
function ports(){
 const stages:DeploymentStage[]=[],trace:string[]=[];
 const empty:DeploymentObservation={stack:null,proposal:null,template:null,resources:[],function:null,routes:[],authorizers:[],integrations:[]};
 const p:DeploymentPorts={now:()=>now,guard:vi.fn(async()=>{trace.push('guard');}),custody:{verify:vi.fn(async()=>{}),stages:()=>[...stages],
  record:vi.fn(async s=>{trace.push(s);stages.push(s);}),finish:vi.fn(async()=>{trace.push('finish');})},
  observe:vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(observation()).mockResolvedValueOnce(observation(true)),
  create:vi.fn(async()=>{trace.push('create');}),execute:vi.fn(async()=>{trace.push('execute');})};return {p,stages,trace};
}
it('admits each write before dispatch and reports only observed control-plane deployment',async()=>{
 const {p,trace}=ports();const result=await runFullscriptDeployment(plan,p,'deploy');
 expect(result).toMatchObject({deployed:true,hostedQualified:false,phiAllowed:false,providerActionPerformed:false});
 expect(trace.indexOf('create_admitted')).toBeLessThan(trace.indexOf('create'));expect(trace.indexOf('execute_admitted')).toBeLessThan(trace.indexOf('execute'));
 expect(p.create).toHaveBeenCalledOnce();expect(p.execute).toHaveBeenCalledOnce();expect(p.custody.finish).toHaveBeenCalledOnce();
});
it.each(['create','execute'])('lost %s response leaves admitted custody and never repeats or certifies',async which=>{
 const {p,stages}=ports();vi.mocked(p[which as 'create'|'execute']).mockRejectedValue(Error('SECRET raw error'));
 await expect(runFullscriptDeployment(plan,p,'deploy')).rejects.toThrow(/^fullscript_deployment_execution_refused$/);
 expect(stages).toContain(which+'_admitted');expect(p[which as 'create'|'execute']).toHaveBeenCalledOnce();expect(p.custody.finish).not.toHaveBeenCalled();
});
it('observation timeout is not terminal evidence or permission for another execute',async()=>{
 const {p}=ports();vi.mocked(p.observe).mockReset().mockRejectedValueOnce(Error('fictional timeout'));
 await expect(runFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.create).not.toHaveBeenCalled();expect(p.custody.finish).not.toHaveBeenCalled();
});
it('read-only recovery can settle a positively observed admitted execution after review expiry',async()=>{
 const {p,stages}=ports();stages.push('create_admitted','create_observed','execute_admitted');p.now=()=>now+48*60*60*1000;
 vi.mocked(p.observe).mockReset().mockResolvedValue(observation(true));await runFullscriptDeployment(plan,p,'observe');
 expect(p.create).not.toHaveBeenCalled();expect(p.execute).not.toHaveBeenCalled();expect(p.custody.finish).toHaveBeenCalledOnce();
});
it('preparation recovery observes the same proposal and executes once, never creates another',async()=>{
 const {p,stages}=ports();stages.push('create_admitted');vi.mocked(p.observe).mockReset().mockResolvedValueOnce(observation()).mockResolvedValueOnce(observation(true));
 await runFullscriptDeployment(plan,p,'execute-prepared');expect(p.create).not.toHaveBeenCalled();expect(p.execute).toHaveBeenCalledOnce();
});
it('explicit unadmitted recovery still requires absence of stack, proposal, function and routes',async()=>{
 const {p}=ports();await runFullscriptDeployment(plan,p,'resume-unadmitted');expect(p.create).toHaveBeenCalledOnce();
 const other=ports();vi.mocked(other.p.observe).mockReset().mockResolvedValue(observation());
 await expect(runFullscriptDeployment(plan,other.p,'resume-unadmitted')).rejects.toThrow();expect(other.p.create).not.toHaveBeenCalled();
});
it('an admitted executor cannot be repeated by preparation recovery',async()=>{
 const {p,stages}=ports();stages.push('create_admitted','create_observed','execute_admitted');vi.mocked(p.observe).mockReset().mockResolvedValue(observation());
 await expect(runFullscriptDeployment(plan,p,'execute-prepared')).rejects.toThrow();expect(p.execute).not.toHaveBeenCalled();
});
it('a route claimed after proposal creation refuses execution instead of attempting to replace it',async()=>{
 const {p,stages}=ports();stages.push('create_admitted');const o=observation();o.routes=[{RouteKey:'POST /clinical-core/consumer/fullscript/draft'}];
 vi.mocked(p.observe).mockReset().mockResolvedValue(o);await expect(runFullscriptDeployment(plan,p,'execute-prepared')).rejects.toThrow();
 expect(p.execute).not.toHaveBeenCalled();expect(p.custody.finish).not.toHaveBeenCalled();
});
it('ports cannot mutate the reviewed plan during asynchronous work',async()=>{
 const {p}=ports();vi.mocked(p.guard).mockImplementation(async supplied=>{supplied.review.stackName='changed';supplied.parameters=[];});
 await runFullscriptDeployment(plan,p,'deploy');expect(vi.mocked(p.create).mock.calls[0][0].review.stackName).toBe(plan.review.stackName);
});
it.each(['template','parameters','changes','tags','account','nested','unready'])('refuses changed proposal %s before execute',async kind=>{
 const {p}=ports(),o=observation();
 if(kind==='template')o.template={};if(kind==='parameters')o.proposal!.Parameters=[];
 if(kind==='changes')(o.proposal!.Changes as Record<string,unknown>[]).pop();if(kind==='tags')o.proposal!.Tags=[];
 if(kind==='account')o.proposal!.ChangeSetId=String(o.proposal!.ChangeSetId).replace('588966314750','173535830222');
 if(kind==='nested')o.proposal!.IncludeNestedStacks=true;if(kind==='unready')o.proposal!.Status='CREATE_IN_PROGRESS';
 vi.mocked(p.observe).mockReset().mockResolvedValueOnce({stack:null,proposal:null,template:null,resources:[],function:null,routes:[],authorizers:[],integrations:[]}).mockResolvedValueOnce(o);
 await expect(runFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.execute).not.toHaveBeenCalled();expect(p.custody.finish).not.toHaveBeenCalled();
});
it.each(['sourceCommit','zipSha256','templateSha256','targetSha256','parameterSha256','resourceReviewSha256','sqlPrivilegeReviewSha256','credentialReviewSha256','scope','phiAllowed'])('refuses changed or absent review %s',key=>{
 const review=JSON.parse(input.reviewBytes.toString());review[key]=key.endsWith('Sha256')?'0'.repeat(64):'changed';
 expect(()=>prepareFullscriptDeployment({...input,reviewBytes:bytes(review)})).toThrow();
});
it.each(['code','version','environment','route','authorizer','integration','resources','stack'])('refuses incomplete deployed observation %s',kind=>{
 const o=observation(true);
 if(kind==='code')o.function!.CodeSha256='wrong';if(kind==='version')o.function!.Version='$LATEST';
 if(kind==='environment')((o.function!.Environment as Record<string,unknown>).Variables as Record<string,unknown>).PHI_ALLOWED='true';
 if(kind==='route')o.routes[0].AuthorizationType='NONE';if(kind==='authorizer')o.authorizers[0].JwtConfiguration={};
 if(kind==='integration')o.integrations[0].IntegrationUri=plan.target.target.functionArn;if(kind==='resources')o.resources.pop();if(kind==='stack')o.stack!.StackStatus='CREATE_IN_PROGRESS';
 expect(()=>verifyFullscriptDeployed(plan,o,now)).toThrow();
});
it('a failing live guard refuses before any control-plane mutation',async()=>{
 const {p}=ports();vi.mocked(p.guard).mockRejectedValue(Error('fictional changed SQL privileges'));
 await expect(runFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.create).not.toHaveBeenCalled();expect(p.execute).not.toHaveBeenCalled();
});
it('an expired review can be inspected but cannot authorize a new write',async()=>{
 const {p}=ports();p.now=()=>now+25*60*60*1000;await expect(runFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.create).not.toHaveBeenCalled();
});
