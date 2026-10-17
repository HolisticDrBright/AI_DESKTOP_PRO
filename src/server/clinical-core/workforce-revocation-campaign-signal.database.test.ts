import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ClinicalCoreDatabase } from './database';
import {
  SIGNAL_STEP, WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC, WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_ROLLBACK_SHA256, WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_SHA256,
  WorkforceProviderFailure, createWorkforceIdentityRevocation, type ProviderStep, type StaffRevocationSignalPublisher,
} from './workforce-identity-revocation';

/**
 * The campaign staff revocation signal as a recorded step of the emergency revocation (the BLOCKED
 * workforce-revocation-campaign-signal.sql), on the real 106-migration production schema with the emergency revocation
 * applied. The operator service runs as it runs in production: the operator connection, refusals classified the same
 * way. The provider and the signal are fictional. Fictional rows only.
 *
 * First, with the emergency revocation alone: a signal publication that fails is recorded nowhere, and once the two
 * Cognito steps succeed the revocation leaves the work list, so the campaign API never learns of it (failing-before).
 * Then, with the successor: the publication is a third recorded step, and the revocation stays on the work list until
 * it is confirmed.
 */
const REVOCATION = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql';
const REVOCATION_ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation-rollback.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-revocation-campaign-signal.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-revocation-campaign-signal-rollback.sql';
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
  REVOCATION,
];
const SUMMARY = 'clinical_private.workforce_identity_revocation_summary(uuid)';
const RECORD = 'clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)';
const WORK = 'clinical_private.list_workforce_identity_revocation_work(text)';
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** The body between `as $$` and `$$;` of a function's definition in a file: what pg_proc.prosrc holds. */
const body = (file: string, name: string) => { const text = read(file); const at = text.indexOf(`function clinical_private.${name}(`);
  const start = text.indexOf('as $$', at) + 5; return text.slice(start, text.indexOf('$$;', start)); };
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
const prosrc = async (signature: string) => (await db.query<{ h: string | null }>(
  "select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as h from pg_proc where oid=to_regprocedure($1)", [signature])).rows[0]?.h ?? null;
const stepCheck = async () => (await db.query<{ d: string | null }>(`select pg_get_constraintdef(oid) as d from pg_constraint
  where conrelid='clinical_private.workforce_identity_provider_actions'::regclass and conname='workforce_identity_provider_actions_step_check'`)).rows[0]?.d ?? null;
const acl = async (signature: string) => (await db.query<{ a: string | null }>('select proacl::text as a from pg_proc where oid=to_regprocedure($1)', [signature])).rows[0]?.a ?? null;
const identityStatus = async (subject: string) => (await db.query<{ status: string }>(
  "select status from clinical_core.identities where identity_pool='workforce' and identity_subject=$1", [subject])).rows[0]!.status;
const steps = async (revocationId: string) => (await db.query<{ step: string; outcome: string }>(
  'select step, outcome from clinical_private.workforce_identity_provider_actions where revocation_id=$1 order by recorded_at, id', [revocationId])).rows.map(r => `${r.step}:${r.outcome}`);
const work = () => db.transaction(async tx => {
  await tx.exec('set local role clinical_workforce_operator');
  return (await tx.query<{ r: Array<{ proposalId: string; provider: string }> }>(`select ${WORK.replace(/\(.*$/, '')}($1) as r`, [operator])).rows[0]!.r;
});
/** The independent review, by a second operator, so that the work list holds an item only for its provider side. */
const review = (proposal: string) => db.transaction(async tx => {
  await tx.exec('set local role clinical_workforce_operator');
  await tx.query("select clinical_private.decide_workforce_identity_revocation($1,$2,'confirm')", [reviewer, proposal]);
});
const recordAction = (revocation: string, step: string, outcome: string, failure: string | null) => db.transaction(async tx => {
  await tx.exec('set local role clinical_workforce_operator');
  return (await tx.query<{ r: { provider: string } }>(`select ${RECORD.replace(/\(.*$/, '')}($1,$2,$3,$4,$5,$6) as r`,
    [operator, randomUUID(), revocation, step, outcome, failure])).rows[0]!.r;
});

