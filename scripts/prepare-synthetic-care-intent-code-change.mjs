/** Prepare and inspect exactly one Lambda Code modification. This command never executes it. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P,normalizedText,sha256} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {verifyCareCodeChangeSet} from './prepare-synthetic-care-code-change.mjs';
import {runCareIntentUpload,verifyIntentUploadPreparation,intentFailureCode} from './upload-synthetic-care-intent-release.mjs';
import {collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
export function careIntentCodeChangeInputs(source,preparation,manifest,artifact,current){
 verifyIntentUploadPreparation(preparation,manifest,current);
 const expected=structuredClone(source);
 for(const name of P.absentRoutes){if(!expected.Resources?.[name])refuseIntent('source_routes');delete expected.Resources[name];}
 expected.Outputs.RoutesEnabled.Value='51';
 expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 if(sha256(canonical(expected))!==preparation.control.templateSha256
  ||artifact?.bucket!==P.bucket||artifact.key!==manifest.key||artifact.sha256!==manifest.zipSha256
  ||artifact.bytes!==manifest.zipBytes||artifact.exactVersionReadbackVerified!==true
  ||artifact.encryption!=='aws:kms'||artifact.kmsKeyArn!==P.keyArn
  ||typeof artifact.versionId!=='string'||!artifact.versionId||artifact.versionId==='null'||artifact.versionId.length>1024)
  refuseIntent('code_change_inputs');
 const names=Object.keys(expected.Parameters);
 if(names.length!==11||!names.includes('LambdaCodeKey'))refuseIntent('code_change_parameters');
 expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=artifact.versionId;
 return {template:expected,parameters:names.map(ParameterKey=>ParameterKey==='LambdaCodeKey'
  ?{ParameterKey,ParameterValue:manifest.key}:{ParameterKey,UsePreviousValue:true})};
}
/** Neither projection may hide another affected resource. Property contexts
 * must prove the exact code-key/version delta, not just a target named Code. */
