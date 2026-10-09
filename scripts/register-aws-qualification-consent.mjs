/** Register the owner-approved, fictional-only consent copy in the isolated qualification DB. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { SYNTHETIC_MEMBER_PROFILE, observeSyntheticMemberIdentity } from './synthetic-aws-principal.mjs';
import { qualificationConsentArtifact, assertQualificationConsentLedger, assertQualificationConsentFoundation, QUALIFICATION_CONSENT_LEDGER } from './qualification-consent-ledger.mjs';
import {
  RDSDataClient, BeginTransactionCommand, CommitTransactionCommand,
  RollbackTransactionCommand, ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';

const profile = SYNTHETIC_MEMBER_PROFILE;
const account = '588966314750';
const region = 'us-east-2';
const stack = 'ai-clinical-core-qualification-foundation';
const database = 'clinical_core_qualification';
const version = 'qualification-test-2026-10-05';
const copy = 'I agree to store and use fictional test intake and lab-history data in the isolated ALP qualification service for software testing. No real personal or health information may be entered.';
const approvedBy = 'Brandon Bright — synthetic qualification approval via Codex chat, 2026-10-05';
const digest = createHash('sha256').update(copy, 'utf8').digest('hex');

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'], { encoding: 'utf8' }));
}
function field(row, index) { return Object.values(row[index] ?? {})[0]; }

const inspect=process.argv[2]==='--inspect';
if(process.argv.length!==3 || !inspect && process.argv[2]!=='--confirm-synthetic-only')throw new Error('Explicit synthetic-only confirmation or read-only inspection required.');
// A changed source artifact is refused before STS, secret access or a transaction.
const expected=qualificationConsentArtifact(JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
  {encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,windowsHide:true})));
if(!inspect && execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.github','.gitattributes'],
  {encoding:'utf8',timeout:15000,windowsHide:true}).trim())throw new Error('qualification_consent_dirty_source_refused');
const identity = observeSyntheticMemberIdentity();
if (identity.Account !== account) throw new Error('AWS account mismatch; no write attempted.');
const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', stack).Stacks?.[0];
const outputs = assertQualificationConsentFoundation(foundation);
const client = new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 });
const base = { resourceArn: outputs.DatabaseClusterArn, secretArn: outputs.DatabaseSecretArn, database };
const query = (sql, parameters = [], transactionId) => client.send(new ExecuteStatementCommand({ ...base, sql, parameters, transactionId }));
let transactionId;
try {
  const begin = await client.send(new BeginTransactionCommand(base));
  transactionId = begin.transactionId;
  if(!transactionId)throw new Error('qualification_consent_transaction_refused');
  await query('set transaction isolation level repeatable read'+(inspect?' read only':''),[],transactionId);
  const marker = await query('select current_database()',[],transactionId);
  const ledger = await query('select version,sha256 from clinical_core.schema_migrations order by version',[],transactionId);
  assertQualificationConsentLedger(field(marker.records?.[0]??[],0),(ledger.records??[]).map(r=>({version:field(r,0),sha256:field(r,1)})),expected);
  if(!inspect)await query("select pg_advisory_xact_lock(hashtextextended('qualification_test_consent_registration',0))",[],transactionId);
  const existing = await query("select scope, version, content_sha256, content from clinical_private.consumer_storage_consent_releases where scope in ('forms_checkins','lab_history')", [], transactionId);
  if (existing.records?.length) {
    if (existing.records.length !== 2 || new Set(existing.records.map(r=>field(r,0))).size!==2 || existing.records.some(r => !['forms_checkins','lab_history'].includes(field(r,0)) || field(r, 1) !== version || field(r, 2) !== digest || field(r, 3) !== copy)) {
      throw new Error('Existing consent release differs; refusing overwrite.');
    }
    await client.send(new RollbackTransactionCommand({ ...base, transactionId }));
    transactionId = undefined;
    console.log(JSON.stringify({ status: inspect?'inspected_existing':'already_registered', mutations: false, account, database, migrationReleaseHash:QUALIFICATION_CONSENT_LEDGER, version, scopes: ['forms_checkins','lab_history'], contentSha256: digest, phiAllowed: false }));
    process.exit(0);
  }
  if(inspect) {
    await client.send(new RollbackTransactionCommand({...base,transactionId})); transactionId=undefined;
    console.log(JSON.stringify({status:'inspected_missing',mutations:false,account,database,migrationReleaseHash:QUALIFICATION_CONSENT_LEDGER,version,contentSha256:digest,phiAllowed:false}));
    process.exit(0);
  }
  await query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) values ('forms_checkins',:version,:digest,:copy,:approvedBy,clock_timestamp()),('lab_history',:version,:digest,:copy,:approvedBy,clock_timestamp())", [
    { name: 'version', value: { stringValue: version } },
    { name: 'digest', value: { stringValue: digest } },
    { name: 'copy', value: { stringValue: copy } },
    { name: 'approvedBy', value: { stringValue: approvedBy } },
  ], transactionId);
  await client.send(new CommitTransactionCommand({ ...base, transactionId }));
  transactionId = undefined;
  console.log(JSON.stringify({ status: 'registered', account, database, version, scopes: ['forms_checkins','lab_history'], contentSha256: digest, phiAllowed: false }));
} catch(error) {
  // Never dump a provider response, arbitrary SQL detail or an ambiguous commit.
  // No automatic transaction, statement or write retry is performed.
  const category=error?.name==='DatabaseResumingException' && !transactionId?'database_resuming':
    /^qualification_consent_[a-z_]+$/.test(error?.message??'')?error.message:'qualification_consent_operation_failed';
  console.error(JSON.stringify({status:'not_completed',category,account,database,phiAllowed:false,writeStatus:inspect?'none':'not_certified'}));
  process.exitCode=1;
} finally {
  if (transactionId) {
    try { await client.send(new RollbackTransactionCommand({ ...base, transactionId })); }
    catch { console.error(JSON.stringify({status:'not_completed',category:'rollback_unverified',writeStatus:inspect?'none':'not_certified'})); process.exitCode=1; }
  }
  client.destroy();
}
