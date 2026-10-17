import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDynamoStaffRevocationSignal } from '@/campaigns/staff-revocation';
import { fictionalEngine } from '@/campaigns/testing';
import { splitPostgresStatements } from '@/server/clinical-core/migrations';
import { classifyDatabaseRejection } from '@/server/clinical-core/rds-data-database';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { PENDING_TTL_MS, createDynamoStaffRevocationSignalPublisher } from '@/server/clinical-core/staff-revocation-signal';
import { createWorkforceIdentityRevocation, type ProviderStep, type StaffRevocationSignalPublisher } from '@/server/clinical-core/workforce-identity-revocation';
import { fictionalSignalTable } from '@/test-support/fictional-signal-table';

/**
 * The interval between the clinical revocation's commit and the campaign signal (staff-revocation-signal/2).
 *
 * The clinical database refuses a revoked login the moment its transaction commits. The campaign engine never reads
 * that database: it learns of the revocation only from its own signal table. So the question here is what an OLD
 * campaign token gets in that interval. Each case probes the campaign staff route at the exact moment the operator
 * transaction has committed and before the service has published anything, which is the interval itself. A test that
 * probes only after publication proves nothing about it.
 *
 * Real parts: the 106-migration production schema with the emergency revocation and its campaign-signal successor
 * (both BLOCKED), the operator service as production builds it, the real signal writer and reader over a fictional
 * table that evaluates their exact conditions, and the campaign engine's own staff route. Fictional rows only.
 *
 * `it.fails` marks an OPEN case: the test states the property we want, and it does not hold. Each is a reproduction
 * of a gap this design cannot close without either delaying the clinical refusal on DynamoDB or letting the campaign
 * engine read the clinical database, which are the two things it must not do.
 */
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
  'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql',
  'infra/aws-clinical-core/source-candidates/workforce-revocation-campaign-signal.sql',
];
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-campaign-admin-01', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

let db: PGlite;
const operator = randomUUID(), reviewer = randomUUID();
async function exec(file: string) {
  for (const [index, statement] of splitPostgresStatements(readFileSync(file, 'utf8')).entries()) {
    try { await db.exec(statement); } catch (error) {
      await db.exec('rollback').catch(() => undefined);
      throw new Error(`${file} statement ${index + 1}: ${String(error)}`);
    }
  }
}
const mode = (approvalMode: 'independent_review_after' | 'second_operator_before') =>
  db.query('update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode=$1 where singleton', [approvalMode]);
const identityStatus = async (subject: string) => (await db.query<{ status: string }>(
  "select status from clinical_core.identities where identity_pool='workforce' and identity_subject=$1", [subject])).rows[0]!.status;
const practitioner = async () => {
  const person = randomUUID(), subject = randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [person, subject]);
  return subject;
};

/**
 * One deployment: the operator connection, a fictional Cognito, the real signal writer, and a campaign practice whose
 * staff route reads the same table. `afterCommit` runs once, right after the next deciding transaction commits.
 */
async function deployment() {
  const table = fictionalSignalTable();
  let clock = Date.now();
  const now = () => clock;
  let afterCommit: (() => Promise<void>) | null = null;
  let failNext = false;
  const database: ClinicalCoreDatabase = { transaction: async work => {
    if (failNext) { failNext = false; throw new Error('fictional: no answer from the database'); }
    let deciding = false;
    const result = await db.transaction(async raw => {
      await raw.exec('set local role clinical_workforce_operator');
      return work({ query: async (sql, parameters = []) => {
        if (/(propose|decide)_workforce_identity_revocation\(/.test(sql)) deciding = true;
        try { return await raw.query(sql, parameters as unknown[]) as never; } catch (error) {
          throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: message(error) }) ?? error;
        }
      } });
    });
    // Only the transaction that decides: not the work-list read before an approval, nor the step records after.
    const probe = deciding ? afterCommit : null;
    if (probe) { afterCommit = null; await probe(); }
    return result;
  } };
  const provider = { revoke: async (_step: ProviderStep, _username: string) => {} };
  const signal = createDynamoStaffRevocationSignalPublisher({ client: table.client as never, tableName: table.tableName, now, timeoutMs: 1000 });
  const service = (publisher: StaffRevocationSignalPublisher = signal) => createWorkforceIdentityRevocation({ database, provider, signal: publisher, release: 'qualification' });
  const e = fictionalEngine();
  await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  e.deps.staffRevocation = createDynamoStaffRevocationSignal({ client: table.client as never, tableName: table.tableName, now });
  /** The OLD token of the practitioner whose login is being revoked, asking the campaign staff route for anything. */
  const oldToken = async (subject: string) => (await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: { authorizer: { jwt: { claims: {
    sub: subject, 'custom:organization_id': PRACTICE, 'custom:person_id': ADMIN.personId, email: ADMIN.email, exp: Date.now() / 1000 + 600 } } } } })).statusCode;
  /** What the old token gets at the moment the next deciding transaction commits. */
  const atCommit = (subject: string, then?: () => void) => {
    const seen: { status?: number } = {};
    afterCommit = async () => { seen.status = await oldToken(subject); then?.(); };
    return seen;
  };
  return { table, signal, service, oldToken, atCommit, advance(ms: number) { clock += ms; }, failNextTransaction() { failNext = true; } };
}
const propose = (d: Awaited<ReturnType<typeof deployment>>, subject: string, publisher?: StaffRevocationSignalPublisher) =>
  d.service(publisher).propose(operator, { requestId: randomUUID(), identitySubject: subject, reason: 'suspected_compromise' });