/** The operator connection as the console's services see it: role-scoped, refusals classified as in production. */
const operatorDatabase: ClinicalCoreDatabase = { transaction: work => db.transaction(async raw => {
  await raw.exec('set local role clinical_workforce_operator');
  return work({ query: async (sql, parameters = []) => {
    try { return await raw.query(sql, parameters as unknown[]) as never; } catch (error) {
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: message(error) }) ?? error;
    }
  } });
}) };
/** A fictional provider and a fictional signal, each of which can be taken down; one call log for both, in order. */
function parts() {
  const calls: string[] = [];
  const up = { provider: true, signal: true };
  const published = new Map<string, string>();
  const provider = { revoke: async (step: ProviderStep, username: string) => {
    calls.push(`${step}:${username}`);
    if (!up.provider) throw new WorkforceProviderFailure('unavailable');
  } };
  const signal: StaffRevocationSignalPublisher = { publish: async (subject, revocationId) => {
    calls.push(`${SIGNAL_STEP}:${subject}`);
    if (!up.signal) throw new WorkforceProviderFailure('unavailable');
    if (!published.has(subject)) published.set(subject, revocationId);
  }, hold: async () => {}, release: async () => {} };
  return { calls, up, published, provider, signal };
}
const practitioner = async () => {
  const who = { person: randomUUID(), subject: randomUUID() };
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, 'subject_' + who.person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.subject]);
  return who;
};
const request = (who: { subject: string }) => ({ requestId: randomUUID(), identitySubject: who.subject, reason: 'suspected_compromise' });

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

let completedBefore: { subject: string; proposalId: string; revocationId: string };

describe('the emergency revocation alone (failing-before)', () => {
  it('records no signal step: a failed publication leaves no trace, and the revocation leaves the work list once Cognito is done', async () => {
    expect(await prosrc(SUMMARY)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentSummary);
    expect(await prosrc(RECORD)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentRecord);
    const p = parts();
    p.up.signal = false;
    const who = await practitioner();
    const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider: p.provider, signal: p.signal, release: 'qualification' });
    const result = await service.propose(operator, request(who));
    // The signal was attempted first and failed; the database refused to record it and the service could not keep it.
    expect(p.calls).toEqual([`campaign_signal:${who.subject}`, `disable_user:${who.subject}`, `global_sign_out:${who.subject}`]);
    expect(result.provider[0]).toEqual({ step: 'campaign_signal', outcome: 'failed', failure: 'unavailable' });
    expect(await steps(result.summary.revocationId!)).toEqual(['disable_user:succeeded', 'global_sign_out:succeeded']);
    expect(result.summary.provider).toBe('complete');
    await review(result.summary.proposalId);
    expect((await work()).map(item => item.proposalId)).not.toContain(result.summary.proposalId);
    // So no reconciliation ever retries it: the campaign API is never told.
    await service.reconcile(operator);
    expect(p.published.has(who.subject)).toBe(false);
    await expect(recordAction(result.summary.revocationId!, 'campaign_signal', 'succeeded', null)).rejects.toThrow(/workforce_identity_revocation_invalid/);
    completedBefore = { subject: who.subject, proposalId: result.summary.proposalId, revocationId: result.summary.revocationId! };
  });
});

