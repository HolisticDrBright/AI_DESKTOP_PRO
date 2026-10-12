/** Register only the owner's approved fictional Ask ALP copy at the isolated 112-row target.
 * This does not grant consent to an account or enable the AI scope in a Lambda. */
import {execFileSync} from 'node:child_process';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {RDSDataClient,BeginTransactionCommand,CommitTransactionCommand,RollbackTransactionCommand,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {SYNTHETIC_MEMBER_PROFILE,observeSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
import {qualificationCare112Artifact,assertQualificationCare112Ledger,assertQualificationConsentFoundation,QUALIFICATION_CARE_112_LEDGER} from './qualification-consent-ledger.mjs';
import {AI_CONSENT_VERSION,AI_CONSENT_COPY,AI_CONSENT_SHA256,AI_CONSENT_APPROVER,assertAiConsentTarget,classifyAiConsentRows} from './qualification-ai-consent.mjs';

const account='588966314750',region='us-east-2',database='clinical_core_qualification';
const inspect=process.argv.length===3&&process.argv[2]==='--inspect';
const write=process.argv.length===3&&process.argv[2]==='--confirm-approved-fictional-ai-consent';
if(!inspect&&!write)throw new Error('qualification_ai_consent_command_refused');
const aws=(...args)=>JSON.parse(execFileSync('aws',[...args,'--profile',SYNTHETIC_MEMBER_PROFILE,'--region',region,'--output','json'],
  {encoding:'utf8',windowsHide:true,timeout:30000}));
const field=(row,index)=>Object.values(row?.[index]??{})[0];

// Match all 112 ordered migration digests before contacting AWS or reading its secret.
const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
  {encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:8*1024*1024}));
const expected=qualificationCare112Artifact(artifact);
if(write&&execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.github','.gitattributes'],
  {encoding:'utf8',windowsHide:true,timeout:15000}).trim())throw new Error('qualification_ai_consent_dirty_source_refused');
if(observeSyntheticMemberIdentity().Account!==account)throw new Error('qualification_ai_consent_account_refused');
const foundation=assertQualificationConsentFoundation(aws('cloudformation','describe-stacks','--stack-name','ai-clinical-core-qualification-foundation').Stacks?.[0]);
const target=assertAiConsentTarget(aws('cloudformation','describe-stacks','--stack-name','ai-clinical-core-qualification-personal-storage').Stacks?.[0]);
if(target.DatabaseClusterArn!==foundation.DatabaseClusterArn||target.DatabaseSecretArn!==foundation.DatabaseSecretArn)
  throw new Error('qualification_ai_consent_database_binding_refused');
const client=new RDSDataClient({region,credentials:fromIni({profile:SYNTHETIC_MEMBER_PROFILE}),maxAttempts:1});
const base={resourceArn:foundation.DatabaseClusterArn,secretArn:foundation.DatabaseSecretArn,database};
const query=(sql,parameters=[],transactionId)=>client.send(new ExecuteStatementCommand({...base,sql,parameters,transactionId}));
let transactionId;
try{
  const begin=await client.send(new BeginTransactionCommand(base));transactionId=begin.transactionId;
  if(!transactionId)throw new Error('qualification_ai_consent_transaction_refused');
  await query('set transaction isolation level repeatable read'+(inspect?' read only':''),[],transactionId);
  const marker=await query('select current_database()',[],transactionId);
  const ledger=await query('select version,sha256 from clinical_core.schema_migrations order by version',[],transactionId);
  assertQualificationCare112Ledger(field(marker.records?.[0],0),(ledger.records??[]).map(row=>({version:field(row,0),sha256:field(row,1)})),expected);
  if(write)await query("select pg_advisory_xact_lock(hashtextextended('qualification_ai_consent_registration',0))",[],transactionId);
  const releases=await query("select scope,version,content_sha256,content,approved_by from clinical_private.consumer_storage_consent_releases where scope='ai_context'",[],transactionId);
  const rows=(releases.records??[]).map(row=>({scope:field(row,0),version:field(row,1),contentSha256:field(row,2),content:field(row,3),approvedBy:field(row,4)}));
  const status=classifyAiConsentRows(rows);
  if(!write||status==='registered'){
    await client.send(new RollbackTransactionCommand({...base,transactionId}));transactionId=undefined;
    console.log(JSON.stringify({status:inspect?'inspected_'+status:'already_registered',mutations:false,account,database,
      migrationReleaseHash:QUALIFICATION_CARE_112_LEDGER,scope:'ai_context',version:AI_CONSENT_VERSION,contentSha256:AI_CONSENT_SHA256,
      phiAllowed:false,featureEnabled:false}));
    process.exit(0);
  }
  await query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) values ('ai_context',:version,:digest,:copy,:approvedBy,clock_timestamp())",[
    {name:'version',value:{stringValue:AI_CONSENT_VERSION}},
    {name:'digest',value:{stringValue:AI_CONSENT_SHA256}},
    {name:'copy',value:{stringValue:AI_CONSENT_COPY}},
    {name:'approvedBy',value:{stringValue:AI_CONSENT_APPROVER}},
  ],transactionId);
  await client.send(new CommitTransactionCommand({...base,transactionId}));transactionId=undefined;
  console.log(JSON.stringify({status:'registered',mutations:true,account,database,migrationReleaseHash:QUALIFICATION_CARE_112_LEDGER,
    scope:'ai_context',version:AI_CONSENT_VERSION,contentSha256:AI_CONSENT_SHA256,phiAllowed:false,featureEnabled:false}));
}catch(error){
  const category=/^qualification_ai_consent_[a-z_]+$/.test(error?.message??'')?error.message:'qualification_ai_consent_operation_failed';
  console.error(JSON.stringify({status:'not_completed',category,account,database,phiAllowed:false,writeStatus:inspect?'none':'not_certified'}));
  process.exitCode=1;
}finally{
  if(transactionId){try{await client.send(new RollbackTransactionCommand({...base,transactionId}));}
    catch{console.error(JSON.stringify({status:'not_completed',category:'rollback_unverified',writeStatus:inspect?'none':'not_certified'}));process.exitCode=1;}}
  client.destroy();
}