beforeAll(async () => {
  const schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
  expect(schema.manifest.migrations).toHaveLength(106);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of CHAIN) await exec(file);
  await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'active'),($2,'active')", [operator, reviewer]);
  await mode('independent_review_after');
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('before: one phase, published after the commit (failing before)', () => {
  it('an old campaign token is admitted in the interval between the clinical commit and the publication', async () => {
    const d = await deployment();
    const subject = await practitioner();
    // The /1 order: nothing is written before the decision; the final item only after it.
    const onePhase: StaffRevocationSignalPublisher = { publish: (s, id) => d.signal.publish(s, id), hold: async () => {}, release: async () => {} };
    const seen = d.atCommit(subject);
    await propose(d, subject, onePhase);
    expect(await identityStatus(subject)).toBe('disabled');
    expect(seen.status).toBe(200);
    expect(await d.oldToken(subject)).toBe(403);
  });
});

describe('race order A: the pending signal lands before the commit (the healthy table)', () => {
  it('the old token is refused at the commit, and by the final item after it', async () => {
    const d = await deployment();
    const subject = await practitioner();
    expect(await d.oldToken(subject)).toBe(200);
    const seen = d.atCommit(subject);
    const result = await propose(d, subject);
    expect(result.summary.state).toBe('revoked');
    expect(seen.status).toBe(403);
    expect(d.table.writes).toEqual([`put:pending#${subject}`, `put:${subject}`]);
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(await d.oldToken(subject)).toBe(403);
  });

  it('the pending write\'s reply lost: it landed, so the old token is still refused at the commit; the decision never waited on it', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.lose.put = 1;
    const seen = d.atCommit(subject);
    const result = await propose(d, subject);
    expect(seen.status).toBe(403);
    expect(result.provider.find(p => p.step === 'campaign_signal')).toEqual({ step: 'campaign_signal', outcome: 'succeeded' });
  });

  it('the final write\'s reply lost: the step stays actionable, the login stays refused, and a retry completes it', async () => {
    const d = await deployment();
    const subject = await practitioner();
    // The pending write succeeds; the final one lands but its caller hears nothing.
    let puts = 0;
    const flaky: StaffRevocationSignalPublisher = { ...d.signal, publish: async (s, id) => { puts++; d.table.lose.put = 1; return d.signal.publish(s, id); } };
    const result = await propose(d, subject, flaky);
    expect(puts).toBe(1);
    expect(result.provider.find(p => p.step === 'campaign_signal')).toMatchObject({ outcome: 'failed' });
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: expect.any(String) });
    expect(await d.oldToken(subject)).toBe(403);
    const reconciled = (await d.service().reconcile(operator)).find(r => r.proposalId === result.summary.proposalId);
    expect(reconciled?.provider.find(p => p.step === 'campaign_signal')).toEqual({ step: 'campaign_signal', outcome: 'succeeded' });
  });
});

describe('race order B: the commit lands before the pending signal', () => {
  it.fails('OPEN (reproduction): a pending write slower than the clinical transaction leaves the old token admitted at the commit', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.delayWrites();
    const seen = d.atCommit(subject, () => d.table.arrive());
    await propose(d, subject);
    expect(seen.status).toBe(403);
  });

  it('once the late pending write lands the old token is refused, and the final item follows', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.delayWrites();
    const seen = d.atCommit(subject, () => d.table.arrive());
    const result = await propose(d, subject);
    // What the gap is, measured: admitted at the commit, refused from the next request on.
    expect(seen.status).toBe(200);
    expect(result.summary.state).toBe('revoked');
    expect(await d.oldToken(subject)).toBe(403);
    expect(d.table.writes).toEqual([`put:pending#${subject}`, `put:${subject}`]);
  });
});

