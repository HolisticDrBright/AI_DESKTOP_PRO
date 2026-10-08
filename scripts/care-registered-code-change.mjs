/** Registered-history code-change qualification. Pure verification, not an
 * AWS observer, execution permission or replacement for recovery/acceptance. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,assertCareRegisteredCurrent,verifyCareRegisteredCandidate,verifyCareRegisteredArtifactBinding,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {CARE_REGISTERED_PREDECESSOR as B,careRegisteredPredecessorTemplate,
 verifyCareRegisteredPredecessorControl} from './care-registered-preflight.mjs';
import {canonical,CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyRegisteredUploadPreflight} from './upload-synthetic-care-registered-release.mjs';
import {verifyCareCodeChangeSet,verifyExecutedCareCodeChangeSet} from './prepare-synthetic-care-code-change.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('proposal_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const keys=(o,names)=>o&&typeof o==='object'&&!Array.isArray(o)&&equal(Object.keys(o).sort(),[...names].sort());

export function careRegisteredCodeChangeInputs(sourceText,candidate,current,preflight,artifact,now){
 verifyRegisteredUploadPreflight(preflight,candidate,current,now);
 const input=careRegisteredCodeTemplateInputs(sourceText,candidate,current,artifact);
 check(sha256(canonical(careRegisteredPredecessorTemplate(JSON.parse(sourceText))))===preflight.control?.templateSha256,'predecessor_template');
 return input;
}
/** Static input binding only. Reconciliation must supply its own live reads;
 * this never establishes preflight freshness, write or execution admission. */
export function careRegisteredCodeTemplateInputs(sourceText,candidate,current,artifact){
 verifyCareRegisteredCandidate(candidate,current);
 check(typeof sourceText==='string'&&sha256(sourceText)===current.templateSha256,'source_template');
 let source;try{source=JSON.parse(sourceText);}catch{refuseRegistered('proposal_source_template');}
 const template=careRegisteredPredecessorTemplate(source);
 verifyCareRegisteredArtifactBinding(candidate,current,artifact);
 const names=Object.keys(template.Parameters);
 check(names.length===11&&names.includes('LambdaCodeKey'),'parameters');
 template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=artifact.versionId;
 return {template,parameters:names.map(ParameterKey=>ParameterKey==='LambdaCodeKey'
  ?{ParameterKey,ParameterValue:artifact.key}:{ParameterKey,UsePreviousValue:true})};
}

export function careRegisteredChangeSetBinding(input,current,artifact){
 assertCareRegisteredCurrent(current);
 const digest=sha256(canonical({contract:'care-registered-code-change-input/1',input,current,artifact}));
 return {digest,name:'care-registered-'+digest.slice(0,32),stackId:B.stackId};
}
/** AWS contexts are bounded JSON with unique keys at every depth. JSON.parse
 * alone silently overwrites duplicate fields and cannot establish a delta. */
export function parseRegisteredPropertyContext(text){
 check(typeof text==='string'&&Buffer.byteLength(text)>0&&Buffer.byteLength(text)<=65536,'property_context');
 let parsed;try{parsed=JSON.parse(text);}catch{refuseRegistered('proposal_property_context');}
 let at=0,nodes=0;
 const space=()=>{while(at<text.length&&/\s/.test(text[at]))at++;};
 const string=()=>{const match=/^"(?:\\[\s\S]|[^"\\])*"/.exec(text.slice(at));
  check(match,'property_context');at+=match[0].length;return JSON.parse(match[0]);};
 const value=depth=>{
  check(depth<=32&&++nodes<=10000,'property_context');space();const ch=text[at];
  if(ch==='{'){
   at++;space();const names=new Set();if(text[at]==='}'){at++;return;}
   for(;;){space();check(text[at]==='"','property_context');const name=string();
    check(!names.has(name),'duplicate_property_context');names.add(name);space();check(text[at++]===':','property_context');
    value(depth+1);space();if(text[at]==='}'){at++;return;}check(text[at++]===',','property_context');}
  }
  if(ch==='['){at++;space();if(text[at]===']'){at++;return;}
   for(;;){value(depth+1);space();if(text[at]===']'){at++;return;}check(text[at++]===',','property_context');}}
  if(ch==='"'){string();return;}
  const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
  check(match,'property_context');at+=match[0].length;
 };
 value(0);space();check(at===text.length,'property_context');return parsed;
}

