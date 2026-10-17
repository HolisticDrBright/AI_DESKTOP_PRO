import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import {
  REVOCATION_SIGNAL_RECONCILER_ROLE, WORKFORCE_REVOCATION_SIGNAL_RECONCILER_PROSRC, WORKFORCE_REVOCATION_SIGNAL_RECONCILER_ROLLBACK_SHA256,
  WORKFORCE_REVOCATION_SIGNAL_RECONCILER_SHA256,
} from './revocation-signal-reconciler';
import { WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC } from './workforce-identity-revocation';

/**
 * The BLOCKED workforce-revocation-signal-reconciler.sql on the real 106-migration production schema, over the
 * emergency revocation and its campaign-signal successor. What the reconciler's database role can do, and nothing
 * else: claim the lease and the due list from the existing revocation records, record a campaign_signal attempt for
 * the subject the revocation recorded, complete. No operator is involved. PGlite is one connection: the lease's
 * row locks are exercised for their logic, not for two sessions racing (that is Codex's native qualification).
 * Fictional rows only.
 */
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-revocation-signal-reconciler.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-revocation-signal-reconciler-rollback.sql';
const SIGNAL = 'infra/aws-clinical-core/source-candidates/workforce-revocation-campaign-signal.sql';
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
  'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql',
];
const FUNCTIONS = {
  status: 'clinical_private.workforce_revocation_signal_reconciler_status()',
  claim: 'clinical_revocation_signal.claim_sweep(uuid,integer)',
  record: 'clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)',
  complete: 'clinical_revocation_signal.complete_sweep(uuid,bigint)',
} as const;
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const body = (file: string, name: string) => { const text = read(file); const at = text.indexOf(`function ${name}(`);
  const start = text.indexOf('as $$', at) + 5; return text.slice(start, text.indexOf('$$;', start)); };

let db: PGlite;
const operator = randomUUID(), reviewer = randomUUID();
let parentRefusal = '';
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
/** One call under a role, in its own transaction. */
async function as<T>(role: string, sql: string, parameters: unknown[] = []): Promise<T> {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    return (await tx.query<{ r: T }>(sql, parameters)).rows[0]!.r;
  });
}
type Claim = { granted: boolean; generation?: number; due?: Array<{ revocationId: string; subject: string; attempts: number; lastAttemptAt: string | null }>; unpublished: number; oldestUnpublishedAt: string | null; lastCompletedAt: string | null; reason?: string };
const claim = (sweepId: string, limit = 100) => as<Claim>(REVOCATION_SIGNAL_RECONCILER_ROLE, 'select clinical_revocation_signal.claim_sweep($1::uuid,$2::integer) as r', [sweepId, limit]);
const record = (sweepId: string, generation: number, actionId: string, revocationId: string, subject: string, outcome: string, failure: string | null) =>
  as<{ result: string; duplicate?: boolean }>(REVOCATION_SIGNAL_RECONCILER_ROLE, 'select clinical_revocation_signal.record_attempt($1::uuid,$2::bigint,$3::uuid,$4::uuid,$5::text,$6::text,$7::text) as r',
    [sweepId, generation, actionId, revocationId, subject, outcome, failure]);
const complete = (sweepId: string, generation: number) => as<{ completed: boolean; unpublished: number; lastCompletedAt: string | null }>(REVOCATION_SIGNAL_RECONCILER_ROLE,
  'select clinical_revocation_signal.complete_sweep($1::uuid,$2::bigint) as r', [sweepId, generation]);
