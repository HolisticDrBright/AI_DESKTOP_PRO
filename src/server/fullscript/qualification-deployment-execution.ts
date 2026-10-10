if (typeof window !== 'undefined') throw Error('Fullscript deployment is server-only.');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {preflightFullscriptDeployment} from './qualification-deployment-preflight';

export const deploymentCanonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(deploymentCanonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+deploymentCanonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export const deploymentDigest=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const hash=z.string().regex(/^(?!0{64}$)[a-f0-9]{64}$/);
const reviewSchema=z.object({contract:z.literal('fullscript-qualification-deployment-review/1'),reviewer:z.literal('Brandon Bright'),
 reviewedAt:z.string().datetime(),decision:z.literal('approved'),scope:z.literal('create-one-fictional-fullscript-stack-only'),
 sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),zipSha256:hash,templateSha256:hash,targetSha256:hash,parameterSha256:hash,
 stackName:z.string().regex(/^alp-fullscript-qualification-[a-z0-9-]{1,30}$/),runId:z.string().regex(/^[a-f0-9]{32}$/),
 resourceReviewSha256:hash,sqlPrivilegeReviewSha256:hash,credentialReviewSha256:hash,
 phiAllowed:z.literal(false),activation:z.literal('blocked'),providerActionsAllowed:z.literal(false)}).strict();
export type DeploymentInput=Parameters<typeof preflightFullscriptDeployment>[0]&{reviewBytes:Buffer};
export type DeploymentPlan=ReturnType<typeof prepareFullscriptDeployment>;
const fail=():never=>{throw Error('fullscript_deployment_execution_refused');};
const check=(v:unknown)=>{if(!v)fail();};
export function prepareFullscriptDeployment(input:DeploymentInput){
 try{
  const p=preflightFullscriptDeployment(input);
  check(input.reviewBytes.length>0&&input.reviewBytes.length<=16384);
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.reviewBytes));
  check(Buffer.from(deploymentCanonical(raw)+'\n').equals(input.reviewBytes));
  const review=reviewSchema.parse(raw),now=input.now??Date.now();
  check(Date.parse(review.reviewedAt)<=now
   &&(['sourceCommit','zipSha256','templateSha256','targetSha256','parameterSha256'] as const).every(k=>review[k]===p[k]));
  const parameters=JSON.parse(input.parameterBytes.toString()) as {ParameterKey:string;ParameterValue:string}[];
  const template=JSON.parse(input.templateBytes.toString()) as {Resources:Record<string,{Type:string}>};
  return {contract:'fullscript-deployment-plan/1' as const,review,reviewSha256:deploymentDigest(input.reviewBytes),
   parameters,templateBody:input.templateBytes.toString(),target:JSON.parse(input.targetBytes.toString()),
   resources:Object.entries(template.Resources).map(([LogicalResourceId,r])=>({LogicalResourceId,ResourceType:r.Type})),
   changeSetName:'fullscript-'+review.runId,clientToken:'fullscript-'+review.runId,
   sourceCommit:p.sourceCommit,zipSha256:p.zipSha256,targetSha256:p.targetSha256,parameterSha256:p.parameterSha256,
   templateSha256:p.templateSha256,providerActionsAllowed:false as const,phiAllowed:false as const,activation:'blocked' as const};
 }catch{return fail();}
}
type Obj=Record<string,unknown>;
export type DeploymentObservation={stack:Obj|null;proposal:Obj|null;template:unknown;resources:Obj[];
 function:Obj|null;routes:Obj[];authorizers:Obj[];integrations:Obj[]};
export type DeploymentStage='create_admitted'|'create_observed'|'execute_admitted'|'settled';
export type DeploymentMode='deploy'|'resume-unadmitted'|'execute-prepared'|'observe';
export interface DeploymentPorts{
 now():number;
 // Must reread current source/review/artifacts and reobserve actual STS and
 // prerequisites. A persisted report or an environment boolean is not a port.
 guard(plan:DeploymentPlan):Promise<void>;
 custody:{verify():Promise<void>;stages():DeploymentStage[];record(stage:DeploymentStage):Promise<void>;finish(report:unknown):Promise<void>};
 observe(plan:DeploymentPlan):Promise<DeploymentObservation>;
 create(plan:DeploymentPlan):Promise<void>;
 execute(plan:DeploymentPlan,stackId:string,changeSetId:string):Promise<void>;
}
const same=(a:unknown,b:unknown)=>deploymentCanonical(a)===deploymentCanonical(b);
function parameters(value:unknown){check(Array.isArray(value));return (value as Obj[]).map(p=>({ParameterKey:p.ParameterKey,ParameterValue:p.ParameterValue}))
 .sort((a,b)=>String(a.ParameterKey).localeCompare(String(b.ParameterKey)));}
