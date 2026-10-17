import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WorkforceRequest, WorkforceResponse } from '@/campaigns/contract';
import { FORM_MIN_MS } from '@/campaigns/public';
import { createDynamoStaffRevocationSignal } from '@/campaigns/staff-revocation';
import { fictionalEngine, tokenFrom } from '@/campaigns/testing';
import { splitPostgresStatements } from '@/server/clinical-core/migrations';
import { classifyDatabaseRejection } from '@/server/clinical-core/rds-data-database';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import {
  RECONCILER_OVERDUE_AFTER_MS, createSqlRevocationSignalReconcilerStore, runRevocationSignalReconciler, type ReconcilerSummary,
} from '@/server/clinical-core/revocation-signal-reconciler';
import { PENDING_TTL_MS, createDynamoStaffRevocationSignalPublisher } from '@/server/clinical-core/staff-revocation-signal';
import { withPendingHeadStart } from '@/server/clinical-core/staff-revocation-signal-head-start';
import { WorkforceProviderFailure, createWorkforceIdentityRevocation, type ProviderStep, type StaffRevocationSignalPublisher } from '@/server/clinical-core/workforce-identity-revocation';
import { fictionalSignalTable } from '@/test-support/fictional-signal-table';

/**
 * The emergency-revocation publication gap with the scheduled signal reconciler (BLOCKED), end to end.
 *
 * revocation-signal-timing.database.test.ts measures the interval between the clinical commit and the campaign signal
 * and reproduces its three OPEN cases. This file asks what a scheduled, operator-free reconciler changes about them, and
 * what it cannot change. Each sweep is the reconciler as it would run on its schedule: its own database role (no
 * operator subject anywhere), the durable lease, the existing revocation records as its only source of truth, and the
 * real signal writer. Probes are at the moment of the clinical commit, at each sweep, and across the pending deadline.
 *
 * Real parts: the 106-migration production schema with the emergency revocation, its campaign-signal successor and the
 * reconciler candidate (all BLOCKED, applied only to this PGlite), the operator service as production builds it, the
 * reconciler and its SQL store, the real signal writer and reader over a fictional table that evaluates their exact
 * conditions, the campaign staff route and the campaign sending job. PGlite is not Aurora and the fictional table is
 * not DynamoDB: one connection, so "concurrent" sweeps here interleave at await points, never in parallel.
 * Fictional rows, subjects, clinics and addresses only.
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
  'infra/aws-clinical-core/source-candidates/workforce-revocation-signal-reconciler.sql',
];
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-campaign-admin-01', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const COLLEAGUE_SUBJECT = 'fictional-subject-colleague-login-01';
const MINUTE = 60_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unavailable = () => Object.assign(new Error('fictional'), { name: 'WorkforceProviderFailure', code: 'unavailable' }) as unknown as WorkforceProviderFailure;

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
const identityStatus = async (subject: string) => (await db.query<{ status: string }>(
  "select status from clinical_core.identities where identity_pool='workforce' and identity_subject=$1", [subject])).rows[0]!.status;
const practitioner = async () => {
  const person = randomUUID(), subject = randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [person, subject]);
  return subject;
};
/** Every recorded campaign_signal attempt for the subject's revocations, oldest first, with who recorded it. */
const signalRows = async (subject: string) => (await db.query<{ outcome: string; by: string }>(`
  select a.outcome, case when exists (select 1 from clinical_private.workforce_revocation_signal_sweeps s where s.sweep_id::text = a.recorded_by) then 'sweep'
    when exists (select 1 from clinical_private.workforce_platform_operators o where o.operator_subject = a.recorded_by) then 'operator' else 'unknown' end as by
  from clinical_private.workforce_identity_provider_actions a join clinical_private.workforce_identity_revocations r on r.id = a.revocation_id
  where r.identity_subject = $1 and a.step = 'campaign_signal' order by a.recorded_at, a.id`, [subject])).rows.map(r => `${r.by}:${r.outcome}`);
