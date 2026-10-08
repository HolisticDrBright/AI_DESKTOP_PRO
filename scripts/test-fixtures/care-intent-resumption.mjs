import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P,sha256} from '../synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from '../verify-deployed-synthetic-care.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from '../care-recovery-routing.mjs';
import {createCareIntentCandidate} from '../synthetic-care-intent-release.mjs';
import {careControlSource,careControlObservation} from './care-control.mjs';
import {careIntentContinuationFixture} from './care-intent-continuation.mjs';
export function careIntentResumptionFixture(){
 const f=careIntentContinuationFixture(),s=f.supplied,clone=structuredClone;
 const sourceText=readFileSync(new URL('../../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8').replaceAll('\r\n','\n');
 s.current.templateSha256=sha256(sourceText);
 s.candidate=createCareIntentCandidate(s.current,s.candidate.bundle);
 const application=clone(s.current),operator=clone(application);operator.desktop.commit='d'.repeat(40);
 operator.desktop.sha256='e'.repeat(64);operator.mobile.source.commit='f'.repeat(40);operator.mobile.source.sha256='0'.repeat(64);
 const b=s.deployment.before,raw=careControlObservation();raw.stack.Stacks[0].StackName=P.stack;
 const predecessor={configuration:{...clone(raw.fn),FunctionArn:R.retainedArn,Version:'1'},
  download:{sha256:D.zip,bytes:D.bytes,exactBytesVerified:true}};
 // A fictional observer receipt is not an actual AWS download. The live
 // command separately hashes the managed stream before creating this witness.
 s.artifact={...s.artifact,key:s.candidate.manifest.key,sha256:s.candidate.manifest.zipSha256,bytes:s.candidate.zip.length};
 b.input.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=s.artifact.versionId;
 b.input.parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=s.candidate.manifest.key;
 for(const view of [b.summary,b.detailed]){
  view.ExecutionStatus='EXECUTE_COMPLETE';
  view.Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=s.candidate.manifest.key;
 }
 const name='care-intent-'+sha256(canonical({input:b.input,desktop:s.candidate.manifest.desktop,
  mobile:s.candidate.manifest.mobile,profile:'explicit-integration-arn-dependency/1'})).slice(0,32);
 b.binding.name=name;b.binding.id=`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${name}/fictional`;
 for(const view of [b.summary,b.detailed]){view.ChangeSetName=name;view.ChangeSetId=b.binding.id;}
 const before=clone(b.before),after=clone(b.after);
 before.Properties.Role=raw.fn.Role;after.Properties.Role=raw.fn.Role;
 after.Properties.Code.S3Key=s.candidate.manifest.key;
 b.detailed.Changes[0].ResourceChange.BeforeContext=JSON.stringify(before);
 b.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(after);
 for(const detail of b.detailed.Changes[0].ResourceChange.Details)
  detail.Target.AfterValue=after.Properties.Code[detail.Target.Path.split('/').at(-1)];
 raw.template=clone(b.input.template);raw.stack.Stacks[0].Parameters=clone(b.summary.Parameters);
 raw.fn.RevisionId='new-revision';raw.fn.CodeSize=s.candidate.zip.length;
 raw.fn.CodeSha256=Buffer.from(s.candidate.manifest.zipSha256,'hex').toString('base64');
 const priorResources=raw.resources.StackResources;
 raw.resources.StackResources=Object.entries(raw.template.Resources).map(([LogicalResourceId,r])=>
  priorResources.find(p=>p.LogicalResourceId===LogicalResourceId)??{LogicalResourceId,ResourceType:r.Type,ResourceStatus:'CREATE_COMPLETE',
   PhysicalResourceId:LogicalResourceId==='IdentityApiFunction'?P.functionName:LogicalResourceId==='IdentityApiIntegration'?R.integrationId:'fictional-'+LogicalResourceId});
 raw.stage=clone(s.deployment.after.stage);raw.stage.DeploymentId='returned';
 const retained={configuration:{...clone(raw.fn),FunctionArn:R.latestArn+':2',Version:'2',
  Description:`ALP synthetic intent ${application.desktop.commit} ${s.candidate.manifest.zipSha256} PHI=off`},codeBytes:s.candidate.zip};
 s.deployment={contract:'synthetic-care-intent-resumption-observations/1',observedAt:s.deployment.observedAt,
  applicationCurrent:clone(application),operatorCurrent:clone(operator),source:careControlSource,sourceText,raw,artifact:s.artifact,
  binding:b.binding,summary:b.summary,detailed:b.detailed,proposedTemplate:b.input.template,
  predecessor,retained,retainedPolicy:null,codeBytes:s.candidate.zip};
 s.operatorCurrent=operator;s.baseline=clone(s.preparation.database);s.baseline.operatorSource.sourceCommit=operator.desktop.commit;
 s.recovery.current=clone(application);s.recovery.zipSha256=s.candidate.manifest.zipSha256;
 s.recovery.databaseBefore=clone(s.baseline);s.recovery.databaseAfter=clone(s.baseline);
 s.recovery.retained=clone(retained);s.recovery.retained.codeBytes=s.candidate.zip;
 f.d.current=async()=>{f.calls.push('current');return clone(operator);};
 const schema=f.d.schema;
 f.d.schema=async command=>{const r=await schema(command);r.operatorSource.sourceCommit=operator.desktop.commit;return r;};
 return {...f,application,operator};
}
