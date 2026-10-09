/** Fictional proposal views only; never imported by public AWS operators. */
import {CARE_RELEASE as P} from '../synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R} from '../care-recovery-routing.mjs';
import {catalogRuntimeControlFixture} from './catalog-runtime-control.mjs';
import {catalogRuntimeCodeChangeInputs,catalogRuntimeChangeSetBinding} from '../catalog-runtime-code-change.mjs';
export function catalogRuntimeProposalFixture(){
 const f=catalogRuntimeControlFixture(),{raw,artifact}=f;
 f.input=catalogRuntimeCodeChangeInputs(f.sourceText,f.candidate,f.current,f.preflight,artifact,f.now);
 const fixed=catalogRuntimeChangeSetBinding(f.input,f.current,artifact);
 f.binding={...fixed,id:`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${fixed.name}/fictional-id`};
 const lambda={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'DirectModification'},
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'}]}};
 const dependency={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,
  ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}};
 const params=structuredClone(raw.stack.Stacks[0].Parameters);params.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=artifact.key;
 f.summary={StackId:fixed.stackId,StackName:P.stack,ChangeSetName:fixed.name,ChangeSetId:f.binding.id,
  Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',Capabilities:['CAPABILITY_IAM'],NotificationARNs:[],RollbackConfiguration:{},
  DeploymentConfig:{Mode:'STANDARD',DisableRollback:false},Parameters:params,Changes:[lambda,dependency]};
 f.summary.Description=`Catalog runtime synthetic code ${f.current.desktop.commit}; PHI off; no schema change`;
 f.summary.CreationTime=new Date(f.now).toISOString();
 f.detailed=structuredClone(f.summary);f.detailed.Changes=[structuredClone(lambda)];
 const fn=raw.fn;
 f.before={Properties:{FunctionName:fn.FunctionName,Runtime:fn.Runtime,Architectures:fn.Architectures,Handler:fn.Handler,Role:fn.Role,
  MemorySize:String(fn.MemorySize),Timeout:String(fn.Timeout),LoggingConfig:fn.LoggingConfig,Environment:structuredClone(fn.Environment),
  Code:{S3Bucket:P.bucket,S3Key:f.candidate.release.predecessor.key,S3ObjectVersion:f.candidate.release.predecessor.version}}};
 f.before.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='****';
 f.after=structuredClone(f.before);f.after.Properties.Code={S3Bucket:P.bucket,S3Key:artifact.key,S3ObjectVersion:artifact.versionId};
 const change=f.detailed.Changes[0].ResourceChange;
 change.BeforeContext=JSON.stringify(f.before);change.AfterContext=JSON.stringify(f.after);
 change.Details=['S3ObjectVersion','S3Key'].map(key=>({Evaluation:'Static',ChangeSource:'DirectModification',Target:{
  Attribute:'Properties',Name:'Code',RequiresRecreation:'Never',Path:'/Properties/Code/'+key,
  BeforeValue:f.before.Properties.Code[key],AfterValue:f.after.Properties.Code[key],AttributeChangeType:'Modify'}}));
 return f;
}