/** Every operator away: the registry holds no active operator at all. */
async function operatorsAway<T>(work: () => Promise<T>): Promise<T> {
  await db.query("update clinical_private.workforce_platform_operators set status='disabled'");
  try { return await work(); } finally { await db.query("update clinical_private.workforce_platform_operators set status='active'"); }
}
/** The lease's holder lapses, as if its sweep had stalled past its 60 seconds: written by the table owner, never by a role. */
const lapseLease = () => db.query("update clinical_private.workforce_revocation_signal_reconciler_lease set lease_until = clock_timestamp() - interval '1 second' where singleton and holder is not null");

/**
 * One deployment: the operator connection, the reconciler's own connection, a fictional Cognito, the real signal
 * writer, and a campaign practice whose staff route and sending job read the same table. `afterCommit` runs once,
 * right after the next deciding transaction commits.
 */
async function deployment() {
  const table = fictionalSignalTable();
  let clock = Date.now();
  const now = () => clock;
  let afterCommit: (() => Promise<void>) | null = null;
  let loseNextDecisionReply = false;
  const database: ClinicalCoreDatabase = { transaction: async work => {
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
    const probe = deciding ? afterCommit : null;
    if (probe) { afterCommit = null; await probe(); }
    // Committed, and then the answer never reached the service.
    if (deciding && loseNextDecisionReply) { loseNextDecisionReply = false; throw new Error('fictional: the reply was lost after the commit'); }
    return result;
  } };
  /** The reconciler's connection. It carries no operator subject; the store sets its own role. */
  let loseRecordReplies = 0;
  const reconcilerDatabase: ClinicalCoreDatabase = { transaction: async work => {
    let recording = false;
    const result = await db.transaction(async raw => work({ query: async (sql, parameters = []) => {
      if (/clinical_revocation_signal\.record_attempt\(/.test(sql)) recording = true;
      return await raw.query(sql, parameters as unknown[]) as never;
    } }));
    if (recording && loseRecordReplies > 0) { loseRecordReplies--; throw new Error('fictional: the record reply was lost after the commit'); }
    return result;
  } };
  const provider = { revoke: async (_step: ProviderStep, _username: string) => {} };
  const signal = createDynamoStaffRevocationSignalPublisher({ client: table.client as never, tableName: table.tableName, now, timeoutMs: 1000 });
  const service = (publisher: StaffRevocationSignalPublisher = signal, connection: ClinicalCoreDatabase = database) =>
    createWorkforceIdentityRevocation({ database: connection, provider, signal: publisher, release: 'qualification' });
  const releases: string[] = [];
  /** The reconciler's writer, watched: it has no way to release, and any attempt to would be recorded here. */
  const watched = (publisher: StaffRevocationSignalPublisher = signal) => ({ publish: publisher.publish, hold: publisher.hold,
    release: async (subject: string) => { releases.push(subject); } });
  /** One scheduled sweep, as the reconciler's Lambda would run it. */
  const sweep = (publisher: StaffRevocationSignalPublisher = signal) => runRevocationSignalReconciler({
    store: createSqlRevocationSignalReconcilerStore(reconcilerDatabase), signal: watched(publisher), release: 'qualification', now, pause: async () => {},
  }) as Promise<ReconcilerSummary>;
  const e = fictionalEngine();
  await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  e.deps.staffRevocation = createDynamoStaffRevocationSignal({ client: table.client as never, tableName: table.tableName, now });
  /** The OLD token of a login, asking the campaign staff route for anything. */
  const oldToken = async (subject: string) => (await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: { authorizer: { jwt: { claims: {
    sub: subject, 'custom:organization_id': PRACTICE, 'custom:person_id': ADMIN.personId, email: ADMIN.email, exp: Date.now() / 1000 + 600 } } } } })).statusCode;
  const atCommit = (probe: () => Promise<void>) => { afterCommit = probe; };
  return {
    table, signal, service, sweep, oldToken, atCommit, e, releases, now, database,
    advance(ms: number) { clock += ms; },
    loseNextDecisionReply() { loseNextDecisionReply = true; },
    loseRecordReplies(n: number) { loseRecordReplies = n; },
    reconcilerStore: () => createSqlRevocationSignalReconcilerStore(reconcilerDatabase),
  };
}
type Deployment = Awaited<ReturnType<typeof deployment>>;
const propose = (d: Deployment, subject: string, publisher?: StaffRevocationSignalPublisher) =>
  d.service(publisher).propose(operator, { requestId: randomUUID(), identitySubject: subject, reason: 'suspected_compromise' });

