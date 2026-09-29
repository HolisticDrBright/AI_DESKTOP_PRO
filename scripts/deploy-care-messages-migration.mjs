import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {applyClinicalCoreMigrations,loadClinicalCoreMigrations}=require('../dist/aws-clinical-core/care-message-migration-tools.cjs');
const initialReview=JSON.parse(readFileSync(new URL('./care-messages-deploy-reviewed-ledger.json',import.meta.url),'utf8'));
const receiptMode=process.argv[3]==='receipt';
// Additive receipt migration: preserve the original reviewed 30→31 history.
const reviewed=receiptMode?{...initialReview,
 history:[...initialReview.history,{version:initialReview.newMigration.version,name:'synthetic_care_messages',sha256:initialReview.newMigration.sha256}],
 newMigration:JSON.parse(readFileSync(new URL('./care-message-receipts-reviewed-migration.json',import.meta.url),'utf8')),
}:initialReview;
const profile='ai-synthetic-staging',region='us-east-2';
function aws(service,operation,input={}){
 try{return JSON.parse(execFileSync('aws',[service,operation,'--profile',profile,'--region',region,'--no-cli-pager','--cli-input-json',JSON.stringify(input),'--output','json'],{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}));}
 catch(error){
  // Surface only AWS's machine-readable error class, never SQL, tokens or rows.
  const code=String(error?.stderr??'').match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1];
  error.category=code?'aws_'+code.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase():'aws_call_failed';
  throw error;
 }
}
function check(value,code){if(!value)throw Error(code);}
async function main(){
 const mode=process.argv[2];check(['inspect','migrate','verify'].includes(mode),'command_invalid');
 check(process.argv.length<=4&&(!process.argv[3]||receiptMode),'command_invalid');
 check(aws('sts','get-caller-identity').Account===reviewed.account,'account_refused');
 const stack=aws('cloudformation','describe-stacks',{StackName:'ai-clinical-core-synthetic-staging'}).Stacks[0];
 check(stack.StackStatus==='UPDATE_COMPLETE','foundation_not_ready');
 const out=Object.fromEntries(stack.Outputs.map(x=>[x.OutputKey,x.OutputValue]));
 check(out.PhiAllowed==='false'&&out.DataClassification==='synthetic_only'&&out.Environment==='synthetic-staging'&&out.DatabaseName===reviewed.database&&out.ClinicalApiId==='wxv734oi12','target_refused');
 check(out.DatabaseClusterArn==='arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa','cluster_refused');
 const common={resourceArn:out.DatabaseClusterArn,secretArn:out.DatabaseSecretArn,database:out.DatabaseName};
 const query=(sql,parameters=[],transactionId)=>({rows:JSON.parse(aws('rds-data','execute-statement',{...common,sql,...(transactionId?{transactionId}:{}),parameters:parameters.map((value,i)=>({name:String(i+1),value:{stringValue:String(value)}})),formatRecordsAs:'JSON'}).formattedRecords??'[]')});
 const readLedger=tx=>query('select version,name,sha256 from clinical_core.schema_migrations order by version',[],tx).rows;
 const local=loadClinicalCoreMigrations(),next=local.find(x=>x.version===reviewed.newMigration.version);
 check(next?.sha256===reviewed.newMigration.sha256,'migration_artifact_changed');
 function verify(rows){
  const old=rows.filter(x=>x.version!==next.version);
  check(JSON.stringify(old)===JSON.stringify(reviewed.history),'reviewed_history_changed');
  for(const row of old){
   // This exact older alias is already present twice in hosted history. Preserve both.
   const version=row.version==='20260902230000'?'20260821049700':row.version;
   const source=local.find(x=>x.version===version);
   check(source&&source.sha256===row.sha256&&source.name===row.name,'source_history_mismatch');
  }
  const existing=rows.find(x=>x.version===next.version);
  check(!existing||existing.sha256===next.sha256,'migration_history_mismatch');
 }
 const before=readLedger();verify(before);
 if(mode==='inspect'){console.log(JSON.stringify({ok:true,account:reviewed.account,database:out.DatabaseName,phiAllowed:false,priorMigrations:before.length,migrationVersion:next.version,selectedMigrationApplied:before.some(x=>x.version===next.version),newMigrationSha256:next.sha256}));return;}
 if(mode==='verify'){
  check(before.some(x=>x.version===next.version),'migration_missing');
  const {transactionId}=aws('rds-data','begin-transaction',common);
  const q=sql=>query(sql,[],transactionId).rows;
  const quote=text=>"'"+text.replaceAll("'","''")+"'";
  const [org,otherOrg,owner,other,practitioner,outside,patient,connection]=Array.from({length:8},()=>randomUUID());
  const passed=[];
  const asActor=(actor,pool,organization=org)=>{
   q('reset role');q('set local role clinical_core_api');
   q("select clinical_private.set_request_context("+[actor,organization,pool,'synthetic-messaging-'+actor,'clinical_data','synthetic-staging','synthetic_only'].map(quote).join(',')+")");
  };
  const call=input=>{
   const operation=input.action==='receipt'?'care_message_receipt':'care_message_request';
   const data=q('select clinical_core.'+operation+'('+quote(JSON.stringify(input))+'::jsonb) as data')[0].data;
   return typeof data==='string'?JSON.parse(data):data;
  };
  const refused=(work,expected='care_message_refused')=>{
   q('savepoint expected_refusal');
   let denied=false;try{work();}catch(error){
    const detail=String(error?.stderr??'');
    denied=detail.includes('DatabaseErrorException')&&detail.includes(expected);
   }
   q('rollback to savepoint expected_refusal');q('release savepoint expected_refusal');
   check(denied,'expected_refusal_missing');
  };
  try{
   q("insert into clinical_core.organizations(id,synthetic_label) values("+quote(org)+",'Fictional messaging rollback A'),("+quote(otherOrg)+",'Fictional messaging rollback B')");
   for(const [actor,pool] of [[owner,'consumer'],[other,'consumer'],[practitioner,'workforce'],[outside,'workforce']]){
    q("insert into clinical_core.persons(id,synthetic_subject_key) values("+quote(actor)+","+quote('syn_'+actor.replaceAll('-',''))+")");
    q("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values("+[actor,pool,'synthetic-messaging-'+actor].map(quote).join(',')+",true)");
   }
   q("insert into clinical_core.organization_memberships(organization_id,person_id,role) values("+[org,practitioner,'practitioner'].map(quote).join(',')+"),("+[otherOrg,outside,'practitioner'].map(quote).join(',')+")");
   q("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values("+[patient,org,'patient_syn_messaging_'+patient.replaceAll('-','')].map(quote).join(',')+")");
   q("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values("+[connection,org,patient,owner,'verified'].map(quote).join(',')+",now())");
   asActor(owner,'consumer');
   const command={action:'send',connectionId:connection,requestId:randomUUID(),subject:'Fictional lesson question',body:'Fictional test message; rollback only.',acknowledgement:'care-messages/1'};
   const receiptRequest={action:'receipt',connectionId:connection,requestId:command.requestId};
   if(receiptMode){check(call(receiptRequest).status==='unresolved','missing_receipt_failed');passed.push('unresolved_is_not_cancellation');}
   const receipt=call(command);check(receipt.status==='stored'&&!receipt.duplicate,'send_failed');passed.push('consumer_send');
   if(receiptMode){
    const recovered=call(receiptRequest);check(recovered.status==='committed'&&recovered.messageId===receipt.messageId&&recovered.threadId===receipt.threadId,'receipt_recovery_failed');
    check(Object.keys(recovered).sort().join(',')==='action,connectionId,messageId,requestId,status,threadId','receipt_content_leaked');passed.push('late_send_receipt_recovered_without_content');
   }
   const retry=call(command);check(retry.duplicate&&retry.messageId===receipt.messageId,'retry_failed');passed.push('idempotent_retry');
   refused(()=>call({...command,body:'Changed fictional body.'}),'care_message_conflict');passed.push('changed_retry_refused');
   asActor(practitioner,'workforce');
   if(receiptMode){refused(()=>call(receiptRequest));passed.push('workforce_receipt_denied');}
   check(call({action:'list'}).threads.some(t=>t.threadId===receipt.threadId),'inbox_failed');
   check(call({action:'read',threadId:receipt.threadId}).messages.length===1,'read_failed');passed.push('workforce_inbox_read');
   check(call({action:'send',requestId:randomUUID(),connectionId:connection,threadId:receipt.threadId,body:'Fictional reply; rollback only.',acknowledgement:'care-messages/1'}).status==='stored','reply_failed');
   asActor(owner,'consumer');check(call({action:'read',threadId:receipt.threadId}).messages.length===2,'reply_read_failed');passed.push('reply_consumer_read');
   asActor(other,'consumer');refused(()=>call({action:'read',threadId:receipt.threadId}));check(call({action:'list'}).threads.length===0,'patient_isolation_failed');passed.push('other_patient_denied');
   if(receiptMode){refused(()=>call(receiptRequest));passed.push('other_owner_receipt_denied');}
   asActor(outside,'workforce',otherOrg);refused(()=>call({action:'read',threadId:receipt.threadId}));passed.push('other_clinic_denied');
   q('reset role');q("update clinical_core.patient_connections set state='paused' where id="+quote(connection));
   asActor(owner,'consumer');refused(()=>call(command));refused(()=>call({action:'read',threadId:receipt.threadId}));passed.push('paused_link_denied');
   if(receiptMode){refused(()=>call(receiptRequest));passed.push('paused_link_receipt_denied');}
   refused(()=>q('select * from clinical_core.care_messages'),'permission denied');passed.push('direct_table_access_denied');
  }finally{
   aws('rds-data','rollback-transaction',{resourceArn:common.resourceArn,secretArn:common.secretArn,transactionId});
  }
  check(query('select count(*)::int as n from clinical_core.organizations where id='+quote(org)).rows[0].n===0,'rollback_not_proven');
  console.log(JSON.stringify({ok:true,execution:'synthetic-database-rollback',passed,fixturesPersisted:false,jwtApiAcceptance:false,phiAllowed:false}));
  return;
 }
 const database={transaction:async work=>{
  const {transactionId}=aws('rds-data','begin-transaction',common);
  try{
   query("select pg_advisory_xact_lock(hashtext('ai-desktop-pro:clinical-core-migrations'))",[],transactionId);
   verify(readLedger(transactionId));
   const result=await work({query:async(sql,parameters=[])=>{
    // Data API uses named parameters; the existing migration runner uses $1/$2/$3.
    const translated=sql.replace(/\$(\d+)/g,':p$1');
    const response=aws('rds-data','execute-statement',{...common,transactionId,sql:translated,parameters:parameters.map((value,i)=>({name:'p'+(i+1),value:{stringValue:String(value)}})),formatRecordsAs:'JSON'});
    return {rows:JSON.parse(response.formattedRecords??'[]')};
   }});
   aws('rds-data','commit-transaction',{resourceArn:common.resourceArn,secretArn:common.secretArn,transactionId});
   return result;
  }catch(error){aws('rds-data','rollback-transaction',{resourceArn:common.resourceArn,secretArn:common.secretArn,transactionId});throw error;}
 }};
 const result=await applyClinicalCoreMigrations(database,[next]);
 const after=readLedger();verify(after);check(after.some(x=>x.version===next.version),'migration_missing');
 console.log(JSON.stringify({ok:true,...result,account:reviewed.account,database:out.DatabaseName,phiAllowed:false,ledgerCount:after.length,migrationSha256:next.sha256}));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e?.category??(/^[a-z_]+$/.test(e?.message)?e.message:'operator_failed'),statementIndex:e?.statementIndex}));process.exitCode=1;});