/** Exhaust both raw inventories before isolating the Lambda for the shared
 * generic code-only checks. Never discard an arbitrary dependency or page. */
export function verifyCareRegisteredProposalViews(summary,detailed,actualTemplate,input,binding,raw,sourceText,preflight,current,candidate,artifact,now){
 const rebuilt=careRegisteredCodeChangeInputs(sourceText,candidate,current,preflight,artifact,now);
 check(equal(rebuilt,input),'inputs_changed');
 return verifyCareRegisteredUnexecutedProposalViews(summary,detailed,actualTemplate,input,binding,raw,sourceText,
  preflight.control,current,candidate,artifact,now);
}
/** Complete unexecuted projection verification only. The stopped-operation
 * observer independently binds the frozen application, clean current operator,
 * fresh database/control reads and custody. No archived report is authority. */
export function verifyCareRegisteredUnexecutedProposalViews(summary,detailed,actualTemplate,input,binding,raw,sourceText,expectedControl,current,candidate,artifact,now){
 return verifyRegisteredProjection(summary,detailed,actualTemplate,input,binding,raw,sourceText,expectedControl,current,candidate,artifact,now,'AVAILABLE');
}
/** Actual completed views are a distinct observation profile. Do not change
 * their state to AVAILABLE to reuse an unexecuted proposal receipt. */