function arn(value:unknown,kind:'stack'|'changeSet',name:string){
 check(typeof value==='string'&&new RegExp('^arn:aws:cloudformation:us-east-2:588966314750:'+kind+'/'+name+'/[a-f0-9-]{36}$').test(value));return value as string;
}
function verifyProposal(plan:DeploymentPlan,o:DeploymentObservation,now:number){
 const p=o.proposal,s=o.stack;check(p&&s);
 const stackId=arn(s!.StackId,'stack',plan.review.stackName),id=arn(p!.ChangeSetId,'changeSet',plan.changeSetName);
 check(p!.StackId===stackId&&p!.StackName===plan.review.stackName&&p!.ChangeSetName===plan.changeSetName
  &&p!.Status==='CREATE_COMPLETE'
  &&same(p!.Capabilities,['CAPABILITY_IAM'])
  &&same(parameters(p!.Parameters),parameters(plan.parameters))
  &&p!.RoleARN===undefined&&s!.RoleARN===undefined&&p!.NextToken===undefined
  &&same(p!.Tags,[{Key:'FullscriptDeploymentReview',Value:plan.reviewSha256}])
  &&p!.ImportExistingResources!==true&&p!.IncludeNestedStacks!==true&&p!.ParentChangeSetId===undefined&&p!.RootChangeSetId===undefined
  &&p!.DeploymentMode===undefined&&same(o.template,JSON.parse(plan.templateBody)));
 const created=Date.parse(String(p!.CreationTime));check(Number.isFinite(created)&&created>=Date.parse(plan.review.reviewedAt)&&created<=now);
 check(Array.isArray(p!.Changes));const changes=(p!.Changes as Obj[]).map(raw=>{
  const r=raw.ResourceChange as Obj;check(raw.Type==='Resource'&&r&&r.Action==='Add'&&r.PhysicalResourceId===undefined
   &&(r.Replacement===undefined||r.Replacement==='False')&&r.ChangeSetId===undefined);
  return {LogicalResourceId:r.LogicalResourceId,ResourceType:r.ResourceType};
 });
 const sort=(a:unknown[])=>[...a].sort((x,y)=>deploymentCanonical(x).localeCompare(deploymentCanonical(y)));
 check(same(sort(changes),sort(plan.resources)));return {stackId,changeSetId:id};
}
export function verifyFullscriptDeployed(plan:DeploymentPlan,o:DeploymentObservation,now:number){
 const ids=verifyProposal(plan,o,now),p=o.proposal!,s=o.stack!,fn=o.function;
 check(p.ExecutionStatus==='EXECUTE_COMPLETE'&&s.StackStatus==='CREATE_COMPLETE'&&fn
  &&o.resources.length===plan.resources.length&&same(s.Capabilities,['CAPABILITY_IAM'])
  &&same(parameters(s.Parameters),parameters(plan.parameters))&&same(s.Tags,[{Key:'FullscriptDeploymentReview',Value:plan.reviewSha256}]));
 for(const resource of plan.resources){
  const matches=o.resources.filter(r=>r.LogicalResourceId===resource.LogicalResourceId);
  check(matches.length===1&&matches[0].ResourceType===resource.ResourceType&&matches[0].ResourceStatus==='CREATE_COMPLETE'
   &&typeof matches[0].PhysicalResourceId==='string'&&String(matches[0].PhysicalResourceId).length>0);
 }
 const physical=(id:string)=>String(o.resources.find(r=>r.LogicalResourceId===id)!.PhysicalResourceId);
 const versionArn=physical('Version'),target=plan.target.target as Obj;
 check(new RegExp('^'+String(target.functionArn)+':[1-9][0-9]*$').test(versionArn)
  &&fn!.FunctionArn===versionArn&&fn!.CodeSha256===target.codeSha256&&fn!.Version===versionArn.split(':').at(-1)
  &&fn!.State==='Active'&&fn!.LastUpdateStatus==='Successful'&&fn!.Runtime==='nodejs22.x'
  &&fn!.Handler==='index.handler'&&fn!.Timeout===30&&fn!.MemorySize===512&&fn!.Role==='arn:aws:iam::588966314750:role/'+physical('Role'));
 const env=(fn!.Environment as Obj)?.Variables as Obj,values=Object.fromEntries(plan.parameters.map(r=>[r.ParameterKey,r.ParameterValue]));
 const expected={NODE_ENV:'production',PHI_ALLOWED:'false',PRODUCTION_ACTIVATION:'blocked',QUALIFICATION_EXECUTION:'true',QUALIFICATION_ACCOUNT_ID:'588966314750',
  FULLSCRIPT_SOURCE_COMMIT:plan.sourceCommit,FULLSCRIPT_TARGET_BUCKET:'alp-qualification-code-588966314750-us-east-2',FULLSCRIPT_TARGET_KEY:values.TargetKey,
  FULLSCRIPT_TARGET_VERSION:values.TargetObjectVersion,QUALIFICATION_REVIEW_SHA256:values.TargetReviewSha256,CLINICAL_DATABASE_NAME:values.DatabaseName,
  CLINICAL_DATABASE_CLUSTER_ARN:values.DatabaseClusterArn,CLINICAL_DATABASE_SECRET_ARN:values.DatabaseSecretArn,FULLSCRIPT_PROVIDER_SECRET_ARN:values.ProviderSecretArn,
  FULLSCRIPT_PROVIDER_SECRET_VERSION:values.ProviderSecretVersion,FULLSCRIPT_TOKEN_TABLE:values.TokenTableName,FULLSCRIPT_REDIRECT_URI:values.RedirectUri};
 check(same(env,expected));
 for(const role of ['Consumer','Workforce']){
  const route=o.routes.filter(r=>r.RouteId===physical(role+'Route')),auth=o.authorizers.filter(r=>r.AuthorizerId===physical(role+'Authorizer'));
  check(route.length===1&&auth.length===1&&route[0].RouteKey===`POST /clinical-core/${role.toLowerCase()}/fullscript/draft`
   &&route[0].AuthorizationType==='JWT'&&route[0].AuthorizerId===physical(role+'Authorizer')&&route[0].Target==='integrations/'+physical('Integration')
   &&auth[0].AuthorizerType==='JWT'&&same(auth[0].IdentitySource,['$request.header.Authorization'])
   &&same(auth[0].JwtConfiguration,{Issuer:target[role.toLowerCase()+'Issuer'],Audience:[values[role+'Audience']]}));
 }
 const integration=o.integrations.filter(r=>r.IntegrationId===physical('Integration'));
 check(integration.length===1&&integration[0].IntegrationType==='AWS_PROXY'&&integration[0].PayloadFormatVersion==='2.0'&&integration[0].IntegrationUri===versionArn);
 return {contract:'fullscript-deployment-observation/1',...ids,sourceCommit:plan.sourceCommit,reviewSha256:plan.reviewSha256,
   publishedVersion:fn!.Version,deployed:true,codeAndRoutesObserved:true,controlPlaneObserved:true,
   iamQualified:false,alarmsQualified:false,sqlQualified:false,hostedQualified:false,providerActionPerformed:false,phiAllowed:false,activation:'blocked'};
}
/** One new stack only. Writes are admitted durably BEFORE dispatch. An unknown
 * reply or an observation timeout leaves custody outstanding. Recovery is
 * read-only and never creates, executes, rolls back or deletes anything. */
