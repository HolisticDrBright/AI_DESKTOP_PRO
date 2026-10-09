/** Fictional complete before/after deployment views. Not AWS evidence. */
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from '../synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R} from '../care-recovery-routing.mjs';
import {careRegisteredControlFixture} from './care-registered-control.mjs';
import {careRegisteredCodeTemplateInputs,careRegisteredChangeSetBinding} from '../care-registered-code-change.mjs';
export function careRegisteredDeploymentFixture(){
 const f=careRegisteredControlFixture(),input=careRegisteredCodeTemplateInputs(f.sourceText,f.candidate,f.current,f.artifact),
  fixed=careRegisteredChangeSetBinding(input,f.current,f.artifact),binding={...fixed,
   id:`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${fixed.name}/fictional-id`};
 const lambda={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'DirectModification'},
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'}]}};
 const dependency={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,
  ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}};
 const params=structuredClone(f.raw.stack.Stacks[0].Parameters);params.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=f.artifact.key;
 const summary={StackId:fixed.stackId,StackName:P.stack,ChangeSetName:fixed.name,ChangeSetId:binding.id,
  Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',Capabilities:['CAPABILITY_IAM'],NotificationARNs:[],RollbackConfiguration:{},
  DeploymentConfig:{Mode:'STANDARD',DisableRollback:false},Parameters:params,Changes:[lambda,dependency],
  Description:`Registered synthetic code ${f.current.desktop.commit}; PHI off; no schema change`,CreationTime:new Date(f.now).toISOString()};
 const detailed=structuredClone(summary);detailed.Changes=[structuredClone(lambda)];
 const fn=f.raw.fn,properties={FunctionName:fn.FunctionName,Runtime:fn.Runtime,Architectures:fn.Architectures,Handler:fn.Handler,
  Role:fn.Role,MemorySize:String(fn.MemorySize),Timeout:String(fn.Timeout),LoggingConfig:fn.LoggingConfig,Environment:structuredClone(fn.Environment),
  Code:{S3Bucket:P.bucket,S3Key:f.candidate.release.predecessor.key,S3ObjectVersion:f.candidate.release.predecessor.version}};
 properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='****';
 const afterProperties=structuredClone(properties);afterProperties.Code={S3Bucket:P.bucket,S3Key:f.artifact.key,S3ObjectVersion:f.artifact.versionId};
 const c=detailed.Changes[0].ResourceChange;c.BeforeContext=JSON.stringify({Properties:properties});c.AfterContext=JSON.stringify({Properties:afterProperties});
 c.Details=['S3ObjectVersion','S3Key'].map(key=>({Evaluation:'Static',ChangeSource:'DirectModification',Target:{Attribute:'Properties',Name:'Code',
  RequiresRecreation:'Never',Path:'/Properties/Code/'+key,BeforeValue:properties.Code[key],AfterValue:afterProperties.Code[key],AttributeChangeType:'Modify'}}));
 // A published inspection is test material only; production must observe the
 // actual compiled inspector, not load this or any caller-provided receipt.
 const database=JSON.parse(readFileSync(new URL('../../docs/evidence/2026-10-08-care-intent-canonical-registration.json',import.meta.url),'utf8')).inspection;
 database.operatorSource={sourceCommit:f.current.desktop.commit,clean:true};database.observedAt=new Date(f.now).toISOString();
 const before={observedAt:new Date(f.now).toISOString(),raw:structuredClone(f.raw),database,input,binding,summary,detailed,template:input.template};
 const after=structuredClone({observedAt:new Date(f.now+30000).toISOString(),raw:before.raw,database,summary,detailed,template:input.template});
 after.database.observedAt=after.observedAt;
 after.raw.template=structuredClone(input.template);after.raw.stack.Stacks[0].Parameters=structuredClone(params);
 after.raw.fn.CodeSha256=Buffer.from(f.candidate.manifest.zipSha256,'hex').toString('base64');after.raw.fn.CodeSize=f.candidate.zip.length;
 after.raw.fn.RevisionId='fictional-new-revision';
 after.summary.ExecutionStatus='EXECUTE_COMPLETE';after.detailed.ExecutionStatus='EXECUTE_COMPLETE';
 const witness={contract:'synthetic-care-registered-deployment-observation/1',current:f.current,artifact:f.artifact,
  executionAdmittedAt:new Date(f.now+1000).toISOString(),before,after,codeBytes:Buffer.from(f.candidate.zip)};
 return {...f,before,after,witness,started:f.now-1000,completed:f.now+30000};
}
