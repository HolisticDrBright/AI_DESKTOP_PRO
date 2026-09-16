import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
const require=createRequire(import.meta.url);
const ACCOUNT='588966314750',REGION='us-east-2',STACK='ai-clinical-core-synthetic-staging-lab-analysis';
const args=process.argv.slice(2),mode=args.shift();
let stage='operator-validation';
function option(name){const index=args.indexOf(name);return index>=0?args[index+1]:undefined;}
async function main(){
  if(!['plan','apply'].includes(mode)||!args.includes('--confirm-synthetic-only'))throw new Error('explicit_synthetic_mode_required');
  const profile=option('--profile')??'ai-synthetic-member',file=option('--file'),expectedSource=option('--source');
  if(!file||!expectedSource||!/^[a-f0-9]{40}$/.test(expectedSource))throw new Error('file_and_exact_source_required');
  if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==expectedSource
    ||execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Error('committed_source_required');
  const build=JSON.parse(readFileSync('dist/lab-inventory-migration.build.json','utf8'));
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  if(build.artifact!==hash('dist/lab-inventory-migration.cjs')||!Object.keys(build.sources??{}).includes('src/server/clinical-core/lab-inventory-migration.ts')
    ||Object.entries(build.sources).some(([file,digest])=>hash(file)!==digest))throw new Error('operator_bundle_stale');
  const {planInventoryMigration,applyInventoryMigration,inventoryMigrationHash,validateInventoryMigrationPlan}=require('../dist/lab-inventory-migration.cjs');
  stage='synthetic-environment-validation';
  const aws=(...commands)=>JSON.parse(execFileSync('aws',[...commands,'--profile',profile,'--region',REGION,'--no-cli-pager','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024}));
  if(aws('sts','get-caller-identity').Account!==ACCOUNT)throw new Error('wrong_aws_account');
  const foundation=aws('cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging').Stacks[0];
  const outputs=Object.fromEntries(foundation.Outputs.map(row=>[row.OutputKey,row.OutputValue]));
  if(outputs.PhiAllowed!=='false'||outputs.DataClassification!=='synthetic_only'||outputs.Environment!=='synthetic-staging')throw new Error('synthetic_posture_not_verified');
  const stack=aws('cloudformation','describe-stacks','--stack-name',STACK).Stacks[0];
  if(!['UPDATE_COMPLETE','CREATE_COMPLETE'].includes(stack.StackStatus))throw new Error('stack_not_ready');
  const parameters=Object.fromEntries(stack.Parameters.map(row=>[row.ParameterKey,row.ParameterValue]));
  const resources=aws('cloudformation','describe-stack-resources','--stack-name',STACK).StackResources;
  const tables=resources.filter(row=>row.LogicalResourceId==='LabJobTable'&&row.ResourceType==='AWS::DynamoDB::Table');
  if(tables.length!==1)throw new Error('ambiguous_table');
  const table=tables[0].PhysicalResourceId,pool=parameters.ConsumerUserPoolId;
  if(typeof pool!=='string'||!/^us-east-2_[A-Za-z0-9]+$/.test(pool))throw new Error('pool_not_verified');
  const description=aws('dynamodb','describe-table','--table-name',table).Table;
  if(description.TableArn!==`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${table}`
    ||description.TableStatus!=='ACTIVE'||!description.GlobalSecondaryIndexes?.some(index=>index.IndexName==='LabOwnerInventory'&&index.IndexStatus==='ACTIVE'))throw new Error('index_not_ready');
  // Same CLI-selected credentials for SDK calls; values never printed or persisted.
  const credentials=aws('configure','export-credentials','--format','process');
  const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:REGION,endpoint:'https://dynamodb.us-east-2.amazonaws.com',
    credentials:{accessKeyId:credentials.AccessKeyId,secretAccessKey:credentials.SecretAccessKey,sessionToken:credentials.SessionToken}}));
  const owner=async sub=>{
    const result=aws('cognito-idp','list-users','--user-pool-id',pool,'--filter',`sub = "${sub}"`,'--limit','2');
    if(result.Users?.length!==1||result.PaginationToken)return null;
    const user=result.Users[0],attributes=Object.fromEntries(user.Attributes.map(row=>[row.Name,row.Value]));
    return {ownerSub:attributes.sub,organizationId:attributes['custom:organization_id'],personId:attributes['custom:person_id'],
      syntheticAttested:attributes['custom:synthetic_attested']==='true',enabled:user.Enabled===true};
  };
  const deps={db,table,owner},target={account:ACCOUNT,region:REGION,table,pool,sourceCommit:expectedSource};
  if(mode==='plan'){
    stage='metadata-plan';
    const selectedJob=option('--only-job');
    if(selectedJob&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectedJob))throw new Error('selection_invalid');
    const plan=await planInventoryMigration(deps,{...target,...(selectedJob?{selectedJob}:{})}),text=JSON.stringify(plan,null,2)+'\n';
    writeFileSync(resolve(file),text,{encoding:'utf8',flag:'wx'});
    console.log(JSON.stringify({mode,sha256:inventoryMigrationHash(text),inspected:plan.inspected,candidates:plan.entries.length,skipped:plan.skipped}));
  }else{
    stage='reviewed-plan-validation';
    const text=readFileSync(resolve(file),'utf8'),expectedHash=option('--approved-sha256');
    if(!expectedHash||!/^[a-f0-9]{64}$/.test(expectedHash)||inventoryMigrationHash(text)!==expectedHash)throw new Error('reviewed_plan_hash_required');
    const plan=validateInventoryMigrationPlan(JSON.parse(text));
    for(const [key,value]of Object.entries(target))if(plan[key]!==value)throw new Error('reviewed_plan_target_mismatch');
    stage='conditional-index-update';
    const result=await applyInventoryMigration(deps,plan);
    console.log(JSON.stringify({mode,sha256:expectedHash,...result}));
    if(result.conflicts||result.unverifiedOwner||result.expiredOrMissing)process.exitCode=2;
  }
}
main().catch(error=>{
  const category=error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'operator_unconfirmed';
  console.error(JSON.stringify({ok:false,stage,category,message:'Migration not confirmed; inspect current synthetic state before retrying. No raw AWS error or record printed.'}));
  process.exitCode=1;
});