describe('publication failure, retry and reconciliation', () => {
  it.fails('OPEN (reproduction): with the signal table unwritable, the old token is admitted at the commit and until a reconciliation', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    const seen = d.atCommit(subject);
    await propose(d, subject);
    expect(seen.status).toBe(403);
  });

  it('a table outage never delays the clinical refusal; the step is recorded failed, and a reconciliation publishes it', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    const result = await propose(d, subject);
    expect(await identityStatus(subject)).toBe('disabled');
    expect(result.provider.find(p => p.step === 'campaign_signal')).toMatchObject({ outcome: 'failed' });
    expect(await d.oldToken(subject)).toBe(200);
    d.table.down.writes = false;
    await d.service().reconcile(operator);
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(await d.oldToken(subject)).toBe(403);
  });

  it.fails('OPEN (reproduction): a final publication still failing after the pending deadline reopens the gap until a reconciliation', async () => {
    const d = await deployment();
    const subject = await practitioner();
    const pendingOnly: StaffRevocationSignalPublisher = { ...d.signal, publish: async () => { throw Object.assign(new Error('fictional'), { name: 'WorkforceProviderFailure', code: 'unavailable' }); } };
    await propose(d, subject, pendingOnly);
    expect(await d.oldToken(subject)).toBe(403);
    d.advance(PENDING_TTL_MS + 1);
    expect(await d.oldToken(subject)).toBe(403);
  });

  it('a reconciliation after the pending deadline publishes over the lapsed item', async () => {
    const d = await deployment();
    const subject = await practitioner();
    const pendingOnly: StaffRevocationSignalPublisher = { ...d.signal, publish: async () => { throw Object.assign(new Error('fictional'), { name: 'WorkforceProviderFailure', code: 'unavailable' }); } };
    const result = await propose(d, subject, pendingOnly);
    d.advance(PENDING_TTL_MS + 1);
    expect(await d.oldToken(subject)).toBe(200);
    await d.service().reconcile(operator);
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(await d.oldToken(subject)).toBe(403);
  });

  it('the signal reader down: the old token is refused as unavailable before, during and after, never admitted', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.reads = true;
    expect(await d.oldToken(subject)).toBe(503);
    const seen = d.atCommit(subject);
    await propose(d, subject);
    expect(seen.status).toBe(503);
    expect(await d.oldToken(subject)).toBe(503);
  });
});

describe('an innocent login is never revoked for good by a decision that did not take effect', () => {
  it('awaiting a second operator: the pending signal is released at once, and a decline leaves nothing behind', async () => {
    await mode('second_operator_before');
    try {
      const d = await deployment();
      const subject = await practitioner();
      const result = await propose(d, subject);
      expect(result.summary.state).toBe('awaiting_approval');
      expect(await identityStatus(subject)).toBe('active');
      expect(d.table.writes).toEqual([`put:pending#${subject}`, `delete:pending#${subject}`]);
      expect(await d.oldToken(subject)).toBe(200);
      const declined = await d.service().decide(reviewer, { proposalId: result.summary.proposalId, decision: 'decline' });
      expect(declined.summary.state).toBe('declined');
      expect([d.table.items.has(subject), d.table.items.has(`pending#${subject}`)]).toEqual([false, false]);
      expect(await d.oldToken(subject)).toBe(200);
    } finally { await mode('independent_review_after'); }
  });

  it('the approval that takes effect holds the signal pending while it is decided: refused at its commit', async () => {
    await mode('second_operator_before');
    try {
      const d = await deployment();
      const subject = await practitioner();
      const proposed = await propose(d, subject);
      const seen = d.atCommit(subject);
      const approved = await d.service().decide(reviewer, { proposalId: proposed.summary.proposalId, decision: 'approve' });
      expect(approved.summary.state).toBe('revoked');
      expect(seen.status).toBe(403);
      expect(d.table.items.get(subject)).toMatchObject({ revocationId: expect.any(String) });
    } finally { await mode('independent_review_after'); }
  });

  it('a named database refusal is definite: released, and the login is back at once', async () => {
    const d = await deployment();
    const subject = 'fictional-subject-nobody-has-0001';
    await expect(propose(d, subject)).rejects.toMatchObject({ code: 'not_found' });
    expect(d.table.writes).toEqual([`put:pending#${subject}`, `delete:pending#${subject}`]);
    expect(await d.oldToken(subject)).toBe(200);
  });

  it('no answer from the database is unknown: the login stays refused until the pending deadline, then is back by itself', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.failNextTransaction();
    await expect(propose(d, subject)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await identityStatus(subject)).toBe('active');
    expect(await d.oldToken(subject)).toBe(403);
    d.advance(PENDING_TTL_MS + 1);
    expect(await d.oldToken(subject)).toBe(200);
  });

  it('a release whose reply is lost still removed the item; one that never lands is bounded by the deadline', async () => {
    await mode('second_operator_before');
    try {
      const d = await deployment();
      const subject = await practitioner();
      d.table.lose.delete = 1;
      await propose(d, subject);
      expect([d.table.items.has(subject), d.table.items.has(`pending#${subject}`)]).toEqual([false, false]);
      expect(await d.oldToken(subject)).toBe(200);
      const other = await practitioner();
      const stuck: StaffRevocationSignalPublisher = { ...d.signal, release: async () => { throw Object.assign(new Error('fictional'), { name: 'WorkforceProviderFailure', code: 'unavailable' }); } };
      await propose(d, other, stuck);
      expect(await d.oldToken(other)).toBe(403);
      d.advance(PENDING_TTL_MS + 1);
      expect(await d.oldToken(other)).toBe(200);
    } finally { await mode('independent_review_after'); }
  });
});