beforeAll(async () => {
  const schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
  expect(schema.manifest.migrations).toHaveLength(106);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of CHAIN) await exec(file);
  await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'active'),($2,'active')", [operator, reviewer]);
  await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after' where singleton");
}, 180_000);
afterAll(async () => { await db?.close(); });
/** The database is shared, so every revocation a test leaves unpublished is published after it, through a throwaway
 * table: each test starts with nothing due. */
afterEach(async () => {
  await lapseLease();
  const table = fictionalSignalTable();
  const plain: ClinicalCoreDatabase = { transaction: work => db.transaction(async raw => work({ query: async (sql, parameters = []) => await raw.query(sql, parameters as unknown[]) as never })) };
  const drained = await runRevocationSignalReconciler({ store: createSqlRevocationSignalReconcilerStore(plain), release: 'qualification', pause: async () => {},
    signal: createDynamoStaffRevocationSignalPublisher({ client: table.client as never, tableName: table.tableName }) });
  expect(drained).toMatchObject({ released: true, unpublished: 0 });
});

describe('before: only an operator reconciles a failed publication (the dependency, pinned)', () => {
  it('with the writer down at the commit and every operator away, the operator path cannot publish: the old token stays admitted after the writer recovers', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    await propose(d, subject);
    d.table.down.writes = false;
    await operatorsAway(async () => {
      await expect(d.service().reconcile(operator)).rejects.toMatchObject({ code: 'operator_refused' });
    });
    d.advance(PENDING_TTL_MS + MINUTE);
    expect(await identityStatus(subject)).toBe('disabled');
    expect(await d.oldToken(subject)).toBe(200);
  });
});

describe('a writer outage with a working reader', () => {
  it('the commit-instant gap stays (measured), and the first sweep after the writer recovers publishes it with every operator away: refused from then on', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    let seen = 0;
    d.atCommit(async () => { seen = await d.oldToken(subject); });
    const result = await propose(d, subject);
    // What the reconciler cannot change: at the commit the table held nothing (revocation-signal-timing, OPEN 2).
    expect(seen).toBe(200);
    await operatorsAway(async () => {
      const during = await d.sweep();
      expect(during).toMatchObject({ released: true, sweep: 'completed', examined: 1, published: 0, failed: 1, renewed: 0, unpublished: 1, overdue: false, alarms: [] });
      expect(await d.oldToken(subject)).toBe(200);
      // Still down past the overdue threshold: the sweep says so, which is what pages someone.
      d.advance(RECONCILER_OVERDUE_AFTER_MS + MINUTE);
      expect(await d.sweep()).toMatchObject({ failed: 1, overdue: true, alarms: ['overdue'] });
      d.table.down.writes = false;
      const after = await d.sweep();
      expect(after).toMatchObject({ examined: 1, published: 1, failed: 0, unpublished: 0, overdue: false, alarms: [] });
    });
    expect(await d.oldToken(subject)).toBe(403);
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:failed', 'sweep:failed', 'sweep:succeeded']);
    // The revocation reads complete to the operator now, and leaves the work list once it is reviewed.
    const listed = (await d.service().list(operator)).find(item => item.proposalId === result.summary.proposalId);
    expect(listed?.provider).toBe('complete');
    expect(d.releases).toEqual([]);
  });

  it('a backlog larger than one sweep is published least recently attempted first, so no revocation waits behind a stuck one', async () => {
    const d = await deployment();
    d.table.down.writes = true;
    const subjects = [await practitioner(), await practitioner(), await practitioner()];
    for (const subject of subjects) await propose(d, subject);
    d.table.down.writes = false;
    const store = d.reconcilerStore();
    const sweepId = randomUUID();
    const claim = await store.claim(sweepId, 2);
    if (!claim.granted) throw new Error('lease');
    expect(claim.due).toHaveLength(2);
    expect(claim.unpublished).toBeGreaterThanOrEqual(3);
    await store.complete(sweepId, claim.generation);
    // A full sweep publishes all of them, and nothing is left behind.
    await d.sweep();
    for (const subject of subjects) expect(await d.oldToken(subject)).toBe(403);
  });
});

