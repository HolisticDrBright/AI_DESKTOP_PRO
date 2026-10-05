/** Register the owner-approved, fictional-only consent copy in the isolated qualification DB. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  RDSDataClient, BeginTransactionCommand, CommitTransactionCommand,
  RollbackTransactionCommand, ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';

const profile = 'ai-synthetic-staging';
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

if (process.argv[2] !== '--confirm-synthetic-only') throw new Error('Explicit synthetic-only confirmation required.');
const identity = aws('sts', 'get-caller-identity');
if (identity.Account !== account) throw new Error('AWS account mismatch; no write attempted.');
const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', stack).Stacks?.[0];
if (foundation?.StackStatus !== 'CREATE_COMPLETE' && foundation?.StackStatus !== 'UPDATE_COMPLETE') throw new Error('Qualification foundation is not ready.');
const outputs = Object.fromEntries((foundation.Outputs ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
if (outputs.PhiAllowed !== 'false' || outputs.DatabaseName !== database || outputs.QualificationInfrastructure !== 'prepared_no_candidates' || !outputs.DatabaseClusterArn || !outputs.DatabaseSecretArn) {
  throw new Error('Qualification isolation or PHI-off posture is not verified.');
}
process.env.AWS_PROFILE = profile;
const client = new RDSDataClient({ region });
const base = { resourceArn: outputs.DatabaseClusterArn, secretArn: outputs.DatabaseSecretArn, database };
const query = (sql, parameters = [], transactionId) => client.send(new ExecuteStatementCommand({ ...base, sql, parameters, transactionId }));
let transactionId;
try {
  const begin = await client.send(new BeginTransactionCommand(base));
  transactionId = begin.transactionId;
  const marker = await query('select current_database(), (select count(*) from clinical_core.schema_migrations), (select max(version) from clinical_core.schema_migrations)', [], transactionId);
  const row = marker.records?.[0] ?? [];
  if (field(row, 0) !== database || Number(field(row, 1)) !== 103 || field(row, 2) !== '20260928010000') {
    throw new Error('Qualification database or migration ledger mismatch; no consent release written.');
  }
  const existing = await query("select scope, version, content_sha256, content from clinical_private.consumer_storage_consent_releases where scope in ('forms_checkins','lab_history')", [], transactionId);
  if (existing.records?.length) {
    if (existing.records.length !== 2 || existing.records.some(r => field(r, 1) !== version || field(r, 2) !== digest || field(r, 3) !== copy)) {
      throw new Error('Existing consent release differs; refusing overwrite.');
    }
    await client.send(new RollbackTransactionCommand({ ...base, transactionId }));
    transactionId = undefined;
    console.log(JSON.stringify({ status: 'already_registered', account, database, version, scopes: ['forms_checkins','lab_history'], contentSha256: digest, phiAllowed: false }));
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
} finally {
  if (transactionId) await client.send(new RollbackTransactionCommand({ ...base, transactionId }));
  client.destroy();
}
