import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {prepareSuccessorFullscriptDeployment,runSuccessorFullscriptDeployment,verifySuccessorFullscriptDeployed,
 deploymentCanonical,type DeploymentInput,type DeploymentPlan,type DeploymentObservation,type DeploymentPorts,type DeploymentStage} from './successor-deployment-execution';
import {prepareFullscriptDeployment} from './qualification-deployment-execution';
import {createSuccessorDeploymentFixture} from './successor-deployment.fixture';
import {fictionalInstalledControls} from './successor-deployment-controls.fixture';
const bytes=(v:unknown)=>Buffer.from(deploymentCanonical(v)+'\n');
let fixture:DeploymentInput,input:DeploymentInput,plan:DeploymentPlan;
const source='a'.repeat(40),now=Date.parse('2026-10-11T16:00:00Z');
beforeAll(()=>{fixture=createSuccessorDeploymentFixture();},60000);
beforeEach(()=>{input=structuredClone(fixture); for(const key of ['buildBytes','zipBytes','targetBytes','templateBytes','parameterBytes','reviewBytes'] as const)input[key]=Buffer.from(input[key]);plan=prepareSuccessorFullscriptDeployment(input);});
function observation(final=false):DeploymentObservation{
 const stackId='arn:aws:cloudformation:us-east-2:588966314750:stack/'+plan.review.stackName+'/11111111-1111-4111-8111-111111111111';
 const changeSetId='arn:aws:cloudformation:us-east-2:588966314750:changeSet/'+plan.changeSetName+'/22222222-2222-4222-8222-222222222222';
 const tags=[{Key:'FullscriptDeploymentReview',Value:plan.reviewSha256}],version=plan.target.target.functionArn+':1';
 const physical=(id:string)=>id==='Version'?version:id==='Role'?'FICTIONAL-role':id==='Integration'?'fictional-integration':'fictional-'+id;
 const resources=plan.resources.map(r=>({...r,ResourceStatus:'CREATE_COMPLETE',PhysicalResourceId:physical(r.LogicalResourceId)}));
 const env={NODE_ENV:'production',PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',QUALIFICATION_ACCOUNT_ID:'588966314750',
  SOURCE_COMMIT:source,SOURCE_INPUT_SHA256:plan.sourceInputSha256,DEPLOYMENT_ACCOUNT_ID:'588966314750',
  SUCCESSOR_QUALIFICATION_PROFILE:plan.qualificationProfile,MIGRATION_RELEASE_SHA256:plan.migrationReleaseSha256,
  MIGRATION_ASSEMBLY_SHA256:plan.migrationAssemblySha256,QUALIFICATION_IDENTITY_SUBJECTS:plan.parameters.find(p=>p.ParameterKey==='QualificationIdentitySubjects')!.ParameterValue,
  FULLSCRIPT_SOURCE_COMMIT:source,FULLSCRIPT_TARGET_BUCKET:'alp-qualification-code-588966314750-us-east-2'};
 const mapping={TargetKey:'FULLSCRIPT_TARGET_KEY',TargetObjectVersion:'FULLSCRIPT_TARGET_VERSION',TargetReviewSha256:'QUALIFICATION_REVIEW_SHA256',DatabaseName:'CLINICAL_DATABASE_NAME',
  DatabaseClusterArn:'CLINICAL_DATABASE_CLUSTER_ARN',DatabaseSecretArn:'CLINICAL_DATABASE_SECRET_ARN',ProviderSecretArn:'FULLSCRIPT_PROVIDER_SECRET_ARN',
  ProviderSecretVersion:'FULLSCRIPT_PROVIDER_SECRET_VERSION',TokenTableName:'FULLSCRIPT_TOKEN_TABLE',RedirectUri:'FULLSCRIPT_REDIRECT_URI'};
 for(const [k,v] of Object.entries(mapping))(env as Record<string,string>)[v]=plan.parameters.find(p=>p.ParameterKey===k)!.ParameterValue;
 const o:DeploymentObservation={stack:{StackId:stackId,StackStatus:final?'CREATE_COMPLETE':'REVIEW_IN_PROGRESS',Capabilities:['CAPABILITY_IAM'],Parameters:plan.parameters,Tags:tags},
  proposal:{StackId:stackId,StackName:plan.review.stackName,ChangeSetId:changeSetId,ChangeSetName:plan.changeSetName,Status:'CREATE_COMPLETE',
   ExecutionStatus:final?'EXECUTE_COMPLETE':'AVAILABLE',Capabilities:['CAPABILITY_IAM'],Parameters:plan.parameters,Tags:tags,CreationTime:'2026-10-11T16:00:00Z',
   Changes:plan.resources.map(r=>({Type:'Resource',ResourceChange:{...r,Action:'Add'}}))},template:JSON.parse(plan.templateBody),resources:final?resources:[],
  function:final?{FunctionArn:version,CodeSha256:plan.target.target.codeSha256,Version:'1',State:'Active',LastUpdateStatus:'Successful',Runtime:'nodejs22.x',
   Handler:'index.handler',Timeout:30,MemorySize:512,Role:'arn:aws:iam::588966314750:role/FICTIONAL-role',Environment:{Variables:env}}:null,
  routes:final?['Consumer','Workforce'].map(role=>({RouteId:physical(role+'Route'),RouteKey:`POST /clinical-core/${role.toLowerCase()}/fullscript/draft`,AuthorizationType:'JWT',
   AuthorizerId:physical(role+'Authorizer'),Target:'integrations/'+physical('Integration')})):[],
  authorizers:final?['Consumer','Workforce'].map(role=>({AuthorizerId:physical(role+'Authorizer'),AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],
   JwtConfiguration:{Issuer:plan.target.target[role.toLowerCase()+'Issuer'],Audience:[plan.parameters.find(p=>p.ParameterKey===role+'Audience')!.ParameterValue]}})):[],
  integrations:final?[{IntegrationId:physical('Integration'),IntegrationType:'AWS_PROXY',PayloadFormatVersion:'2.0',IntegrationUri:version}]:[]};
 if(final)o.controls=fictionalInstalledControls(plan,o);return o;
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
 const {p,trace}=ports();const result=await runSuccessorFullscriptDeployment(plan,p,'deploy');
 expect(result).toMatchObject({deployed:true,hostedQualified:false,phiAllowed:false,providerActionPerformed:false});
 expect(trace.indexOf('create_admitted')).toBeLessThan(trace.indexOf('create'));expect(trace.indexOf('execute_admitted')).toBeLessThan(trace.indexOf('execute'));
 expect(p.create).toHaveBeenCalledOnce();expect(p.execute).toHaveBeenCalledOnce();expect(p.custody.finish).toHaveBeenCalledOnce();
});
it.each(['missing','drift'])('cannot settle deployment with %s installed controls',async kind=>{
 const {p,stages}=ports();stages.push('create_admitted','create_observed','execute_admitted');const o=observation(true);
 if(kind==='missing')delete o.controls;else o.controls!.attached.AttachedPolicies=[{PolicyArn:'AdministratorAccess'}];
 vi.mocked(p.observe).mockReset().mockResolvedValue(o);
 await expect(runSuccessorFullscriptDeployment(plan,p,'observe')).rejects.toThrow(/^successor_fullscript_deployment_execution_refused$/);
 expect(p.custody.finish).not.toHaveBeenCalled();expect(p.execute).not.toHaveBeenCalled();
});
it.each(['create','execute'])('lost %s response leaves admitted custody and never repeats or certifies',async which=>{
 const {p,stages}=ports();vi.mocked(p[which as 'create'|'execute']).mockRejectedValue(Error('SECRET raw error'));
 await expect(runSuccessorFullscriptDeployment(plan,p,'deploy')).rejects.toThrow(/^successor_fullscript_deployment_execution_refused$/);
 expect(stages).toContain(which+'_admitted');expect(p[which as 'create'|'execute']).toHaveBeenCalledOnce();expect(p.custody.finish).not.toHaveBeenCalled();
});
it('observation timeout is not terminal evidence or permission for another execute',async()=>{
 const {p}=ports();vi.mocked(p.observe).mockReset().mockRejectedValueOnce(Error('fictional timeout'));
 await expect(runSuccessorFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.create).not.toHaveBeenCalled();expect(p.custody.finish).not.toHaveBeenCalled();
});
it('read-only recovery can settle a positively observed admitted execution after review expiry',async()=>{
 const {p,stages}=ports();stages.push('create_admitted','create_observed','execute_admitted');p.now=()=>now+48*60*60*1000;
 vi.mocked(p.observe).mockReset().mockResolvedValue(observation(true));await runSuccessorFullscriptDeployment(plan,p,'observe');
 expect(p.create).not.toHaveBeenCalled();expect(p.execute).not.toHaveBeenCalled();expect(p.custody.finish).toHaveBeenCalledOnce();
});
it('preparation recovery observes the same proposal and executes once, never creates another',async()=>{
 const {p,stages}=ports();stages.push('create_admitted');vi.mocked(p.observe).mockReset().mockResolvedValueOnce(observation()).mockResolvedValueOnce(observation(true));
 await runSuccessorFullscriptDeployment(plan,p,'execute-prepared');expect(p.create).not.toHaveBeenCalled();expect(p.execute).toHaveBeenCalledOnce();
});
it('explicit unadmitted recovery still requires absence of stack, proposal, function and routes',async()=>{
 const {p}=ports();await runSuccessorFullscriptDeployment(plan,p,'resume-unadmitted');expect(p.create).toHaveBeenCalledOnce();
 const other=ports();vi.mocked(other.p.observe).mockReset().mockResolvedValue(observation());
 await expect(runSuccessorFullscriptDeployment(plan,other.p,'resume-unadmitted')).rejects.toThrow();expect(other.p.create).not.toHaveBeenCalled();
});
it('an admitted executor cannot be repeated by preparation recovery',async()=>{
 const {p,stages}=ports();stages.push('create_admitted','create_observed','execute_admitted');vi.mocked(p.observe).mockReset().mockResolvedValue(observation());
 await expect(runSuccessorFullscriptDeployment(plan,p,'execute-prepared')).rejects.toThrow();expect(p.execute).not.toHaveBeenCalled();
});
it('a route claimed after proposal creation refuses execution instead of attempting to replace it',async()=>{
 const {p,stages}=ports();stages.push('create_admitted');const o=observation();o.routes=[{RouteKey:'POST /clinical-core/consumer/fullscript/draft'}];
 vi.mocked(p.observe).mockReset().mockResolvedValue(o);await expect(runSuccessorFullscriptDeployment(plan,p,'execute-prepared')).rejects.toThrow();
 expect(p.execute).not.toHaveBeenCalled();expect(p.custody.finish).not.toHaveBeenCalled();
});
it('ports cannot mutate the reviewed plan during asynchronous work',async()=>{
 const {p}=ports();vi.mocked(p.guard).mockImplementation(async supplied=>{supplied.review.stackName='changed';supplied.parameters=[];});
 await runSuccessorFullscriptDeployment(plan,p,'deploy');expect(vi.mocked(p.create).mock.calls[0][0].review.stackName).toBe(plan.review.stackName);
});
it.each(['template','parameters','changes','tags','account','nested','unready'])('refuses changed proposal %s before execute',async kind=>{
 const {p}=ports(),o=observation();
 if(kind==='template')o.template={};if(kind==='parameters')o.proposal!.Parameters=[];
 if(kind==='changes')(o.proposal!.Changes as Record<string,unknown>[]).pop();if(kind==='tags')o.proposal!.Tags=[];
 if(kind==='account')o.proposal!.ChangeSetId=String(o.proposal!.ChangeSetId).replace('588966314750','173535830222');
 if(kind==='nested')o.proposal!.IncludeNestedStacks=true;if(kind==='unready')o.proposal!.Status='CREATE_IN_PROGRESS';
 vi.mocked(p.observe).mockReset().mockResolvedValueOnce({stack:null,proposal:null,template:null,resources:[],function:null,routes:[],authorizers:[],integrations:[]}).mockResolvedValueOnce(o);
 await expect(runSuccessorFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.execute).not.toHaveBeenCalled();expect(p.custody.finish).not.toHaveBeenCalled();
});
it.each(['sourceCommit','zipSha256','templateSha256','targetSha256','parameterSha256','resourceReviewSha256','sqlPrivilegeReviewSha256','credentialReviewSha256','scope','phiAllowed'])('refuses changed or absent review %s',key=>{
 const review=JSON.parse(input.reviewBytes.toString());review[key]=key.endsWith('Sha256')?'0'.repeat(64):'changed';
 expect(()=>prepareSuccessorFullscriptDeployment({...input,reviewBytes:bytes(review)})).toThrow();
});
it.each(['code','version','environment','route','authorizer','integration','resources','stack'])('refuses incomplete deployed observation %s',kind=>{
 const o=observation(true);
 if(kind==='code')o.function!.CodeSha256='wrong';if(kind==='version')o.function!.Version='$LATEST';
 if(kind==='environment')((o.function!.Environment as Record<string,unknown>).Variables as Record<string,unknown>).PHI_ALLOWED='true';
 if(kind==='route')o.routes[0].AuthorizationType='NONE';if(kind==='authorizer')o.authorizers[0].JwtConfiguration={};
 if(kind==='integration')o.integrations[0].IntegrationUri=plan.target.target.functionArn;if(kind==='resources')o.resources.pop();if(kind==='stack')o.stack!.StackStatus='CREATE_IN_PROGRESS';
 expect(()=>verifySuccessorFullscriptDeployed(plan,o,now)).toThrow();
});
it('a failing live guard refuses before any control-plane mutation',async()=>{
 const {p}=ports();vi.mocked(p.guard).mockRejectedValue(Error('fictional changed SQL privileges'));
 await expect(runSuccessorFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.create).not.toHaveBeenCalled();expect(p.execute).not.toHaveBeenCalled();
});
it('an expired review can be inspected but cannot authorize a new write',async()=>{
 const {p}=ports();p.now=()=>now+25*60*60*1000;await expect(runSuccessorFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();expect(p.create).not.toHaveBeenCalled();
});


it('historical deployment preparation still refuses the actual successor artifacts',()=>{
 expect(()=>prepareFullscriptDeployment({...input,sourceCommit:input.source.sourceCommit,clean:true})).toThrow();
});
it.each(['sourceInputSha256','qualificationProfile','migrationCount','migrationReleaseSha256','migrationAssemblySha256','providerActionsAllowed'])('refuses a changed successor write review %s',key=>{
 const review=JSON.parse(input.reviewBytes.toString());review[key]='changed';expect(()=>prepareSuccessorFullscriptDeployment({...input,reviewBytes:bytes(review)})).toThrow();
});
it.each(['create','execute'])('an awaited guard cannot carry an expired review into %s admission',async stage=>{
 const {p,stages}=ports();let clock=now;p.now=()=>clock;
 vi.mocked(p.guard).mockImplementation(async()=>{if(stage==='create'||stages.includes('create_admitted'))clock=now+25*60*60*1000;});
 await expect(runSuccessorFullscriptDeployment(plan,p,'deploy')).rejects.toThrow();
 expect(stage==='create'?p.create:p.execute).not.toHaveBeenCalled();
 expect(stages).not.toContain(stage==='create'?'create_admitted':'execute_admitted');
});