describe('a lost publication reply', () => {
  it('the reconciler\'s own publish lands but its reply is lost: its bounded retry finds it there, records it once, and the item is the revocation\'s', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    const result = await propose(d, subject);
    d.table.down.writes = false;
    d.table.lose.put = 1;
    expect(await d.sweep()).toMatchObject({ examined: 1, published: 1, failed: 0, alarms: [] });
    expect(d.table.items.get(subject)).toEqual({ subject, revocationId: result.summary.revocationId, contract: 'staff-revocation-signal/2' });
    expect(d.table.writes.filter(w => w === `put:${subject}`)).toHaveLength(1);
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:succeeded']);
    expect(await d.oldToken(subject)).toBe(403);
  });

  it('the service\'s final reply lost: the reconciler confirms it without an operator and never overwrites the item', async () => {
    const d = await deployment();
    const subject = await practitioner();
    let lost = false;
    const flaky: StaffRevocationSignalPublisher = { ...d.signal, publish: async (s, id) => { if (!lost) { lost = true; d.table.lose.put = 1; } return d.signal.publish(s, id); } };
    const result = await propose(d, subject, flaky);
    expect(result.provider.find(p => p.step === 'campaign_signal')).toMatchObject({ outcome: 'failed' });
    const before = { ...d.table.items.get(subject) };
    await operatorsAway(async () => { expect(await d.sweep()).toMatchObject({ published: 1, alarms: [] }); });
    expect(d.table.items.get(subject)).toEqual(before);
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:succeeded']);
    expect(await d.sweep()).toMatchObject({ examined: 0 });
  });

  it('the record\'s reply lost after its commit: the retry under the same action id is recognised, and nothing is recorded twice', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    await propose(d, subject);
    d.table.down.writes = false;
    d.loseRecordReplies(1);
    expect(await d.sweep()).toMatchObject({ published: 1, unrecorded: 0, alarms: [] });
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:succeeded']);
  });
});

describe('duplicate sweeps', () => {
  it('a second sweep while the first holds the lease publishes nothing and records nothing', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    await propose(d, subject);
    d.table.down.writes = false;
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const slow: StaffRevocationSignalPublisher = { ...d.signal, publish: async (s, id) => { entered(); await gate; return d.signal.publish(s, id); } };
    const first = d.sweep(slow);
    await inside;
    const second = await d.sweep();
    expect(second).toMatchObject({ released: true, sweep: 'held_elsewhere', examined: 0, published: 0 });
    open();
    expect(await first).toMatchObject({ sweep: 'completed', published: 1 });
    expect(d.table.writes.filter(w => w === `put:${subject}`)).toHaveLength(1);
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:succeeded']);
  });

  it('a sweep whose lease lapsed is fenced: its record is refused and it stops; the sweep that took over records the outcome', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    const result = await propose(d, subject);
    d.table.down.writes = false;
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const stalled: StaffRevocationSignalPublisher = { ...d.signal, publish: async (s, id) => { entered(); await gate; return d.signal.publish(s, id); } };
    const stale = d.sweep(stalled);
    await inside;
    await lapseLease();
    expect(await d.sweep()).toMatchObject({ sweep: 'completed', published: 1 });
    open();
    expect(await stale).toMatchObject({ sweep: 'lease_lost', alarms: ['lease_lost'] });
    // One item, the revocation's own; one success, recorded by the sweep that held the lease.
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:succeeded']);
  });

  it('a sweep id is never granted twice: a repeat after completion is refused, and a fresh sweep finds nothing due', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    await propose(d, subject);
    d.table.down.writes = false;
    const store = d.reconcilerStore();
    const sweepId = randomUUID();
    const claim = await store.claim(sweepId);
    if (!claim.granted) throw new Error('lease');
    const due = claim.due.find(item => item.subject === subject)!;
    expect(await store.record(sweepId, claim.generation, { actionId: randomUUID(), revocationId: due.revocationId, subject, outcome: 'succeeded' })).toBe('recorded');
    expect(await store.complete(sweepId, claim.generation)).toMatchObject({ completed: true });
    expect(await store.claim(sweepId)).toMatchObject({ granted: false });
    expect(await d.sweep()).toMatchObject({ examined: 0, unpublished: 0 });
  });
});

