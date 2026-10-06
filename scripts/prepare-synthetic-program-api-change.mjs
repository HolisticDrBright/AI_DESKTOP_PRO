/** Builds a reviewable CloudFormation update from the live synthetic template: code + two JWT program routes only. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { SYNTHETIC_MEMBER_PROFILE, observeSyntheticMemberIdentity } from './synthetic-aws-principal.mjs';

const profile=SYNTHETIC_MEMBER_PROFILE, region='us-east-2', account='588966314750';
const stackName='ai-clinical-core-synthetic-staging-authenticated-api';
const foundationName='ai-clinical-core-synthetic-staging';
const routeNames=['ConsumerProgramAssignmentsRoute','WorkforceProgramAssignmentsRoute'];
function aws(...args){
  try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',region,'--output','json'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true}));}
  catch{throw new Error('aws_read_failed');}
}
function entries(rows){return Object.fromEntries(rows.map(x=>[x.OutputKey??x.ParameterKey,x.OutputValue??x.ParameterValue]));}
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(process.argv.length!==3||process.argv[2]!=='--prepare-synthetic-only')throw new Error('command_refused');
if(observeSyntheticMemberIdentity().Account!==account)throw new Error('synthetic_account_required');
const foundation=aws('cloudformation','describe-stacks','--stack-name',foundationName).Stacks?.[0];
const fo=entries(foundation?.Outputs??[]);
if(foundation?.StackStatus!=='UPDATE_COMPLETE'||fo.PhiAllowed!=='false'||fo.DataClassification!=='synthetic_only'
  ||fo.DatabaseName!=='clinical_core'||fo.ClinicalApiId!=='wxv734oi12')throw new Error('synthetic_foundation_refused');
const ledger=aws('rds-data','execute-statement','--resource-arn',fo.DatabaseClusterArn,'--secret-arn',fo.DatabaseSecretArn,
  '--database','clinical_core','--sql','select count(*)::int,max(version) from clinical_core.schema_migrations').records?.[0];
if(ledger?.[0]?.longValue!==35||ledger?.[1]?.stringValue!=='20260929120000')throw new Error('program_migration_missing');
const stack=aws('cloudformation','describe-stacks','--stack-name',stackName).Stacks?.[0];
if(stack?.StackStatus!=='UPDATE_COMPLETE')throw new Error('stack_not_settled');
const params=entries(stack.Parameters??[]);
const current=aws('cloudformation','get-template','--stack-name',stackName).TemplateBody;
const live=typeof current==='string'?JSON.parse(current):current;
const sourceTemplate=JSON.parse(readFileSync('infra/aws-clinical-core/identity-api-extension.json','utf8'));
if(!live?.Resources||!sourceTemplate?.Resources||Object.keys(live.Resources).some(k=>routeNames.includes(k)))throw new Error('route_state_refused');
const oldRoutes=Object.values(live.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route').map(r=>r.Properties.RouteKey);
if(oldRoutes.length!==32||oldRoutes.some(k=>k.includes('/programs')||k.includes('$default')||k.includes('{proxy+}')))throw new Error('route_state_refused');
for(const name of routeNames){
  const route=sourceTemplate.Resources[name];
  if(route?.Type!=='AWS::ApiGatewayV2::Route'||route.Properties.AuthorizationType!=='JWT'
    ||!route.Properties.RouteKey.endsWith('/programs')||!route.Properties.AuthorizerId)throw new Error('source_route_refused');
  live.Resources[name]=route;
}
const bytes=readFileSync('dist/aws-clinical-core/identity-api.zip');
const digest=createHash('sha256').update(bytes).digest('hex');
const key=`clinical-core/authenticated-api/${digest}.zip`;
if(!params.LambdaCodeBucket||!params.ClinicalCoreKeyArn||!params.LambdaCodeKey)throw new Error('stack_parameters_missing');
const oldKey=params.LambdaCodeKey;
if(oldKey!=='clinical-core/authenticated-api/e960709e08d219ea2142a8c0e76281cf440ffd6d921f36a18327ee89cd97f91e.zip')
  throw new Error('previous_artifact_changed');
const parameters=(stack.Parameters??[]).map(p=>p.ParameterKey==='LambdaCodeKey'
  ?{ParameterKey:p.ParameterKey,ParameterValue:key}:{ParameterKey:p.ParameterKey,UsePreviousValue:true});
mkdirSync('dist/synthetic-program-api',{recursive:true});
const templatePath='dist/synthetic-program-api/template.json', parametersPath='dist/synthetic-program-api/parameters.json';
writeFileSync(templatePath,JSON.stringify(live,null,2)+'\n');
writeFileSync(parametersPath,JSON.stringify(parameters,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:source,account,phiAllowed:false,stackName,templatePath,parametersPath,
  oldRouteCount:oldRoutes.length,newRouteCount:oldRoutes.length+2,addedRoutes:routeNames.map(n=>live.Resources[n].Properties.RouteKey),
  artifactBucket:params.LambdaCodeBucket,artifactKey:key,artifactSha256:digest,previousArtifactKey:oldKey,
  kmsKeyArn:params.ClinicalCoreKeyArn,templateSha256:createHash('sha256').update(readFileSync(templatePath)).digest('hex')}));