const lapse = () => db.query("update clinical_private.workforce_revocation_signal_reconciler_lease set lease_until = clock_timestamp() - interval '1 second' where singleton and holder is not null");
/** A practitioner whose login is revoked by the operator (independent review after), with the signal step as given. */
async function revoked(signal: Array<'succeeded' | 'failed'> = [], cognito = true) {
  const person = randomUUID(), subject = randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [person, subject]);
  const summary = await as<{ revocationId: string; proposalId: string }>('clinical_workforce_operator',
    "select clinical_private.propose_workforce_identity_revocation($1,$2,$3,'suspected_compromise') as r", [operator, randomUUID(), subject]);
  const step = (name: string, outcome: string) => as('clinical_workforce_operator', 'select clinical_private.record_workforce_identity_provider_action($1,$2,$3,$4,$5,$6) as r',
    [operator, randomUUID(), summary.revocationId, name, outcome, outcome === 'failed' ? 'unavailable' : null]);
  if (cognito) { await step('disable_user', 'succeeded'); await step('global_sign_out', 'succeeded'); }
  for (const outcome of signal) await step('campaign_signal', outcome);
  return { subject, ...summary };
}
/** Publishes everything due, so each test starts with nothing unpublished. */
async function drain() {
  await lapse();
  const sweepId = randomUUID();
  const c = await claim(sweepId, 200);
  if (!c.granted) throw new Error('drain lease');
  for (const item of c.due!) await record(sweepId, c.generation!, randomUUID(), item.revocationId, item.subject, 'succeeded', null);
  await complete(sweepId, c.generation!);
}
const summaryOf = (proposalId: string) => db.query<{ r: { provider: string } }>('select clinical_private.workforce_identity_revocation_summary($1) as r', [proposalId]).then(r => r.rows[0]!.r);