describe('the wrong subject', () => {
  it('publishes exactly the subject the revocation recorded: another login\'s revocation and another decision\'s pending item change nothing', async () => {
    const d = await deployment();
    const subject = await practitioner();
    const otherRevocation = randomUUID(), otherDecision = randomUUID();
    d.table.items.set('fictional-subject-other-login-0001', { subject: 'fictional-subject-other-login-0001', revocationId: otherRevocation, contract: 'staff-revocation-signal/2' });
    d.table.down.writes = true;
    const result = await propose(d, subject);
    d.table.down.writes = false;
    await d.signal.hold(subject, otherDecision);
    expect(await d.oldToken(COLLEAGUE_SUBJECT)).toBe(200);
    expect(await d.sweep()).toMatchObject({ published: 1, alarms: [] });
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(d.table.items.get('fictional-subject-other-login-0001')).toMatchObject({ revocationId: otherRevocation });
    expect(d.table.items.get(`pending#${subject}`)).toMatchObject({ decisionId: otherDecision });
    expect(await d.oldToken(subject)).toBe(403);
    expect(await d.oldToken(COLLEAGUE_SUBJECT)).toBe(200);
  });

  it('the database refuses to record a publication under any subject but the revocation\'s own, and the revocation stays due', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.down.writes = true;
    await propose(d, subject);
    d.table.down.writes = false;
    const store = d.reconcilerStore();
    const sweepId = randomUUID();
    const claim = await store.claim(sweepId);
    if (!claim.granted) throw new Error('lease');
    const due = claim.due.find(item => item.subject === subject)!;
    expect(await store.record(sweepId, claim.generation, { actionId: randomUUID(), revocationId: due.revocationId, subject: COLLEAGUE_SUBJECT, outcome: 'succeeded' })).toBe('subject_mismatch');
    expect(await store.record(sweepId, claim.generation, { actionId: randomUUID(), revocationId: randomUUID(), subject, outcome: 'succeeded' })).toBe('not_found');
    await store.complete(sweepId, claim.generation);
    expect(await signalRows(subject)).toEqual(['operator:failed']);
    const again = randomUUID();
    const next = await store.claim(again);
    if (!next.granted) throw new Error('lease');
    expect(next.due.map(item => item.revocationId)).toContain(due.revocationId);
    await store.complete(again, next.generation);
  });
});

