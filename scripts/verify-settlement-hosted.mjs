// Real JWT/Data API synthetic acceptance. Uses existing owner-approved fictional identities only.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient, ExecuteStatementCommand, BeginTransactionCommand, CommitTransactionCommand, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
const profile = 'ai-synthetic-staging', region = 'us-east-2', account = '588966314750';
const origin = 'https://wxv734oi12.execute-api.us-east-2.amazonaws.com';
const directory = 'dist/messaging-identities', output = 'dist/settlement-qualification/hosted.json';
const evidence = { execution: 'synthetic-staging-real-jwt-settlement', phiAllowed: false, passed: [], physicalDeviceAcceptance: false, apiAcceptance: false };
let operation = 'preflight';
const check = (ok, code) => { if (!ok) throw new Error(code); };
function aws(service, action, input = {}) {
  return JSON.parse(execFileSync('aws', [service, action, '--profile', profile, '--region', region, '--cli-input-json', JSON.stringify(input), '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}
async function main() {
  check(process.argv.includes('--confirm-owner-approved-synthetic-plan'), 'approval_required');
  check(aws('sts', 'get-caller-identity').Account === account, 'account_refused');
  const deploy = JSON.parse(readFileSync('dist/settlement-qualification/deployment.json', 'utf8'));
  check(deploy.deployed && deploy.programRoutesWithheld && deploy.phiAllowed === false && deploy.account === account, 'deployment_unverified');
  const config = aws('lambda', 'get-function-configuration', { FunctionName: 'wxv734oi12-synthetic-identity' });
  check(config.CodeSha256 === deploy.deployedCodeSha256 && config.LastUpdateStatus === 'Successful', 'code_drift');
  const stack = aws('cloudformation', 'describe-stacks', { StackName: 'ai-clinical-core-synthetic-staging' }).Stacks[0];
  const o = Object.fromEntries(stack.Outputs.map(x => [x.OutputKey, x.OutputValue]));
  check(o.DatabaseName === 'clinical_core' && o.PhiAllowed === 'false' && o.ClinicalApiId === 'wxv734oi12' && o.DataClassification === 'synthetic_only', 'target_refused');
  const command = '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';
  const decrypted = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { input: readFileSync(directory + '/credentials.dpapi.txt', 'utf8'), encoding: 'utf8', windowsHide: true, timeout: 20000 });
  check(decrypted.status === 0, 'credential_decryption_failed');
  const state = JSON.parse(decrypted.stdout), fixture = JSON.parse(readFileSync(directory + '/messaging-fixture.json', 'utf8'));
  check(state.account === account && state.containsPhi === false && state.schemaVersion === 'messaging-identity-state/1' && fixture.organizationId === state.organizationId, 'fixture_refused');
  for (const [role, user] of Object.entries(state.users)) {
    check(/^messaging-[a-z]+-[a-f0-9]{8}@example\.invalid$/.test(user.username) && user.role === role, 'identity_refused');
    const claims = JSON.parse(Buffer.from(user.authentication.IdToken.split('.')[1], 'base64url').toString());
    check(claims.sub === user.subject && claims['custom:person_id'] === user.personId && claims['custom:organization_id'] === state.organizationId && claims['custom:synthetic_attested'] === 'true' && claims.exp * 1000 > Date.now() + 300000, 'fresh_identity_required');
  }
  check(Boolean(state.users.workforce.mfaChallengeVerifiedAt), 'workforce_mfa_missing');
  const client = new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 });
  const common = { resourceArn: o.DatabaseClusterArn, secretArn: o.DatabaseSecretArn, database: o.DatabaseName };
  const q = async (sql, values = [], transactionId) => {
    const result = await client.send(new ExecuteStatementCommand({ ...common, transactionId, sql, parameters: values.map((v, i) => ({ name: 'p' + i, value: { stringValue: String(v) } })), formatRecordsAs: 'JSON' }));
    return JSON.parse(result.formattedRecords ?? '[]');
  };
  const transaction = async work => {
    const tx = (await client.send(new BeginTransactionCommand(common))).transactionId;
    try { await work(tx); await client.send(new CommitTransactionCommand({ ...common, transactionId: tx })); }
    catch (error) { await client.send(new RollbackTransactionCommand({ ...common, transactionId: tx })); throw error; }
  };
  check((await q("select sha256 from clinical_core.schema_migrations where version='20260929110000'"))[0]?.sha256 === '7777a42ab16df9d487e27914c59740230f72fbca6c183c44f18493e9dcd3929a', 'migration_missing');
  check((await q('select synthetic_label,contains_phi from clinical_core.organizations where id=:p0::uuid', [state.organizationId]))[0]?.synthetic_label === 'Fictional messaging acceptance 20260929', 'organization_refused');
  const link = (await q('select * from clinical_core.patient_connections where id=:p0::uuid', [fixture.connectionId]))[0];
  check(link?.organization_id === state.organizationId && link.consumer_person_id === state.users.consumer.personId && link.patient_record_id === fixture.patientId && link.state === 'verified', 'connection_refused');
  const request = async (role, path, body, expected) => {
    operation = path;
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.users[role].authentication.IdToken }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
    const raw = await response.text(); check(raw.length < 250000, 'response_too_large');
    const value = JSON.parse(raw);
    if (expected !== undefined) check(response.status === expected, 'unexpected_http_' + response.status);
    return { status: response.status, value };
  };
  const message = (role, body, status = 200) => request(role, '/clinical-core/' + (role === 'workforce' ? 'workforce' : 'consumer') + '/messages', body, status);
  const newMessage = () => ({ action: 'send', connectionId: fixture.connectionId, requestId: randomUUID(), subject: 'Fictional settlement acceptance', body: 'Synthetic test only; no health information.', acknowledgement: 'care-messages/1' });
  const settle = m => ({ action: 'settle', requestId: m.requestId, connectionId: m.connectionId });
  const record = name => { evidence.passed.push(name); console.log('Passed: ' + name); };
  const first = newMessage();
  const sent = (await message('consumer', first)).value.data;
  check(sent.status === 'stored' && typeof sent.messageId === 'string', 'send_failed');
  const committed = (await message('consumer', settle(first))).value.data;
  check(committed.status === 'committed' && committed.messageId === sent.messageId, 'send_first_settlement_failed'); record('send_first_reports_committed');
  const second = newMessage(), cancel = settle(second);
  check((await message('consumer', cancel)).value.data.status === 'cancelled', 'settle_first_failed');
  check((await message('consumer', cancel)).value.data.status === 'cancelled', 'settle_idempotency_failed'); record('settle_first_idempotent_cancel');
  check((await message('consumer', second, 409)).value.error === 'conflict', 'late_send_not_refused'); record('late_admission_refused');
  const readReceipt = { ...cancel, action: 'receipt' };
  check((await message('consumer', readReceipt)).value.data.status === 'cancelled', 'new_client_not_converged'); record('new_http_client_receipt_cancelled_not_physical_second_device');
  check((await message('foreignConsumer', cancel, 403)).value.error === 'identity_refused', 'foreign_owner_allowed');
  check((await message('workforce', cancel, 403)).value.error === 'identity_refused', 'workforce_settle_allowed'); record('settlement_owner_and_role_isolation');
  const racing = newMessage();
  const [racedSend, racedSettle] = await Promise.all([
    request('consumer', '/clinical-core/consumer/messages', racing),
    request('consumer', '/clinical-core/consumer/messages', settle(racing)),
  ]);
  check(racedSettle.status === 200, 'race_settlement_failed');
  if (racedSettle.value.data.status === 'committed') check(racedSend.status === 200 && racedSend.value.data.messageId === racedSettle.value.data.messageId, 'race_false_delivery');
  else check(racedSettle.value.data.status === 'cancelled' && racedSend.status === 409, 'race_false_cancellation');
  record('simultaneous_send_settle_consistent');
  const replacement = randomUUID(); let replaced = false;
  try {
    operation = 'replace_exact_fictional_connection';
    await transaction(async tx => {
      const changed = await q("update clinical_core.patient_connections set state='revoked' where id=:p0::uuid and organization_id=:p1::uuid and consumer_person_id=:p2::uuid and state='verified' returning id", [fixture.connectionId, state.organizationId, state.users.consumer.personId], tx);
      check(changed.length === 1, 'fixture_changed');
      await q("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values(:p0::uuid,:p1::uuid,:p2::uuid,:p3::uuid,'verified',now())", [replacement, state.organizationId, fixture.patientId, state.users.consumer.personId], tx);
    });
    replaced = true;
    const withheld = (await message('consumer', settle(first))).value.data;
    check(withheld.status === 'withheld' && !('threadId' in withheld) && !('messageId' in withheld), 'replacement_disclosed_delivery');
    const wrongLink = (await message('consumer', { ...settle(first), connectionId: replacement })).value.data;
    check(wrongLink.status === 'withheld', 'wrong_link_false_cancellation'); record('replaced_link_and_wrong_link_withhold_identifiers');
    await message('consumer', { ...settle(first), action: 'receipt' }, 403); record('revoked_link_receipt_refused');
  } finally {
    if (replaced) await transaction(async tx => {
      await q("update clinical_core.patient_connections set state='revoked' where id=:p0::uuid and organization_id=:p1::uuid and consumer_person_id=:p2::uuid", [replacement, state.organizationId, state.users.consumer.personId], tx);
      await q("update clinical_core.patient_connections set state='verified' where id=:p0::uuid and organization_id=:p1::uuid and consumer_person_id=:p2::uuid and state='revoked'", [fixture.connectionId, state.organizationId, state.users.consumer.personId], tx);
    });
  }
  check((await message('consumer', { ...settle(first), action: 'receipt' })).value.data.messageId === sent.messageId, 'original_fixture_not_restored'); record('original_fictional_connection_restored');
  await request('consumer', '/clinical-core/consumer/programs', { action: 'list' }, 404);
  await request('workforce', '/clinical-core/workforce/programs', { action: 'status' }, 404); record('unsafe_program_routes_remain_unavailable');
  evidence.apiAcceptance = true; evidence.verdict = 'pass'; evidence.completedAt = new Date().toISOString();
  evidence.sourceCommit = deploy.sourceCommit; evidence.artifactSha256 = deploy.artifactSha256;
  evidence.cleanup = 'Original fictional link restored; replacement retained revoked; fictional test messages and cancellation tombstones retained as evidence.';
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ verdict: 'blocked', operation, passed: evidence.passed, error: /^[a-z0-9_]+$/.test(error.message) ? error.message : error.name ?? 'operator_failed' })); process.exitCode = 1; });