export function verifyCareRegisteredExecutedProposalViews(summary,detailed,actualTemplate,input,binding,rawBefore,sourceText,expectedControl,current,candidate,artifact,now){
 return verifyRegisteredProjection(summary,detailed,actualTemplate,input,binding,rawBefore,sourceText,expectedControl,current,candidate,artifact,now,'EXECUTE_COMPLETE');
}
function verifyRegisteredProjection(summary,detailed,actualTemplate,input,binding,raw,sourceText,expectedControl,current,candidate,artifact,now,executionStatus){
 check(equal(careRegisteredCodeTemplateInputs(sourceText,candidate,current,artifact),input),'inputs_changed');
 const fixed=careRegisteredChangeSetBinding(input,current,artifact);
 check(binding?.stackId===fixed.stackId&&binding.name===fixed.name&&typeof binding.id==='string'
  &&new RegExp('^arn:aws:cloudformation:'+P.region+':'+P.account+':changeSet/'+fixed.name+'/[A-Za-z0-9-]{1,128}$').test(binding.id),'binding');
 const source=JSON.parse(sourceText),control=verifyCareRegisteredPredecessorControl(raw,source);
 check(equal(control,expectedControl),'control_changed');
 const metadata=set=>{const copy=structuredClone(set);delete copy.Changes;return copy;};
 const allowed=['StackId','StackName','ChangeSetName','ChangeSetId','Status','ExecutionStatus','Capabilities','NotificationARNs',
  'RollbackConfiguration','DeploymentConfig','Parameters','CreationTime','Description','Tags','IncludeNestedStacks','ImportExistingResources'];
 check(summary&&detailed&&Object.keys(summary).every(k=>k==='Changes'||allowed.includes(k))
  &&Object.keys(detailed).every(k=>k==='Changes'||allowed.includes(k))&&equal(metadata(summary),metadata(detailed))
  &&equal(summary.DeploymentConfig,{Mode:'STANDARD',DisableRollback:false})&&equal(summary.NotificationARNs,[])
  &&equal(summary.RollbackConfiguration,{})&&(!summary.Tags||equal(summary.Tags,[]))
  &&(!Object.hasOwn(summary,'IncludeNestedStacks')||summary.IncludeNestedStacks===false)
  &&(!Object.hasOwn(summary,'ImportExistingResources')||summary.ImportExistingResources===false),'metadata');
 check(summary.Description===`Registered synthetic code ${current.desktop.commit}; PHI off; no schema change`
  &&typeof summary.CreationTime==='string'&&Number.isFinite(Date.parse(summary.CreationTime))&&Date.parse(summary.CreationTime)<=now,'metadata_identity');
 check(Array.isArray(summary.Changes)&&summary.Changes.length===2&&Array.isArray(detailed.Changes)&&detailed.Changes.length===1,'resource_scope');
 const lambda={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'DirectModification'},
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'}]}};
 const dependency={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,
  ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}};
 check(equal(summary.Changes[0],lambda)&&equal(summary.Changes[1],dependency),'resource_scope');
 const integration={Type:'AWS::ApiGatewayV2::Integration',Properties:{ApiId:{Ref:'ClinicalApiId'},IntegrationType:'AWS_PROXY',
  IntegrationUri:{'Fn::GetAtt':['IdentityApiFunction','Arn']},PayloadFormatVersion:'2.0',TimeoutInMillis:30000}};
 check(equal(input.template.Resources.IdentityApiIntegration,integration),'integration_template');
 const verifySet=executionStatus==='AVAILABLE'?verifyCareCodeChangeSet:verifyExecutedCareCodeChangeSet;
 try{verifySet({...summary,Changes:[summary.Changes[0]]},actualTemplate,input,binding);
  verifySet(detailed,actualTemplate,input,binding);}catch{refuseRegistered('proposal_projection_scope');}
 const change=detailed.Changes[0].ResourceChange;
 check(keys(detailed.Changes[0],['Type','ResourceChange'])&&keys(change,['Action','LogicalResourceId','PhysicalResourceId',
  'ResourceType','Replacement','Scope','Details','BeforeContext','AfterContext']),'property_context_scope');
 const before=parseRegisteredPropertyContext(change.BeforeContext),after=parseRegisteredPropertyContext(change.AfterContext);
 const fn=raw.fn,properties={FunctionName:fn.FunctionName,Runtime:fn.Runtime,Architectures:fn.Architectures,Handler:fn.Handler,
  Role:fn.Role,MemorySize:String(fn.MemorySize),Timeout:String(fn.Timeout),LoggingConfig:fn.LoggingConfig,Environment:structuredClone(fn.Environment),
  Code:{S3Bucket:P.bucket,S3Key:candidate.release.predecessor.key,S3ObjectVersion:C.predecessorVersion}};
 properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='****';
 check(equal(before,{Properties:properties}),'predecessor_property_context');
 const expectedAfter=structuredClone(before);expectedAfter.Properties.Code={S3Bucket:P.bucket,S3Key:artifact.key,S3ObjectVersion:artifact.versionId};
 check(equal(after,expectedAfter),'non_code_context');
 const base=structuredClone(lambda.ResourceChange);delete base.Details;
 const without=structuredClone(change);delete without.Details;delete without.BeforeContext;delete without.AfterContext;
 check(equal(without,base)&&Array.isArray(change.Details)&&[2,3].includes(change.Details.length),'property_delta');
 const direct=key=>({Evaluation:'Static',ChangeSource:'DirectModification',Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never',
   Path:'/Properties/Code/'+key,BeforeValue:properties.Code[key],AfterValue:expectedAfter.Properties.Code[key],AttributeChangeType:'Modify'}});
 const version=direct('S3ObjectVersion'),key=direct('S3Key'),parameter={...key,ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'};
 // Actual AWS reports the Ref-valued key twice: dynamic direct evaluation
 // and static parameter evaluation. These are explanations, not two writes.
 // Accept only this exact complete projection (or the two fully evaluated
 // shapes), never arbitrary duplicate paths. Full before/after contexts above
 // independently establish that key and version are the only property changes.
 const inventory=details=>details.map(canonical).sort();
 check([[version,key],[version,parameter],[{...key,Evaluation:'Dynamic'},version,parameter]]
  .some(expected=>equal(inventory(change.Details),inventory(expected))),'property_delta');
 return {contract:executionStatus==='AVAILABLE'?'synthetic-care-registered-proposal-projection/1':'synthetic-care-registered-executed-projection/1',current:structuredClone(current),
  stackId:binding.stackId,changeSetId:binding.id,changeSetName:binding.name,summarySha256:sha256(canonical(summary)),
  propertyValuesSha256:sha256(canonical(detailed)),summaryResourceCount:2,propertyValuesResourceCount:1,
  affectedResources:['IdentityApiFunction','IdentityApiIntegration'],predecessorControl:control,
  integrationDependencyClassified:true,integrationNoOpProven:false,postExecutionReadbackRequired:true,
  compatibleRecoveryRequired:true,executionAdmissible:false,deployed:false,schemaChanged:false,
  hostedAcceptance:false,releaseAccepted:false,phiAllowed:false,paidMobileBuildStarted:false};
}