/* -------------------------------------------------------------------------------------------- an old scheduled send */
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };
const BROADCAST_SUBJECT = 'An update about the Longevity Program';
/** The revoked practitioner's login, acting as the practice's admin: it approves, test-sends and schedules a broadcast. */
async function scheduledBySubject(d: Deployment, subject: string, sendInMs: number) {
  const ask = (request: WorkforceRequest) => d.e.staff.handle({ practiceId: PRACTICE, personId: ADMIN.personId, subject, email: ADMIN.email }, request);
  done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
  const page = await d.e.publicSide.joinPage('fictional-clinic', 'longevity-program');
  d.e.advance(FORM_MIN_MS + 10);
  await d.e.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email: 'avery@fictional.example', consent: 'yes', formToken: page!.formToken });
  expect(await d.e.publicSide.confirm(tokenFrom(d.e.ses.outbox.at(-1)!.text, '/join/confirm'))).toBe('confirmed');
  const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'October update',
    subject: BROADCAST_SUBJECT, blocks: [{ type: 'paragraph', text: 'Hello {{first_name|there}}, the program now offers evening consultations.' }, { type: 'button', label: 'Read about the program' }] } }));
  const t = o.templates.find(x => x.name === 'October update')!;
  done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
  const b = done(await ask({ action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: t.templateId })).broadcasts.find(x => x.templateId === t.templateId)!;
  done(await ask({ action: 'test_send', templateId: t.templateId, broadcastId: b.broadcastId }));
  done(await ask({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: new Date(d.e.now().getTime() + sendInMs).toISOString() }));
  return b.broadcastId;
}
const broadcastMail = (d: Deployment) => d.e.ses.outbox.filter(m => m.subject === BROADCAST_SUBJECT);
const broadcastHold = async (d: Deployment, broadcastId: string) => (await d.e.store.practice(PRACTICE).get<{ hold?: { reason: string } }>('broadcast', broadcastId))?.body.hold;

describe('an old scheduled send', () => {
  it.fails('OPEN (reproduction): with the writer down, a send the revoked login scheduled that falls due before the reconciler publishes goes out', async () => {
    const d = await deployment();
    const subject = await practitioner();
    await scheduledBySubject(d, subject, 0);
    d.table.down.writes = true;
    d.atCommit(async () => { await d.e.pass(); });
    await propose(d, subject);
    expect(broadcastMail(d)).toHaveLength(0);
  });

  it('a send the revoked login scheduled is held from the reconciler\'s publication on: nothing is sent after it, and the hold is recorded', async () => {
    const d = await deployment();
    const subject = await practitioner();
    const broadcastId = await scheduledBySubject(d, subject, 10 * MINUTE);
    d.table.down.writes = true;
    await propose(d, subject);
    // The schedule's sweeps: one during the outage, one after the writer recovers, both before the send is due.
    d.e.advance(MINUTE); d.advance(MINUTE);
    expect(await d.sweep()).toMatchObject({ failed: 1 });
    d.table.down.writes = false;
    d.e.advance(MINUTE); d.advance(MINUTE);
    expect(await d.sweep()).toMatchObject({ published: 1 });
    d.e.advance(10 * MINUTE);
    await d.e.pass();
    expect(broadcastMail(d)).toHaveLength(0);
    expect(await broadcastHold(d, broadcastId)).toMatchObject({ reason: 'authority_revoked' });
  });

  it('on a healthy table the pending signal pauses it at the commit, recording nothing; the publication then records the hold', async () => {
    const d = await deployment();
    const subject = await practitioner();
    const broadcastId = await scheduledBySubject(d, subject, 0);
    let pausedAtCommit: { sent: number; hold: unknown } | null = null;
    d.atCommit(async () => { await d.e.pass(); pausedAtCommit = { sent: broadcastMail(d).length, hold: await broadcastHold(d, broadcastId) }; });
    await propose(d, subject);
    expect(pausedAtCommit).toEqual({ sent: 0, hold: undefined });
    await d.e.pass();
    expect(broadcastMail(d)).toHaveLength(0);
    expect(await broadcastHold(d, broadcastId)).toMatchObject({ reason: 'authority_revoked' });
  });
});