export async function runFullscriptDeployment(plan:DeploymentPlan,port:DeploymentPorts,mode:DeploymentMode){
 plan=structuredClone(plan);
 const observe=async()=>structuredClone(await port.observe(structuredClone(plan)));
 const guard=async()=>{await port.custody.verify();await port.guard(structuredClone(plan));};
 try{
  await guard();let o=await observe();
  if(mode==='observe'){
   const report=verifyFullscriptDeployed(plan,o,port.now());await guard();
   check(port.custody.stages().includes('execute_admitted'));await port.custody.finish(report);return report;
  }
  check(port.now()-Date.parse(plan.review.reviewedAt)<=24*60*60*1000);
  if(mode==='deploy'||mode==='resume-unadmitted'){
   check(port.custody.stages().length===0&&o.stack===null&&o.proposal===null&&o.function===null&&o.resources.length===0);
   check(!o.routes.some(r=>r.RouteKey==='POST /clinical-core/consumer/fullscript/draft'||r.RouteKey==='POST /clinical-core/workforce/fullscript/draft'));
   await guard();await port.custody.record('create_admitted');await port.create(structuredClone(plan));o=await observe();
  }else check(mode==='execute-prepared'&&port.custody.stages().includes('create_admitted')&&!port.custody.stages().includes('execute_admitted'));
  const ids=verifyProposal(plan,o,port.now());
  check(o.stack!.StackStatus==='REVIEW_IN_PROGRESS'&&o.proposal!.ExecutionStatus==='AVAILABLE'&&o.resources.length===0);
  check(!o.routes.some(r=>r.RouteKey==='POST /clinical-core/consumer/fullscript/draft'||r.RouteKey==='POST /clinical-core/workforce/fullscript/draft'));
  await guard();if(!port.custody.stages().includes('create_observed'))await port.custody.record('create_observed');
  await port.custody.record('execute_admitted');
  await port.execute(structuredClone(plan),ids.stackId,ids.changeSetId);
  o=await observe();const report=verifyFullscriptDeployed(plan,o,port.now());
  await guard();await port.custody.record('settled');await port.custody.finish(report);return report;
 }catch{return fail();}
}