beforeAll(async () => {
  const schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
  expect(schema.manifest.migrations).toHaveLength(106);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of CHAIN) await exec(file);
  // Over the emergency revocation alone, without the campaign-signal successor, it refuses its parent.
  parentRefusal = await exec(CANDIDATE).then(() => 'applied', (error: unknown) => String(error));
  await exec(SIGNAL);
  await exec(CANDIDATE);
  await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'active'),($2,'active')", [operator, reviewer]);
  await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after' where singleton");
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('the reconciler candidate', () => {
  it('refuses a parent without the campaign-signal successor, and leaves nothing behind when it does', async () => {
    expect(parentRefusal).toMatch(/revocation_signal_reconciler_parent_refused/);
  });

  it('the files and every function body are the ones recorded in source, and the parents are untouched', async () => {
    expect(sha(read(CANDIDATE))).toBe(WORKFORCE_REVOCATION_SIGNAL_RECONCILER_SHA256);
    expect(sha(read(ROLLBACK))).toBe(WORKFORCE_REVOCATION_SIGNAL_RECONCILER_ROLLBACK_SHA256);
    for (const [key, signature] of Object.entries(FUNCTIONS)) {
      const name = signature.replace(/\(.*$/, '');
      expect([key, await prosrc(signature)]).toEqual([key, WORKFORCE_REVOCATION_SIGNAL_RECONCILER_PROSRC[key as keyof typeof FUNCTIONS]]);
      expect([key, sha(body(CANDIDATE, name))]).toEqual([key, WORKFORCE_REVOCATION_SIGNAL_RECONCILER_PROSRC[key as keyof typeof FUNCTIONS]]);
    }
    expect(await prosrc('clinical_private.workforce_identity_revocation_summary(uuid)')).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.summary);
    expect(await prosrc('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.record);
    expect(await prosrc('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')).toBe('3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b');
  });

  it('its role is NOLOGIN, NOINHERIT and a member of nothing; it uses only its own schema, holds no table, and is granted exactly the three entry points', async () => {
    const role = (await db.query<{ rolcanlogin: boolean; rolinherit: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      'select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname=$1', [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows[0];
    expect(role).toEqual({ rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    expect((await db.query('select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=$1', [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows).toEqual([]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from information_schema.role_table_grants where grantee=$1", [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows[0]!.n).toBe(0);
    // The schemas it may use, apart from the system catalogs and the public schema every role sees.
    const schemas = (await db.query<{ s: string }>(`select nspname as s from pg_namespace where has_schema_privilege($1, oid, 'usage')
      and nspname not in ('pg_catalog','information_schema','public') and nspname not like 'pg\\_%' order by 1`, [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows.map(r => r.s);
    expect(schemas).toEqual(['clinical_revocation_signal']);
    const executable = (await db.query<{ f: string }>(`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where has_schema_privilege($1, n.oid, 'usage') and has_function_privilege($1, p.oid, 'execute') and n.nspname not in ('pg_catalog','information_schema','public')
      order by 1`, [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows.map(r => r.f);
    expect(executable).toEqual([FUNCTIONS.claim, FUNCTIONS.complete, FUNCTIONS.record].sort());
    // Granted by name: exactly these three ACL entries anywhere in the database.
    const granted = (await db.query<{ f: string }>(`select p.oid::regprocedure::text as f from pg_proc p, aclexplode(p.proacl) a
      where a.grantee = (select oid from pg_roles where rolname=$1) order by 1`, [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows.map(r => r.f);
    expect(granted).toEqual([FUNCTIONS.claim, FUNCTIONS.complete, FUNCTIONS.record].sort());
    for (const f of ['clinical_private.propose_workforce_identity_revocation(text,uuid,text,text)', 'clinical_private.decide_workforce_identity_revocation(text,uuid,text)',
      'clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)', 'clinical_private.list_workforce_identity_revocation_work(text)']) {
      expect([f, (await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'execute') as ok", [REVOCATION_SIGNAL_RECONCILER_ROLE, f])).rows[0]!.ok]).toEqual([f, false]);
    }
    for (const other of ['clinical_core_api', 'clinical_workforce_application', 'clinical_workforce_operator']) {
      expect([other, (await db.query<{ ok: boolean }>("select has_schema_privilege($1,'clinical_revocation_signal','usage') as ok", [other])).rows[0]!.ok]).toEqual([other, false]);
      for (const f of [FUNCTIONS.status, FUNCTIONS.claim, FUNCTIONS.record, FUNCTIONS.complete]) {
        expect([other, f, (await db.query<{ ok: boolean }>("select has_function_privilege($1,$2,'execute') as ok", [other, f])).rows[0]!.ok]).toEqual([other, f, false]);
      }
    }
    await expect(as(REVOCATION_SIGNAL_RECONCILER_ROLE, 'select count(*) as r from clinical_private.workforce_identity_revocations')).rejects.toThrow(/permission denied/);
    await expect(as(REVOCATION_SIGNAL_RECONCILER_ROLE, 'select clinical_private.workforce_revocation_signal_reconciler_status() as r')).rejects.toThrow(/permission denied/);
    await expect(as(REVOCATION_SIGNAL_RECONCILER_ROLE, "update clinical_private.workforce_revocation_signal_reconciler_lease set holder=null where singleton returning true as r")).rejects.toThrow(/permission denied/);
  });

  it('found, not changed here: PUBLIC holds EXECUTE on clinical_private functions, so a role must never be given USAGE there to reach one function', async () => {
    const reachable = (await db.query<{ f: string; definer: boolean }>(`select p.oid::regprocedure::text as f, p.prosecdef as definer from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='clinical_private'
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type='EXECUTE') order by 1`)).rows;
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable.map(r => r.f)).toContain('clinical_private.move_entitlement(uuid,text,integer,text,uuid,text,uuid)');
    expect(reachable.find(r => r.f.startsWith('clinical_private.move_entitlement('))?.definer).toBe(true);
  });
});

describe('claim: the lease and the due list, from the records', () => {
  it('lists every revocation whose signal is not confirmed, never attempted first, then least recently attempted; a confirmed one never', async () => {
    await drain();
    const confirmed = await revoked(['failed', 'succeeded']);
    const olderFailure = await revoked(['failed']);
    const never = await revoked([]);
    const newerFailure = await revoked(['failed']);
    const sweepId = randomUUID();
    const c = await claim(sweepId);
    expect(c).toMatchObject({ granted: true, unpublished: 3 });
    expect(c.due!.map(item => item.subject)).toEqual([never.subject, olderFailure.subject, newerFailure.subject]);
    expect(c.due!.map(item => item.attempts)).toEqual([0, 1, 1]);
    expect(c.due!.map(item => item.subject)).not.toContain(confirmed.subject);
    expect(c.due![0]).toMatchObject({ revocationId: never.revocationId, lastAttemptAt: null });
    const limited = await (async () => { await complete(sweepId, c.generation!); const id = randomUUID(); const l = await claim(id, 2); await complete(id, l.generation!); return l; })();
    expect(limited.due).toHaveLength(2);
    expect(limited.unpublished).toBe(3);
  });

  it('one holder at a time; the holder claiming again keeps its generation; a lapsed lease is taken over with the next, and the stale holder is fenced', async () => {
    await drain();
    const item = await revoked([]);
    const a = randomUUID(), b = randomUUID();
    const first = await claim(a);
    expect(first.granted).toBe(true);
    expect(await claim(b)).toMatchObject({ granted: false });
    expect(await claim(a)).toMatchObject({ granted: true, generation: first.generation });
    await lapse();
    const second = await claim(b);
    expect(second).toMatchObject({ granted: true, generation: first.generation! + 1 });
    expect(await record(a, first.generation!, randomUUID(), item.revocationId, item.subject, 'succeeded', null)).toEqual({ result: 'lease_lost' });
    expect(await complete(a, first.generation!)).toMatchObject({ completed: false });
    expect(await record(b, second.generation!, randomUUID(), item.revocationId, item.subject, 'succeeded', null)).toEqual({ result: 'recorded', duplicate: false });
    expect(await complete(b, second.generation!)).toMatchObject({ completed: true, lastCompletedAt: expect.any(String) });
    // A sweep id is never granted again, whether it completed or lost its lease.
    expect(await claim(b)).toMatchObject({ granted: false, reason: 'sweep_id_used' });
    expect(await claim(a)).toMatchObject({ granted: false, reason: 'sweep_id_used' });
  });

  it('a sweep id that is a registered operator subject is refused: a reconciler record can never read as an operator\'s', async () => {
    await expect(claim(operator)).rejects.toThrow(/workforce_revocation_signal_sweep_refused/);
  });

  it('refuses a limit outside 1 to 200', async () => {
    await expect(claim(randomUUID(), 0)).rejects.toThrow(/workforce_revocation_signal_sweep_invalid/);
    await expect(claim(randomUUID(), 201)).rejects.toThrow(/workforce_revocation_signal_sweep_invalid/);
  });
});

describe('record: one campaign_signal attempt, into the existing append-only records', () => {
  it('is idempotent by its action id, refuses other content under the same id, and names the sweep that recorded it', async () => {
    await drain();
    const item = await revoked([]);
    const sweepId = randomUUID(), actionId = randomUUID();
    const c = await claim(sweepId);
    expect(await record(sweepId, c.generation!, actionId, item.revocationId, item.subject, 'failed', 'throttled')).toEqual({ result: 'recorded', duplicate: false });
    expect(await record(sweepId, c.generation!, actionId, item.revocationId, item.subject, 'failed', 'throttled')).toEqual({ result: 'recorded', duplicate: true });
    await expect(record(sweepId, c.generation!, actionId, item.revocationId, item.subject, 'succeeded', null)).rejects.toThrow(/workforce_identity_revocation_conflict/);
    const rows = (await db.query<{ step: string; outcome: string; recorded_by: string }>(
      'select step, outcome, recorded_by from clinical_private.workforce_identity_provider_actions where action_id=$1', [actionId])).rows;
    expect(rows).toEqual([{ step: 'campaign_signal', outcome: 'failed', recorded_by: sweepId }]);
    await complete(sweepId, c.generation!);
  });

  it('only for the subject the revocation recorded, and only for a revocation that exists: otherwise nothing is written', async () => {
    await drain();
    const item = await revoked([]);
    const other = await revoked([]);
    const sweepId = randomUUID();
    const c = await claim(sweepId);
    const before = (await db.query('select id from clinical_private.workforce_identity_provider_actions')).rows.length;
    expect(await record(sweepId, c.generation!, randomUUID(), item.revocationId, other.subject, 'succeeded', null)).toEqual({ result: 'subject_mismatch' });
    expect(await record(sweepId, c.generation!, randomUUID(), randomUUID(), item.subject, 'succeeded', null)).toEqual({ result: 'not_found' });
    expect((await db.query('select id from clinical_private.workforce_identity_provider_actions')).rows.length).toBe(before);
    await complete(sweepId, c.generation!);
  });

  it('refuses malformed input', async () => {
    const sweepId = randomUUID();
    const c = await claim(sweepId);
    const item = (await revoked([]));
    for (const [outcome, failure] of [['maybe', null], ['failed', null], ['succeeded', 'throttled'], ['failed', 'because']] as const) {
      await expect(record(sweepId, c.generation!, randomUUID(), item.revocationId, item.subject, outcome, failure), `${outcome}/${failure}`).rejects.toThrow(/workforce_revocation_signal_attempt_invalid/);
    }
    await expect(record(sweepId, 0, randomUUID(), item.revocationId, item.subject, 'succeeded', null)).rejects.toThrow(/workforce_revocation_signal_attempt_invalid/);
    await expect(record(sweepId, c.generation!, randomUUID(), item.revocationId, 'bad subject!', 'succeeded', null)).rejects.toThrow(/workforce_revocation_signal_attempt_invalid/);
    await complete(sweepId, c.generation!);
  });

  it('the reconciler\'s success completes the summary the operator reads, beside the Cognito steps', async () => {
    await drain();
    const item = await revoked(['failed']);
    expect((await summaryOf(item.proposalId)).provider).toBe('failed');
    await drain();
    expect((await summaryOf(item.proposalId)).provider).toBe('complete');
    const cognitoPending = await revoked([], false);
    await drain();
    expect((await summaryOf(cognitoPending.proposalId)).provider).toBe('pending');
  });
});

describe('no operator is involved', () => {
  it('with every operator disabled, the reconciler claims, records and completes; the operator path refuses', async () => {
    await drain();
    const item = await revoked(['failed']);
    await db.query("update clinical_private.workforce_platform_operators set status='disabled'");
    try {
      await expect(as('clinical_workforce_operator', 'select clinical_private.list_workforce_identity_revocation_work($1) as r', [operator])).rejects.toThrow(/workforce_operator_refused/);
      const sweepId = randomUUID();
      const c = await claim(sweepId);
      expect(c.due!.map(d => d.subject)).toContain(item.subject);
      expect(await record(sweepId, c.generation!, randomUUID(), item.revocationId, item.subject, 'succeeded', null)).toMatchObject({ result: 'recorded' });
      expect(await complete(sweepId, c.generation!)).toMatchObject({ completed: true, unpublished: 0 });
    } finally { await db.query("update clinical_private.workforce_platform_operators set status='active'"); }
  });

  it('the sweep log is append-only, even for its owner', async () => {
    await drain();
    await expect(db.query('update clinical_private.workforce_revocation_signal_sweeps set generation = generation')).rejects.toThrow(/append_only_record/);
    await expect(db.query('delete from clinical_private.workforce_revocation_signal_sweeps')).rejects.toThrow(/append_only_record/);
  });
});

describe('the rollback', () => {
  it('keeps every record and leaves the parents as it found them; the candidate applies again over it; then the parents roll back in order', async () => {
    await drain();
    const item = await revoked(['failed']);
    await drain();
    const counts = async () => (await db.query<{ sweeps: number; actions: number }>(`select (select count(*)::int from clinical_private.workforce_revocation_signal_sweeps) as sweeps,
      (select count(*)::int from clinical_private.workforce_identity_provider_actions) as actions`)).rows[0]!;
    const before = await counts();
    await exec(ROLLBACK);
    for (const signature of Object.values(FUNCTIONS)) expect([signature, await prosrc(signature)]).toEqual([signature, null]);
    expect(await counts()).toEqual(before);
    expect(await prosrc('clinical_private.workforce_identity_revocation_summary(uuid)')).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.summary);
    expect(await prosrc('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')).toBe(WORKFORCE_REVOCATION_CAMPAIGN_SIGNAL_PROSRC.record);
    expect((await summaryOf(item.proposalId)).provider).toBe('complete');
    expect((await db.query<{ n: string | null }>("select to_regnamespace('clinical_revocation_signal')::text as n")).rows[0]!.n).toBeNull();
    expect((await db.query<{ ok: boolean }>("select has_schema_privilege($1,'clinical_private','usage') as ok", [REVOCATION_SIGNAL_RECONCILER_ROLE])).rows[0]!.ok).toBe(false);
    // Applied again over its own rollback, the lease and the sweep log carry on.
    await exec(CANDIDATE);
    expect(await counts()).toEqual(before);
    const sweepId = randomUUID();
    const c = await claim(sweepId);
    expect(c).toMatchObject({ granted: true, unpublished: 0 });
    await complete(sweepId, c.generation!);
    // Then everything rolls back in order: this, the campaign-signal successor, the emergency revocation.
    await exec(ROLLBACK);
    await exec('infra/aws-clinical-core/source-candidates/workforce-revocation-campaign-signal-rollback.sql');
    await exec('infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation-rollback.sql');
    expect(await counts()).toEqual({ ...before, sweeps: before.sweeps + 1 });
  });
});