describe('the final publication failing past the pending deadline', () => {
  const pendingOnly = (d: Deployment): StaffRevocationSignalPublisher => ({ ...d.signal, publish: async () => { throw unavailable(); } });

  it('with a sweep inside each pending window the old token stays refused past the deadline (the pending item is renewed), and is revoked for good once a publication lands', async () => {
    const d = await deployment();
    const subject = await practitioner();
    const result = await propose(d, subject, pendingOnly(d));
    d.advance(20 * MINUTE);
    expect(await d.sweep(pendingOnly(d))).toMatchObject({ failed: 1, renewed: 1, overdue: true, alarms: ['overdue'] });
    d.advance(PENDING_TTL_MS - 20 * MINUTE + MINUTE);
    expect(await d.oldToken(subject)).toBe(403);
    expect(await d.sweep()).toMatchObject({ published: 1, unpublished: 0, alarms: [] });
    d.advance(PENDING_TTL_MS + MINUTE);
    expect(d.table.items.get(subject)).toMatchObject({ revocationId: result.summary.revocationId });
    expect(await d.oldToken(subject)).toBe(403);
    expect(d.releases).toEqual([]);
  });

  it('a renewal never stands in for the publication: the revocation stays due, and every sweep says it is overdue until it is published', async () => {
    const d = await deployment();
    const subject = await practitioner();
    await propose(d, subject, pendingOnly(d));
    for (let i = 0; i < 3; i++) {
      d.advance(10 * MINUTE);
      expect(await d.sweep(pendingOnly(d))).toMatchObject({ failed: 1, renewed: 1, overdue: true });
    }
    expect(await signalRows(subject)).toEqual(['operator:failed', 'sweep:failed', 'sweep:failed', 'sweep:failed']);
  });
});

describe('no answer from the database, though the decision committed', () => {
  it('the pending item refuses until the reconciler publishes the committed revocation, without an operator: refused for good, past the deadline', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.loseNextDecisionReply();
    await expect(propose(d, subject)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await identityStatus(subject)).toBe('disabled');
    expect(await d.oldToken(subject)).toBe(403);
    await operatorsAway(async () => { expect(await d.sweep()).toMatchObject({ examined: 1, published: 1 }); });
    d.advance(PENDING_TTL_MS + MINUTE);
    expect(await d.oldToken(subject)).toBe(403);
    expect(await signalRows(subject)).toEqual(['sweep:succeeded']);
  });
});

describe('race order B with the owner\'s head start (a decision, not a default; constructed only in tests)', () => {
  /** The operator service behind the head start, over the deployment's own operator connection, with a sleep the test controls. */
  const headStarted = (d: Deployment, headStartMs: number, onSleep: () => void) => {
    const sleeps: number[] = [];
    const wrapped = withPendingHeadStart({ database: d.database, signal: d.signal, headStartMs,
      sleep: async ms => { sleeps.push(ms); onSleep(); await new Promise(resolve => setTimeout(resolve, 5)); } });
    return { sleeps, propose: (subject: string) => d.service(wrapped.signal, wrapped.database).propose(operator, { requestId: randomUUID(), identitySubject: subject, reason: 'suspected_compromise' }) };
  };

  it('configured, a pending write that lands within the head start is in place at the commit', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.delayWrites();
    let seen = 0;
    d.atCommit(async () => { seen = await d.oldToken(subject); });
    const { sleeps, propose: run } = headStarted(d, 250, () => d.table.arrive());
    expect((await run(subject)).summary.state).toBe('revoked');
    expect(sleeps).toEqual([250]);
    expect(seen).toBe(403);
  });

  it('configured, a pending write slower than the head start still leaves the old token admitted at the commit: N bounds the wait, not the gap', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.delayWrites();
    let seen = 0;
    d.atCommit(async () => { seen = await d.oldToken(subject); d.table.arrive(); });
    const { sleeps, propose: run } = headStarted(d, 250, () => undefined);
    await run(subject);
    expect(sleeps).toEqual([250]);
    expect(seen).toBe(200);
    expect(await d.oldToken(subject)).toBe(403);
  });

  it('configured, a signal table that never answers delays the clinical refusal by the head start alone, once', async () => {
    const d = await deployment();
    const subject = await practitioner();
    d.table.delayWrites();
    const { sleeps, propose: run } = headStarted(d, 250, () => undefined);
    const pending = run(subject);
    // The clinical refusal lands while the table still holds every write.
    await expect.poll(() => identityStatus(subject), { timeout: 2000, interval: 5 }).toBe('disabled');
    expect(sleeps).toEqual([250]);
    d.table.arrive();
    await pending;
  });
});