export function verifyCareIntentChangeSetViews(summary,detailed,actualTemplate,input,binding){
 try{
  verifyCareCodeChangeSet(summary,actualTemplate,input,binding);
  verifyCareCodeChangeSet(detailed,actualTemplate,input,binding);
 }catch{refuseIntent('proposal_projection_scope');}
 const change=detailed.Changes[0].ResourceChange;
 let before,after;
 try{
  if(typeof change.BeforeContext!=='string'||typeof change.AfterContext!=='string'
   ||Buffer.byteLength(change.BeforeContext)>65536||Buffer.byteLength(change.AfterContext)>65536)throw new Error();
  before=JSON.parse(change.BeforeContext);after=JSON.parse(change.AfterContext);
 }catch{refuseIntent('proposal_property_context');}
 const oldKey=`clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`;
 const newKey=input.parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue;
 const newVersion=input.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion;
 const expectedOld={S3Bucket:P.bucket,S3Key:oldKey,S3ObjectVersion:D.version};
 const expectedNew={S3Bucket:P.bucket,S3Key:newKey,S3ObjectVersion:newVersion};
 if(!before||!after||canonical(Object.keys(before))!==canonical(['Properties'])
  ||canonical(Object.keys(after))!==canonical(['Properties'])
  ||before.Properties?.FunctionName!==P.functionName||after.Properties?.FunctionName!==P.functionName
  ||canonical(before.Properties.Code)!==canonical(expectedOld)||canonical(after.Properties.Code)!==canonical(expectedNew))
  refuseIntent('proposal_property_context');
 const restored=structuredClone(after);restored.Properties.Code=before.Properties.Code;
 if(canonical(restored)!==canonical(before))refuseIntent('proposal_non_code_context');
 const changes=new Set();
 for(const item of change.Details){
  const t=item.Target,path=t.Path;
  const version=path==='/Properties/Code/S3ObjectVersion',key=path==='/Properties/Code/S3Key';
  if(!version&&!key||t.AttributeChangeType!=='Modify'
   ||t.BeforeValue!==(version?D.version:oldKey)||t.AfterValue!==(version?newVersion:newKey)
   ||!['Static','Dynamic'].includes(item.Evaluation)
   ||version&&(item.ChangeSource!=='DirectModification'||item.Evaluation!=='Static')
   ||key&&item.ChangeSource==='ParameterReference'&&(item.CausingEntity!=='LambdaCodeKey'||item.Evaluation!=='Static'))
   refuseIntent('proposal_property_delta');
  changes.add(path);
 }
 if(changes.size!==2)refuseIntent('proposal_property_delta');
 return {summarySha256:sha256(canonical(summary)),propertyValuesSha256:sha256(canonical(detailed)),
  summaryResourceCount:summary.Changes.length,propertyValuesResourceCount:detailed.Changes.length};
}
function aws(args){
 try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}));}
 catch{refuseIntent('code_change_aws_unconfirmed');}
}
export async function proposeCareIntentCodeChange(root,directory,context){
 const {candidate,current,artifact,preparation,unchanged,record,admit}=context;
 const manifest=candidate.manifest,source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
 const input=careIntentCodeChangeInputs(source,preparation,manifest,artifact,current);
 unchanged();observeSyntheticMemberIdentity();
 const stack=aws(['cloudformation','describe-stacks','--stack-name',P.stack]);
 const stackId=stack.Stacks?.[0]?.StackId;
 if(stack.Stacks?.length!==1||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.Stacks[0].StackStatus)
  ||!stackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/`))refuseIntent('proposal_stack');
 const digest=sha256(canonical({input,desktop:manifest.desktop,mobile:manifest.mobile})),name='care-intent-'+digest.slice(0,32);
 const out=resolve(directory,'change-sets',digest);mkdirSync(out,{recursive:true});
 for(const [file,data] of [['template.json',input.template],['parameters.json',input.parameters]]){
  const bytes=JSON.stringify(data,null,2)+'\n',path=resolve(out,file);
  try{writeFileSync(path,bytes,{flag:'wx'});}catch{if(readFileSync(path,'utf8')!==bytes)refuseIntent('proposal_collision');}
 }
 // Observe the complete listing before admitting a create. A repeat verifies
 // the same existing proposal; unknown creation is never blindly replayed.
 const found=collectCancellationInventory(aws,['cloudformation','list-change-sets','--stack-name',stackId],'Summaries','NextToken')
  .Summaries.filter(s=>s.ChangeSetName===name);
 if(found.length>1)refuseIntent('proposal_ambiguous');
 let id=found[0]?.ChangeSetId;
 if(!id){
  unchanged();observeSyntheticMemberIdentity();verifyIntentUploadPreparation(preparation,manifest,current);
  admit({stage:'change_set_create_admitted',stackId,name,clientToken:digest});
  const created=aws(['cloudformation','create-change-set','--stack-name',stackId,'--change-set-name',name,
   '--change-set-type','UPDATE','--client-token',digest,'--capabilities','CAPABILITY_IAM',
   '--description',`Synthetic intent code only ${manifest.desktop.commit}; PHI off; no schema change`,
   '--template-body',`file://${resolve(out,'template.json').replaceAll('\\','/')}`,
   '--parameters',`file://${resolve(out,'parameters.json').replaceAll('\\','/')}`]);
  if(created.StackId!==stackId)refuseIntent('created_proposal');id=created.Id;
 }
 if(typeof id!=='string'||!id.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${name}/`))refuseIntent('proposal_identity');
 record({stage:'change_set_observed',stackId,name,id,reused:found.length===1});
 let set;
 for(let n=0;n<20;n++){
  set=aws(['cloudformation','describe-change-set','--stack-name',stackId,'--change-set-name',id,'--include-property-values','--no-paginate']);
  if(!['CREATE_PENDING','CREATE_IN_PROGRESS'].includes(set.Status))break;
  await new Promise(done=>setTimeout(done,2000));
 }
 const raw=aws(['cloudformation','get-template','--stack-name',stackId,'--change-set-name',id,'--template-stage','Original']).TemplateBody;
 const summary=aws(['cloudformation','describe-change-set','--stack-name',stackId,'--change-set-name',id,'--no-include-property-values','--no-paginate']);
 record({stage:'change_set_projection_readback',summaryResourceCount:summary.Changes?.length??null,
  propertyValuesResourceCount:set.Changes?.length??null,summarySha256:sha256(canonical(summary)),propertyValuesSha256:sha256(canonical(set))});
 const projections=verifyCareIntentChangeSetViews(summary,set,typeof raw==='string'?JSON.parse(raw):raw,input,{stackId,name,id});unchanged();
 const report={contract:'synthetic-care-intent-code-change/1',observedAt:new Date().toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,desktop:current.desktop,mobile:current.mobile,
  artifact,preparation,projections,stackId,changeSetId:id,changeSetName:name,templateSha256:sha256(canonical(input.template)),
  changeSetCreated:found.length===0,reused:found.length===1,verifiedChange:'one existing Lambda Code property only',
  changeSetExecutionStatus:set.ExecutionStatus,deployed:false,schemaChanged:false,canonicalRegistered:false,
  freshCompatibleRecoveryPerformed:false,hostedAcceptance:false,paidMobileBuildStarted:false,phiAllowed:false};
 const file=resolve(out,sha256(canonical(report))+'.json');writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 record({stage:'change_set_verified_unexecuted',report:file});return {report:file,...report};
}
async function main(){
 const a=process.argv.slice(2);
 if(a.length!==5||a[0]!=='--v2-root'||a[2]!=='--candidate'||a[4]!=='--prepare-fictional-intent-code-change-only'
  ||a[1].startsWith('--')||a[3].startsWith('--'))refuseIntent('arguments');
 const root=process.cwd(),directory=resolve(a[3]);
 console.log(JSON.stringify(await runCareIntentUpload(root,resolve(a[1]),directory,c=>proposeCareIntentCodeChange(root,directory,c))));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error(intentFailureCode(error));process.exitCode=1;});
}
