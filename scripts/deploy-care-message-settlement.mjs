// Narrow, account-pinned operator for migration 33 only. Never applies program migration 34.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient, ExecuteStatementCommand, BeginTransactionCommand, CommitTransactionCommand, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';

const account = '588966314750', region = 'us-east-2', profile = 'ai-synthetic-staging';
const version = '20260929110000', expectedHash = '7777a42ab16df9d487e27914c59740230f72fbca6c183c44f18493e9dcd3929a';
const priorHash = '8e41e108dd5beed639fa5c520e0c1f8a5b83a68dd88316dc105a60f1aac3573a';
const outdir = 'dist/settlement-qualification';
const hash = text => createHash('sha256').update(text).digest('hex');
const check = (ok, code) => { if (!ok) throw new Error(code); };
const evidence = { execution: 'synthetic-staging-settlement-database', phiAllowed: false, account, region, database: 'clinical_core', migrationVersion: version, migrationSha256: expectedHash, passed: [], apiAcceptance: false, deviceAcceptance: false };
let statementNumber = 0;
function aws(service, action, input = {}) {
  return JSON.parse(execFileSync('aws', [service, action, '--profile', profile, '--region', region, '--cli-input-json', JSON.stringify(input), '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}
async function main() {
  const mode = process.argv[2];
  check(['inspect', 'rehearsal', 'apply', 'verify'].includes(mode) && process.argv.length === 3, 'command_refused');
  check(aws('sts', 'get-caller-identity').Account === account, 'account_refused');
  evidence.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  check(evidence.sourceCommit.startsWith('b55e774'), 'source_commit_changed');
  const stack = aws('cloudformation', 'describe-stacks', { StackName: 'ai-clinical-core-synthetic-staging' }).Stacks[0];
  const o = Object.fromEntries(stack.Outputs.map(x => [x.OutputKey, x.OutputValue]));
  check(stack.StackStatus === 'UPDATE_COMPLETE' && o.DatabaseName === 'clinical_core' && o.ClinicalApiId === 'wxv734oi12' && o.PhiAllowed === 'false' && o.Environment === 'synthetic-staging' && o.DataClassification === 'synthetic_only', 'foundation_refused');
  check(o.DatabaseClusterArn === 'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa', 'cluster_refused');
  mkdirSync(outdir, { recursive: true });
  await build({ entryPoints: ['src/server/clinical-core/migrations.ts'], outfile: outdir + '/migration-tools.cjs', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { loadClinicalCoreMigrations, splitPostgresStatements } = createRequire(import.meta.url)('../' + outdir + '/migration-tools.cjs');
  const local = loadClinicalCoreMigrations();
  const migration = local.find(x => x.version === version);
  check(migration?.sha256 === expectedHash, 'artifact_changed');
  const client = new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 });
  const common = { resourceArn: o.DatabaseClusterArn, secretArn: o.DatabaseSecretArn, database: o.DatabaseName };
  const q = async (sql, parameters = [], transactionId) => {
    statementNumber++;
    const result = await client.send(new ExecuteStatementCommand({ ...common, transactionId, sql: sql.replace(/\$(\d+)/g, ':p$1'), parameters: parameters.map((v, i) => ({ name: 'p' + (i + 1), value: { stringValue: String(v) }, ...(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(v)) ? { typeHint: 'UUID' } : {}) })), formatRecordsAs: 'JSON' }));
    return JSON.parse(result.formattedRecords ?? '[]');
  };
  const ledger = tx => q('select version,name,sha256 from clinical_core.schema_migrations order by version', [], tx);
  function verifyHistory(rows) {
    const old = rows.filter(x => x.version !== version);
    check(old.length === 32 && hash(JSON.stringify(old)) === priorHash, 'prior_history_changed');
    for (const row of old) {
      const source = local.find(x => x.version === (row.version === '20260902230000' ? '20260821049700' : row.version));
      check(source?.sha256 === row.sha256 && source.name === row.name, 'source_history_changed');
    }
    const current = rows.find(x => x.version === version);
    check(!current || (current.sha256 === expectedHash && current.name === migration.name), 'settlement_history_changed');
    return Boolean(current);
  }
  const before = await ledger(), applied = verifyHistory(before);
  evidence.ledgerBefore = before.length;
  if (mode === 'inspect') { console.log(JSON.stringify({ ...evidence, selectedMigrationApplied: applied })); return; }
  if (mode === 'apply') {
    const rehearsal = JSON.parse(readFileSync(outdir + '/rehearsal.json', 'utf8'));
    check(rehearsal.verdict === 'pass' && rehearsal.fixtureRollbackVerified && rehearsal.sourceCommit === evidence.sourceCommit && rehearsal.migrationSha256 === expectedHash && rehearsal.account === account && rehearsal.database === common.database && Date.now() - Date.parse(rehearsal.completedAt) < 3600000, 'fresh_rehearsal_required');
  }
  const tx = (await client.send(new BeginTransactionCommand(common))).transactionId;
  const query = (sql, parameters = []) => q(sql, parameters, tx);
  const org = randomUUID();
  let ended = false;
  try {
    await query("select pg_advisory_xact_lock(hashtext('ai-desktop-pro:clinical-core-migrations'))");
    const exists = verifyHistory(await ledger(tx));
    if (mode === 'verify') check(exists, 'migration_missing');
    if (!exists) {
      for (const statement of splitPostgresStatements(migration.sql)) await query(statement);
      await query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [version, migration.name, expectedHash]);
    }
    const guard = (await query("select c.relrowsecurity as rls,has_table_privilege('clinical_core_api','clinical_core.care_message_settlements','SELECT') as readable from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clinical_core' and c.relname='care_message_settlements'"))[0];
    check(guard?.rls && !guard.readable, 'table_grants_refused');
    evidence.passed.push('settlement_table_rls_no_api_select');
    if (mode !== 'apply') {
      const [owner, other, staff, patient, connection] = Array.from({ length: 5 }, () => randomUUID());
      await query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional settlement rollback only')", [org]);
      for (const [person, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce']]) {
        await query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
        await query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)', [person, pool, 'settlement-' + person]);
      }
      await query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, staff]);
      await query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)", [patient, org, 'patient_syn_' + patient.replaceAll('-', '')]);
      await query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, owner]);
      const as = async (actor, pool) => {
        await query('reset role'); await query('set local role clinical_core_api');
        await query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [actor, org, pool, 'settlement-' + actor, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
      };
      const call = async body => {
        const raw = (await query('select clinical_core.' + (body.action === 'settle' ? 'care_message_settle' : body.action === 'receipt' ? 'care_message_receipt' : 'care_message_request') + '($1::jsonb) as data', [JSON.stringify(body)]))[0].data;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      };
      const refuse = async (body, expected) => {
        await query('savepoint expected_refusal'); let denied = false;
        try { await call(body); } catch (error) { denied = error.name === 'DatabaseErrorException' && error.message.includes(expected); }
        await query('rollback to savepoint expected_refusal'); await query('release savepoint expected_refusal');
        check(denied, 'expected_refusal_missing');
      };
      await as(owner, 'consumer');
      const message = { action: 'send', connectionId: connection, requestId: randomUUID(), subject: 'Fictional settlement test', body: 'Synthetic rollback only.', acknowledgement: 'care-messages/1' };
      const sent = await call(message);
      check(sent.status === 'stored' && typeof sent.messageId === 'string', 'send_failed');
      const settle = { action: 'settle', requestId: message.requestId, connectionId: connection };
      const delivered = await call(settle);
      check(delivered.status === 'committed' && delivered.messageId === sent.messageId, 'send_first_not_committed');
      evidence.passed.push('send_then_settle_reports_committed');
      const cancelled = { ...settle, requestId: randomUUID() };
      check((await call(cancelled)).status === 'cancelled', 'cancel_missing');
      check((await call(cancelled)).status === 'cancelled', 'cancel_retry_missing');
      evidence.passed.push('settle_first_and_idempotent_settlement');
      await refuse({ ...message, requestId: cancelled.requestId }, 'care_message_settled');
      evidence.passed.push('late_send_refused');
      await as(owner, 'consumer');
      check((await call({ ...cancelled, action: 'receipt' })).status === 'cancelled', 'receipt_not_cancelled');
      evidence.passed.push('fresh_database_context_receipt_cancelled_not_physical_device');
      await as(other, 'consumer'); await refuse(cancelled, 'care_message_refused');
      await as(staff, 'workforce'); await refuse(cancelled, 'care_message_refused');
      evidence.passed.push('foreign_owner_and_workforce_refused');
      await query('reset role');
      await query("update clinical_core.patient_connections set state='paused' where id=$1", [connection]);
      await as(owner, 'consumer');
      const withheld = await call(settle);
      check(withheld.status === 'withheld' && !('messageId' in withheld) && !('threadId' in withheld), 'inaccessible_delivery_disclosed');
      evidence.passed.push('paused_link_delivery_withheld_without_identifiers');
    }
    if (mode === 'apply') await client.send(new CommitTransactionCommand({ ...common, transactionId: tx }));
    else await client.send(new RollbackTransactionCommand({ ...common, transactionId: tx }));
    ended = true;
  } finally {
    if (!ended) await client.send(new RollbackTransactionCommand({ ...common, transactionId: tx }));
  }
  const after = await ledger(); verifyHistory(after); evidence.ledgerAfter = after.length;
  if (mode === 'apply') check(after.length === 33, 'apply_not_visible');
  else {
    check(JSON.stringify(after) === JSON.stringify(before), 'rollback_ledger_changed');
    check((await q('select count(*)::int as count from clinical_core.organizations where id=$1', [org]))[0].count === 0, 'fixture_rollback_failed');
    evidence.fixtureRollbackVerified = true;
  }
  evidence.mode = mode; evidence.verdict = 'pass'; evidence.completedAt = new Date().toISOString();
  writeFileSync(outdir + '/' + mode + '.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ verdict: 'blocked', statementNumber, passed: evidence.passed, error: /^[a-z_]+$/.test(error.message) ? error.message : error.name ?? 'operator_failed', diagnostic: error.name === 'DatabaseErrorException' ? error.message.split(';')[0].slice(0, 240) : undefined })); process.exitCode = 1; });