describe('the successor', () => {
  it('is pinned, and changes the two parents by exactly the signal step', async () => {
    expect(sha(read(CANDIDATE))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_SHA256);
    expect(sha(read(ROLLBACK))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_ROLLBACK_SHA256);
    const name = { summary: 'workforce_identity_revocation_summary', record: 'record_workforce_identity_provider_action' };
    expect(sha(body(REVOCATION, name.summary))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentSummary);
    expect(sha(body(REVOCATION, name.record))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentRecord);
    expect(sha(body(CANDIDATE, name.summary))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.summary);
    expect(sha(body(CANDIDATE, name.record))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.record);
    expect(sha(body(ROLLBACK, name.summary))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentSummary);
    expect(sha(body(ROLLBACK, name.record))).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentRecord);
    expect(body(CANDIDATE, name.record)).toBe(body(REVOCATION, name.record).replace("_step not in ('disable_user','global_sign_out')",
      "_step not in ('disable_user','global_sign_out','campaign_signal')"));
    const removed = (text: string) => text.split('\n').filter(line => !body(CANDIDATE, name.summary).split('\n').includes(line));
    const added = body(CANDIDATE, name.summary).split('\n').filter(line => !body(REVOCATION, name.summary).split('\n').includes(line));
    expect(removed(body(REVOCATION, name.summary)).map(l => l.trim())).toEqual(['_disable text; _signout text;',
      "when _disable = 'succeeded' and _signout = 'succeeded' then 'complete'", "when _disable = 'failed' or _signout = 'failed' then 'failed'"]);
    expect(added.map(l => l.trim())).toEqual(['_disable text; _signout text; _signal text;',
      'select a.outcome into _signal from clinical_private.workforce_identity_provider_actions a',
      "where a.revocation_id = _r.id and a.step = 'campaign_signal' order by a.recorded_at desc, a.id desc limit 1;",
      "when _disable = 'succeeded' and _signout = 'succeeded' and _signal = 'succeeded' then 'complete'",
      "when _disable = 'failed' or _signout = 'failed' or _signal = 'failed' then 'failed'"]);
    // Nothing else is touched: two guards, the step check, the two functions, two post-checks. No table, row, role or grant.
    const statements = splitPostgresStatements(read(CANDIDATE)).map(statement => statement.replace(/^(?:\s*--.*\n)*\s*/, '').split(/\s+/).slice(0, 4).join(' '));
    expect(statements).toEqual(['begin', 'do $guard$ begin if', 'do $parent$ declare _p', 'alter table clinical_private.workforce_identity_provider_actions drop',
      'create or replace function', 'create or replace function', 'do $check$ declare _p', 'do $constraint$ begin if', 'commit']);
  });

  it('applies on its exact parent only; the grants and every record are kept', async () => {
    const before = { summary: await acl(SUMMARY), record: await acl(RECORD),
      rows: (await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_identity_provider_actions')).rows[0]!.n };
    await exec(CANDIDATE);
    expect(await prosrc(SUMMARY)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.summary);
    expect(await prosrc(RECORD)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.record);
    expect(await stepCheck()).toBe("CHECK ((step = ANY (ARRAY['disable_user'::text, 'global_sign_out'::text, 'campaign_signal'::text])))");
    expect({ summary: await acl(SUMMARY), record: await acl(RECORD),
      rows: (await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_identity_provider_actions')).rows[0]!.n }).toEqual(before);
    await expect(exec(CANDIDATE)).rejects.toThrow(/revocation_campaign_signal_parent_refused/);
  });

  it('a revocation completed before it was applied returns to the work list until its signal is published', async () => {
    const item = (await work()).find(x => x.proposalId === completedBefore.proposalId);
    expect(item).toMatchObject({ provider: 'pending' });
    const p = parts();
    const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider: p.provider, signal: p.signal, release: 'qualification' });
    const reconciled = (await service.reconcile(operator)).find(x => x.proposalId === completedBefore.proposalId);
    expect(reconciled?.summary.provider).toBe('complete');
    expect(p.published.get(completedBefore.subject)).toBe(completedBefore.revocationId);
    expect((await work()).map(x => x.proposalId)).not.toContain(completedBefore.proposalId);
  });

  it('the signal goes first; a signal outage never delays the login refusal or the Cognito steps, and keeps the item actionable', async () => {
    const p = parts();
    p.up.signal = false;
    const who = await practitioner();
    const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider: p.provider, signal: p.signal, release: 'qualification' });
    const result = await service.propose(operator, request(who));
    await review(result.summary.proposalId);
    expect(await identityStatus(who.subject)).toBe('disabled');
    expect(p.calls).toEqual([`campaign_signal:${who.subject}`, `disable_user:${who.subject}`, `global_sign_out:${who.subject}`]);
    expect(result.provider).toEqual([{ step: 'campaign_signal', outcome: 'failed', failure: 'unavailable' },
      { step: 'disable_user', outcome: 'succeeded' }, { step: 'global_sign_out', outcome: 'succeeded' }]);
    expect(result.summary.provider).toBe('failed');
    expect(await steps(result.summary.revocationId!)).toEqual(['campaign_signal:failed', 'disable_user:succeeded', 'global_sign_out:succeeded']);
    expect((await work()).find(x => x.proposalId === result.summary.proposalId)).toMatchObject({ provider: 'failed' });
    p.up.signal = true;
    const reconciled = (await service.reconcile(operator)).find(x => x.proposalId === result.summary.proposalId);
    expect(reconciled?.summary.provider).toBe('complete');
    expect(p.published.get(who.subject)).toBe(result.summary.revocationId);
    expect((await work()).map(x => x.proposalId)).not.toContain(result.summary.proposalId);
  });

  it('a Cognito outage does not hold back the signal: it is published at once, and Cognito is retried', async () => {
    const p = parts();
    p.up.provider = false;
    const who = await practitioner();
    const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider: p.provider, signal: p.signal, release: 'qualification' });
    const result = await service.propose(operator, request(who));
    expect(p.published.get(who.subject)).toBe(result.summary.revocationId);
    expect(result.summary.provider).toBe('failed');
    p.up.provider = true;
    expect((await service.reconcile(operator)).find(x => x.proposalId === result.summary.proposalId)?.summary.provider).toBe('complete');
  });

  it('complete only when all three last succeeded; failed when any last failed; pending otherwise', async () => {
    const p = parts();
    const who = await practitioner();
    // A service with no signal configured records only the Cognito steps: under the successor that is never complete.
    const noSignal = createWorkforceIdentityRevocation({ database: operatorDatabase, provider: p.provider, release: 'qualification' });
    const result = await noSignal.propose(operator, request(who));
    expect(result.provider.map(x => x.step)).toEqual(['disable_user', 'global_sign_out']);
    expect(result.summary.provider).toBe('pending');
    const id = result.summary.revocationId!;
    expect((await recordAction(id, 'campaign_signal', 'failed', 'throttled')).provider).toBe('failed');
    expect((await recordAction(id, 'campaign_signal', 'succeeded', null)).provider).toBe('complete');
    expect((await recordAction(id, 'disable_user', 'failed', 'timeout')).provider).toBe('failed');
    expect((await recordAction(id, 'disable_user', 'succeeded', null)).provider).toBe('complete');
    await expect(recordAction(id, 'campaign_signal', 'succeeded', 'unknown')).rejects.toThrow(/workforce_identity_revocation_invalid/);
    await expect(recordAction(id, 'restore_login', 'succeeded', null)).rejects.toThrow(/workforce_identity_revocation_invalid/);
  });

  it('records stay append-only, the signal step included', async () => {
    for (const sql of ["update clinical_private.workforce_identity_provider_actions set outcome='succeeded' where step='campaign_signal'",
      "delete from clinical_private.workforce_identity_provider_actions where step='campaign_signal'"]) {
      await expect(db.query(sql)).rejects.toThrow();
    }
  });

  it('rollback restores both parents exactly, keeps every record and the widened check, and refuses twice', async () => {
    const rows = (await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_identity_provider_actions')).rows[0]!.n;
    const signals = (await db.query<{ n: number }>("select count(*)::int as n from clinical_private.workforce_identity_provider_actions where step='campaign_signal'")).rows[0]!.n;
    expect(signals).toBeGreaterThan(0);
    await exec(ROLLBACK);
    expect(await prosrc(SUMMARY)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentSummary);
    expect(await prosrc(RECORD)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentRecord);
    expect((await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_identity_provider_actions')).rows[0]!.n).toBe(rows);
    expect(await stepCheck()).toMatch(/campaign_signal/);
    await expect(recordAction(completedBefore.revocationId, 'campaign_signal', 'succeeded', null)).rejects.toThrow(/workforce_identity_revocation_invalid/);
    await expect(exec(ROLLBACK)).rejects.toThrow(/revocation_campaign_signal_rollback_refused/);
    // It can be applied again over its own rollback (the check it left widened), and rolled back again.
    await exec(CANDIDATE);
    expect(await prosrc(SUMMARY)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.summary);
    await exec(ROLLBACK);
    expect(await prosrc(SUMMARY)).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.parentSummary);
    // The emergency revocation's own rollback still applies after it, and re-enables nobody.
    await exec(REVOCATION_ROLLBACK);
    expect(await identityStatus(completedBefore.subject)).toBe('disabled');
  });
});
