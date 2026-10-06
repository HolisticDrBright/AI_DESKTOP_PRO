/** Add only authenticated consult/intake routes to fictional synthetic staging. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';

const profile='ai-synthetic-staging',region='us-east-2',account='588966314750';
const foundationName='ai-clinical-core-synthetic-staging';
const stackName='ai-clinical-core-synthetic-staging-authenticated-api';
const routeNames=[
 'WorkforceConsultLinksRoute','WorkforceConsultRequestsRoute','WorkforceIntakeFormsRoute',
 'WorkforceIntakePacketsRoute','ConsumerIntakePacketsRoute',
];
const codeKey='clinical-core/authenticated-api/58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247.zip';
function aws(...args){
 try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',region,'--output','json'],
  {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true}));}
 catch{throw Error('aws_read_failed');}
}
const entries=rows=>Object.fromEntries(rows.map(x=>[x.OutputKey??x.ParameterKey,x.OutputValue??x.ParameterValue]));
if(process.argv.length!==3||process.argv[2]!=='--prepare-synthetic-only')throw Error('command_refused');
if(aws('sts','get-caller-identity').Account!==account)throw Error('synthetic_account_required');
const foundation=aws('cloudformation','describe-stacks','--stack-name',foundationName).Stacks?.[0];
const fo=entries(foundation?.Outputs??[]);
if(foundation?.StackStatus!=='UPDATE_COMPLETE'||fo.PhiAllowed!=='false'||fo.DataClassification!=='synthetic_only'
  ||fo.DatabaseName!=='clinical_core'||fo.ClinicalApiId!=='wxv734oi12')throw Error('synthetic_foundation_refused');
const ledger=aws('rds-data','execute-statement','--resource-arn',fo.DatabaseClusterArn,'--secret-arn',fo.DatabaseSecretArn,
 '--database','clinical_core','--sql','select count(*)::int,max(version) from clinical_core.schema_migrations').records?.[0];
if(ledger?.[0]?.longValue!==41||ledger?.[1]?.stringValue!=='20260930150000')throw Error('intake_migrations_missing');
const stack=aws('cloudformation','describe-stacks','--stack-name',stackName).Stacks?.[0];
if(stack?.StackStatus!=='UPDATE_COMPLETE')throw Error('stack_not_settled');
const params=entries(stack.Parameters??[]);
if(params.LambdaCodeKey!==codeKey||params.DatabaseName!=='clinical_core')throw Error('deployed_code_changed');
const body=aws('cloudformation','get-template','--stack-name',stackName).TemplateBody;
const live=typeof body==='string'?JSON.parse(body):body;
const source=JSON.parse(readFileSync('infra/aws-clinical-core/identity-api-extension.json','utf8'));
if(!live?.Resources||!source?.Resources||routeNames.some(name=>name in live.Resources))throw Error('route_state_refused');
const oldRoutes=Object.values(live.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route').map(r=>r.Properties.RouteKey);
if(oldRoutes.length!==36||oldRoutes.some(k=>k.includes('/consult-')||k.includes('/intake-')
  ||k.includes('$default')||k.includes('{proxy+}')))throw Error('route_state_refused');
for(const name of routeNames){
 const route=source.Resources[name];
 if(route?.Type!=='AWS::ApiGatewayV2::Route'||route.Properties.AuthorizationType!=='JWT'
  ||!route.Properties.AuthorizerId||!route.Properties.Target)throw Error('source_route_refused');
 live.Resources[name]=route;
}
const dir='dist/synthetic-intake-api';mkdirSync(dir,{recursive:true});
const templatePath=`${dir}/template.json`,parametersPath=`${dir}/parameters.json`;
writeFileSync(templatePath,JSON.stringify(live,null,2)+'\n');
writeFileSync(parametersPath,JSON.stringify((stack.Parameters??[]).map(p=>({ParameterKey:p.ParameterKey,UsePreviousValue:true})),null,2)+'\n');
console.log(JSON.stringify({account,phiAllowed:false,stackName,templatePath,parametersPath,
 previousCodeKey:codeKey,oldRouteCount:oldRoutes.length,newRouteCount:oldRoutes.length+routeNames.length,
 addedRoutes:routeNames.map(name=>live.Resources[name].Properties.RouteKey),publicRouteAdded:false,
 templateSha256:createHash('sha256').update(readFileSync(templatePath)).digest('hex')}));
