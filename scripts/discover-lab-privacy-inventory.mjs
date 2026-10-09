import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
const require=createRequire(import.meta.url);
const ACCOUNT='588966314750',REGION='us-east-2',STACK='ai-clinical-core-synthetic-staging-lab-analysis';
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const hash=text=>createHash('sha256').update(text).digest('hex');
let stage='operator-validation';
async function main(){
  const allowed=new Set(['--confirm-synthetic-only','--profile','--source','--scope-file','--out','--max-scanned']);
  const seen=new Set();
  for(let i=0;i<args.length;i++){
    const key=args[i];if(!allowed.has(key)||seen.has(key))throw new Error('arguments_invalid');seen.add(key);
    if(key!=='--confirm-synthetic-only'&&(!args[++i]||args[i].startsWith('--')))throw new Error('arguments_invalid');
  }
  const source=option('--source'),scopeFile=option('--scope-file'),out=option('--out');
  if(!seen.has('--confirm-synthetic-only')||!source||!/^[a-f0-9]{40}$/.test(source)||!scopeFile||!out)throw new Error('explicit_source_scope_output_required');
  if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==source
    ||execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Error('committed_source_required');
  const build=JSON.parse(readFileSync('dist/lab-privacy-inventory.build.json','utf8'));
  const tracked=new Set(execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split(/\r?\n/));
  if(build.artifact!==hash(readFileSync('dist/lab-privacy-inventory.cjs'))
    ||!Object.keys(build.sources??{}).includes('src/server/clinical-core/lab-privacy-inventory.ts')
    ||Object.entries(build.sources).some(([path,digest])=>!tracked.has(path)||hash(readFileSync(path))!==digest))throw new Error('operator_bundle_stale');
  const scope=JSON.parse(readFileSync(scopeFile,'utf8'));
  if(!scope||Object.keys(scope).sort().join(',')!=='organizationId,ownerSub,personId'
    ||Object.values(scope).some(v=>typeof v!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)))throw new Error('scope_invalid');
  const maxScanned=Number(option('--max-scanned')??10000);
  if(!Number.isInteger(maxScanned)||maxScanned<1||maxScanned>100000)throw new Error('scan_budget_invalid');
  const profile=option('--profile')??'ai-synthetic-member';
  const aws=(...commands)=>JSON.parse(execFileSync('aws',[...commands,'--profile',profile,'--region',REGION,'--no-cli-pager','--output','json'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024}));
  stage='synthetic-target-validation';
  if(aws('sts','get-caller-identity').Account!==ACCOUNT)throw new Error('wrong_aws_account');
  const foundation=aws('cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging').Stacks[0];
  const outputs=Object.fromEntries(foundation.Outputs.map(r=>[r.OutputKey,r.OutputValue]));
  if(outputs.PhiAllowed!=='false'||outputs.DataClassification!=='synthetic_only'||outputs.Environment!=='synthetic-staging')throw new Error('synthetic_posture_not_verified');
  const stack=aws('cloudformation','describe-stacks','--stack-name',STACK).Stacks[0];
  if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))throw new Error('stack_not_ready');
  const pool=stack.Parameters.find(p=>p.ParameterKey==='ConsumerUserPoolId')?.ParameterValue;
  if(typeof pool!=='string'||!/^us-east-2_[A-Za-z0-9]+$/.test(pool))throw new Error('pool_not_verified');
  const tables=aws('cloudformation','describe-stack-resources','--stack-name',STACK).StackResources
    .filter(r=>r.LogicalResourceId==='LabJobTable'&&r.ResourceType==='AWS::DynamoDB::Table');
  if(tables.length!==1)throw new Error('ambiguous_table');
  const table=tables[0].PhysicalResourceId,description=aws('dynamodb','describe-table','--table-name',table).Table;
  if(description.TableArn!==`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${table}`||description.TableStatus!=='ACTIVE')throw new Error('table_not_verified');
  const revalidate=async()=>{
    const users=aws('cognito-idp','list-users','--user-pool-id',pool,'--filter',`sub = "${scope.ownerSub}"`,'--limit','2');
    if(users.Users?.length!==1||users.PaginationToken||users.Users[0].Enabled!==true)throw new Error('owner_unverified');
    const attributes=Object.fromEntries(users.Users[0].Attributes.map(a=>[a.Name,a.Value]));
    if(attributes['custom:synthetic_attested']!=='true')throw new Error('owner_unverified');
    return {ownerSub:attributes.sub,organizationId:attributes['custom:organization_id'],personId:attributes['custom:person_id']};
  };
  const credentials=aws('configure','export-credentials','--format','process');
  const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:REGION,endpoint:'https://dynamodb.us-east-2.amazonaws.com',
    credentials:{accessKeyId:credentials.AccessKeyId,secretAccessKey:credentials.SecretAccessKey,sessionToken:credentials.SessionToken}}));
  stage='read-only-retained-inventory';
  const {discoverRetainedLabJobs}=require('../dist/lab-privacy-inventory.cjs');
  const report=await discoverRetainedLabJobs({db,table,scope,classification:'synthetic_only',revalidate,maxScanned});
  const text=JSON.stringify({sourceCommit:source,account:ACCOUNT,region:REGION,table,pool,...report},null,2)+'\n';
  stage='exclusive-local-report';
  writeFileSync(out,text,{encoding:'utf8',flag:'wx',mode:0o600});
  console.log(JSON.stringify({sha256:hash(text),jobs:report.jobs.length,counts:report.counts,coverage:report.coverage}));
  if(report.coverage.hasUnresolvedEnumerationIssues)process.exitCode=2;
}
main().catch(error=>{
  const category=error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'inventory_unconfirmed';
  console.error(JSON.stringify({ok:false,stage,category,message:'No inventory confirmed. No raw AWS error or record printed.'}));process.exitCode=1;
});
