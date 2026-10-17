import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';

/**
 * Clinic continuity negatives on the FULL BLOCKED candidate chain: the emergency revocation, the ordinary-suspension
 * window, the consent-decision candidate and the grant-paths successor, over their parents, on the real 106-migration
 * schema. That is the one stack in which every owner decision made so far is represented at once:
 *
 *   - ordinary suspension: an already-valid session reads, read-only, until its own token expires; a refreshed token
 *     does not inherit that (the window);
 *   - a compromised login is refused at once (the emergency revocation);
 *   - new practitioner consent grants are refused in a suspended clinic, withdrawals remain possible (D2(B));
 *   - authorized retention cleanup continues.
 *
 * Each case is labelled by what it is: COVERAGE (an invariant that holds, with the test that shows it), OPEN (a
 * demonstrable gap, written as `it.fails`: it is the invariant, and it fails on this chain), or HELD (current behaviour
 * pinned because the owner has not decided it: D3, D4, D5, the time bound on withdrawals). Nothing here decides a policy
 * for clinic amendment, guardian access or reactivation. Fictional rows only. PGlite is one process and one session: it
 * is not Aurora, and it cannot interleave two transactions.
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const SOURCE = 'infra/aws-clinical-core/source-candidates/';
const FULL_CHAIN = [
  `${SOURCE}workforce-token-binding-lookup.sql`, `${SOURCE}workforce-clinic-approved-onboarding.sql`,
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql', `${SOURCE}workforce-join-review-uniform-refusal.sql`,
  `${SOURCE}workforce-current-membership-context.sql`, `${SOURCE}workforce-onboarding-approval-authority.sql`,
  `${SOURCE}workforce-identity-emergency-revocation.sql`, `${SOURCE}workforce-ordinary-suspension-window.sql`,
  `${SOURCE}workforce-consent-decision-clinic-status.sql`, `${SOURCE}workforce-consent-grant-paths-clinic-status.sql`,
];
const WITHOUT_WINDOW = FULL_CHAIN.filter(file => !file.endsWith('workforce-ordinary-suspension-window.sql'));

let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
});
async function build(files: readonly string[]) {
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of files) for (const statement of splitPostgresStatements(read(file))) await db.exec(statement);
  return db;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
  const text = message(error);
  const category = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category;
  return `refused:${category ?? 'unclassified'}:${(text.match(/\b[a-z_]+_(?:refused|held|required)\b|read-only transaction/) ?? [text])[0]}`;
});
const CLOSED = 'refused:identity_refused:request_context_refused';
const HELD_WRITE = 'refused:operation_refused:ordinary_suspension_write_held';
const READ_ONLY = 'refused:unclassified:read-only transaction';
const OPERATOR_REQUIRED = /recording_cleanup_operator_required/;

type Evidence = { iat: number; exp: number; access: 'read' | 'write' };
/** A token as Cognito issues it, `issuedSecondsAgo` before now, valid for `lifetime` seconds. */
const token = (issuedSecondsAgo: number, access: 'read' | 'write' = 'read', lifetime = 3600): Evidence => {
  const iat = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
  return { iat, exp: iat + lifetime, access };
};
/** Issued ten minutes before the suspension: the window's already-valid session. */
const BEFORE = (access: 'read' | 'write' = 'read') => token(600, access);
/** Issued now, after the suspension: a refreshed (or new) token. */
const REFRESHED = (access: 'read' | 'write' = 'read') => token(0, access);

function harness(db: () => PGlite) {
  const ids = { clinic: '', sibling: '', practitioner: '', colleague: '', operator: '', service: '', reviewer: '', consumer: '',
    patient: '', connection: '', artifact: '' };
  const subject = (person: string, pool = 'workforce') => `subject-${pool}-${person}`;
  const setup = async () => {
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) ids[key] = randomUUID();
    await db().query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic'),($2,'FICTIONAL sibling clinic')", [ids.clinic, ids.sibling]);
    for (const [id, pool] of [[ids.practitioner, 'workforce'], [ids.colleague, 'workforce'], [ids.operator, 'workforce'], [ids.service, 'workforce'],
      [ids.reviewer, 'workforce'], [ids.consumer, 'consumer']] as const) {
      await db().query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db().query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id, pool)]);
    }
    await db().query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values
      ($1,$3,'practitioner'),($2,$3,'practitioner'),($1,$4,'practitioner'),($1,$5,'staff')`, [ids.clinic, ids.sibling, ids.practitioner, ids.colleague, ids.operator]);
    await db().query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
      [ids.patient, ids.clinic, 'patient_' + ids.patient.replaceAll('-', '')]);
    await db().query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
      [ids.connection, ids.clinic, ids.patient, ids.consumer]);
    await db().query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'forms_checkins',$3,$4,'US-FICTIONAL','approved',clock_timestamp(),$5)`, [ids.artifact, ids.clinic, `fictional-${ids.artifact.slice(0, 8)}`, 'c'.repeat(64), ids.reviewer]);
  };
  /** One legacy request as its service runs it: the seven values, or the same with the verified token's evidence. */
  const as = (who: string, purpose: string, sql: string, args: unknown[] = [], o: { evidence?: Evidence; pool?: string; clinic?: string } = {}) =>
    db().transaction(async tx => {
      const pool = o.pool ?? 'workforce';
      const values = [who, o.clinic ?? ids.clinic, pool, subject(who, pool), purpose];
      await tx.exec('set local role clinical_core_api');
      if (o.evidence) await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi',$6,$7,$8)",
        [...values, o.evidence.iat, o.evidence.exp, o.evidence.access]);
      else await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", values);
      return (await tx.query<Record<string, unknown>>(sql, args)).rows;
    });
  const status = (value: string, clinic = ids.clinic) => db().query('update clinical_core.organizations set status=$2 where id=$1', [clinic, value]);
  // Recording consent: an in-progress encounter, a participant, an approved consent release, a grant.
  const recordingGrant = async () => {
    const encounter = (await as(ids.practitioner, 'clinical_data', 'select clinical_core.start_encounter($1,$2) as r', [ids.clinic, ids.patient]))[0]!.r as string;
    const participant = (await as(ids.practitioner, 'clinical_data',
      "select clinical_private.add_encounter_recording_participant($1,'patient','FICTIONAL PARTICIPANT',true,$2) as r", [encounter, randomUUID()]))[0]!.r as string;
    const release = randomUUID();
    await db().query(`insert into clinical_private.recording_consent_releases(id,organization_id,scope,version,locale,jurisdiction,content,content_sha256,approved_by,approved_at)
      values($1::uuid,$2,'ai_drafting',($1::uuid)::text,'en','FICTIONAL','FICTIONAL CONSENT ONLY',encode(public.digest('FICTIONAL CONSENT ONLY','sha256'),'hex'),'FICTIONAL TEST REVIEW',clock_timestamp()-interval '1 day')`,
      [release, ids.clinic]);
    return (await as(ids.practitioner, 'clinical_data', "select clinical_private.grant_encounter_recording_consent($1,$2,$3,'written','FICTIONAL ACK',null) as r",
      [participant, release, randomUUID()]))[0]!.r as string;
  };
  const WITHDRAW_RECORDING = "select clinical_private.withdraw_encounter_recording_consent($1,'FICTIONAL WITHDRAWAL') as r";
  const recordingWithdrawals = async (grant: string) => (await db().query<{ n: number }>(
    'select count(*)::int n from clinical_private.recording_consent_withdrawals where grant_id=$1', [grant])).rows[0]!.n;
  const decisionGrant = (evidence?: Evidence) => as(ids.practitioner, 'consent_management',
    "select consent_id from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')", [ids.connection, ids.artifact], { evidence });
  const decisionWithdraw = (evidence?: Evidence, who = ids.practitioner) => as(who, 'consent_management',
    "select consent_id from clinical_core.revoke_consent_grant($1,'forms_checkins','patient_request')", [ids.connection], { evidence });
  /** The SQL `GET /clinical-core/workforce/consents/current` runs (aws-identity-consent.ts readCurrentConsent), by patient. */
  const currentConsent = (evidence?: Evidence) => as(ids.practitioner, 'consent_management',
    `select c.patient_record_id, c.id as connection_id, g.status, g.version
       from clinical_core.patient_connections c
       left join clinical_core.current_consent g on g.connection_id = c.id and g.scope = $3
      where c.organization_id = $1 and c.state in ('verified','paused') and c.patient_record_id = $2
      order by g.recorded_at desc nulls last, c.verified_at desc nulls last limit 1`, [ids.clinic, ids.patient, 'forms_checkins'], { evidence });
  const readPatient = (evidence?: Evidence, purpose = 'clinical_data') =>
    as(ids.practitioner, purpose, 'select id from clinical_core.patient_records where id=$1', [ids.patient], { evidence }).then(rows => {
      if (rows.length !== 1) throw new Error('patient_not_visible');
      return rows;
    });
  const assignCleanupOperator = () => db().query(`insert into clinical_private.recording_cleanup_operators(organization_id,operator_id,reviewed_by,evidence_sha256,approved_at,expires_at)
    values($1,$2,$3,repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`, [ids.clinic, ids.operator, ids.reviewer]);
  const cleanupWork = () => as(ids.operator, 'consent_management', 'select clinical_private.list_recording_cleanup_work(null,25) as work');
  const placeHold = () => as(ids.operator, 'consent_management', "select clinical_private.place_recording_legal_hold($1,'litigation') as id", [ids.patient]);
  const releaseHold = (hold: string) => as(ids.operator, 'consent_management', 'select clinical_private.release_recording_legal_hold($1) as r', [hold]);
  return { ids, subject, setup, as, status, recordingGrant, WITHDRAW_RECORDING, recordingWithdrawals, decisionGrant, decisionWithdraw, currentConsent,
    readPatient, assignCleanupOperator, cleanupWork, placeHold, releaseHold };
}

describe('control: the grant-paths successor without the window (recording withdrawal lands in a suspended clinic)', () => {
  let db: PGlite;
  const h = harness(() => db);
  beforeAll(async () => { db = await build(WITHOUT_WINDOW); }, 300_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it('COVERAGE: an active clinical member withdraws an existing recording consent after the suspension', async () => {
    const grant = await h.recordingGrant();
    await h.status('suspended');
    expect(await outcome(h.as(h.ids.practitioner, 'clinical_data', h.WITHDRAW_RECORDING, [grant]))).toBe('admitted');
    expect(await h.recordingWithdrawals(grant)).toBe(1);
  });
});

describe('the full BLOCKED candidate chain', () => {
  let db: PGlite;
  const h = harness(() => db);
  beforeAll(async () => { db = await build(FULL_CHAIN); }, 300_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  describe('path 1: recording consent withdrawal, and the cleanup it starts', () => {
    // OPEN, owner decision (docs/clinic-continuity-release-map-2026-10-17.md §3, R1): the invariant, failing on this
    // chain. It failed before as a plain `it` (scratchpad wp5-negatives-failing-before.log); `it.fails` keeps it red
    // in meaning and turns the suite red the moment a successor makes it pass, so the label cannot go stale.
    it.fails('OPEN: withdrawals remain possible: an already-valid session of an active clinical member withdraws an existing recording consent in a suspended clinic', async () => {
      const grant = await h.recordingGrant();
      await h.status('suspended');
      // The already-valid session declares what it does: a write. The window holds every write.
      expect(await outcome(h.as(h.ids.practitioner, 'clinical_data', h.WITHDRAW_RECORDING, [grant], { evidence: BEFORE('write') }))).toBe('admitted');
      expect(await h.recordingWithdrawals(grant)).toBe(1);
    });

    it('PINNED: under the window every entry refuses the recording withdrawal, and nothing is written', async () => {
      const grant = await h.recordingGrant();
      await h.status('suspended');
      const attempt = (o: { evidence?: Evidence } = {}, purpose = 'clinical_data') => outcome(h.as(h.ids.practitioner, purpose, h.WITHDRAW_RECORDING, [grant], o));
      expect(await attempt()).toBe(CLOSED); // seven arguments: an unconverted caller
      expect(await attempt({ evidence: BEFORE('write') })).toBe(HELD_WRITE);
      expect(await attempt({ evidence: BEFORE('read') })).toBe(READ_ONLY); // a write sent as a read lands nowhere
      expect(await attempt({ evidence: REFRESHED('write') })).toBe(CLOSED);
      // consent_management is not windowed, but the recording family checks its own purpose.
      expect(await attempt({}, 'consent_management')).toBe('refused:identity_refused:production_context_refused');
      expect(await h.recordingWithdrawals(grant)).toBe(0);
      // The colleague (another active clinical member) is held the same way: this is the window, not the person.
      expect(await outcome(h.as(h.ids.colleague, 'clinical_data', h.WITHDRAW_RECORDING, [grant], { evidence: BEFORE('write') }))).toBe(HELD_WRITE);
    });

    it('PINNED: nothing else can write a recording consent withdrawal; the patient has no such path', async () => {
      const writers = (await db.query<{ f: string }>(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname like 'clinical%' and p.prosrc ~* 'insert\\s+into\\s+clinical_private\\.recording_consent_withdrawals'
          and has_function_privilege('clinical_core_api', p.oid, 'execute') order by 1`)).rows.map(row => row.f);
      expect(writers).toEqual(['clinical_private.withdraw_encounter_recording_consent(uuid,text)']);
    });

    it('HELD (D3): the assigned recording cleanup operator is refused in a suspended clinic; nothing is deleted', async () => {
      await h.assignCleanupOperator();
      await expect(h.cleanupWork()).resolves.toHaveLength(1);
      await h.status('suspended');
      expect(await outcome(h.cleanupWork())).toMatch(OPERATOR_REQUIRED);
      await h.status('archived');
      expect(await outcome(h.cleanupWork())).toMatch(OPERATOR_REQUIRED);
    });
  });

  describe('path 2: legal holds', () => {
    it('HELD (D4): nobody can place or release a recording legal hold while the clinic is suspended; a hold placed before survives it', async () => {
      await h.assignCleanupOperator();
      const hold = (await h.placeHold())[0]!.id as string;
      await h.status('suspended');
      expect(await outcome(h.placeHold())).toMatch(OPERATOR_REQUIRED);
      expect(await outcome(h.releaseHold(hold))).toMatch(OPERATOR_REQUIRED);
      const rows = (await db.query<{ released: boolean }>('select released_at is not null as released from clinical_private.recording_legal_holds where id=$1', [hold])).rows;
      expect(rows).toEqual([{ released: false }]);
      // The practitioner and the clinic's other members have no hold path at all: holds are the operator's.
      expect(await outcome(h.as(h.ids.practitioner, 'consent_management', "select clinical_private.place_recording_legal_hold($1,'litigation') as id", [h.ids.patient])))
        .toMatch(OPERATOR_REQUIRED);
    });
  });

  describe('authorized retention cleanup continues', () => {
    it('COVERAGE: the retention service sweeps in a suspended or archived clinic; revoked or disabled, it is refused', async () => {
      await db.query(`insert into clinical_private.privacy_retention_service_releases(version,service_person_id,identity_subject,evidence_sha256,approved_by,approved_at)
        values($1,$2,$3,repeat('a',64),$4,clock_timestamp()-interval '1 hour')`, [`fictional-${h.ids.service}`, h.ids.service, h.subject(h.ids.service), h.ids.reviewer]);
      const sweep = () => h.as(h.ids.service, 'consent_management', 'select clinical_private.list_privacy_export_cleanup_for_retention(25) as items');
      for (const value of ['suspended', 'archived']) {
        await h.status(value);
        await expect(sweep()).resolves.toEqual([{ items: [] }]);
      }
      await db.query('update clinical_private.privacy_retention_service_releases set revoked_at=clock_timestamp() where service_person_id=$1', [h.ids.service]);
      expect(await outcome(sweep())).toMatch(/retention_service_release_required/);
      await db.query("update clinical_core.identities set status='disabled' where person_id=$1", [h.ids.service]);
      expect(await outcome(sweep())).toBe(CLOSED);
    });
  });

  describe('path 4: refreshed tokens', () => {
    it('COVERAGE: clinical reads end for a refreshed token and continue, read-only, for the already-valid one', async () => {
      await h.status('suspended');
      expect(await outcome(h.readPatient(REFRESHED()))).toBe(CLOSED);
      expect(await outcome(h.readPatient(BEFORE()))).toBe('admitted');
      expect(await outcome(h.readPatient())).toBe(CLOSED);
      expect(await outcome(h.as(h.ids.practitioner, 'identity_link', 'select 1 as one', [], { evidence: REFRESHED() }))).toBe(CLOSED);
      // The sibling clinic is not held back.
      expect(await outcome(h.as(h.ids.practitioner, 'clinical_data', 'select 1 as one', [], { clinic: h.ids.sibling, evidence: REFRESHED() }))).toBe('admitted');
    });

    it('COVERAGE: a refreshed token cannot record a new grant (consent-decision candidate), with or without evidence', async () => {
      await h.status('suspended');
      for (const evidence of [undefined, REFRESHED(), BEFORE()]) expect(await outcome(h.decisionGrant(evidence))).toMatch(/consent_actor_refused/);
    });

    it('HELD (time bound on withdrawals): consent_management is not windowed, so a refreshed token still reads the clinic\'s current consent state and withdraws', async () => {
      expect(await outcome(h.decisionGrant())).toBe('admitted');
      await h.status('suspended');
      const state = await h.currentConsent(REFRESHED());
      expect(state).toEqual([{ patient_record_id: h.ids.patient, connection_id: h.ids.connection, status: 'granted', version: 1 }]);
      expect(await outcome(h.decisionWithdraw(REFRESHED()))).toBe('admitted');
      expect((await h.currentConsent())[0]).toMatchObject({ status: 'revoked', version: 2 });
    });

    it('PINNED (database observation): row security on the patient tables gates on the clinic claim and membership, not on purpose, clinic status or token time', async () => {
      const policies = (await db.query<{ t: string; q: string }>(`select tablename t, qual q from pg_policies where schemaname='clinical_core'
        and tablename in ('patient_records','patient_connections','consent_grants') order by 1`)).rows;
      expect(policies.map(row => row.t)).toEqual(['consent_grants', 'patient_connections', 'patient_records']);
      for (const row of policies) {
        expect(row.q).toContain('is_active_member(organization_id)');
        expect(row.q).not.toMatch(/purpose|status|transition|exp/);
      }
      await h.status('suspended');
      // So the window's read bound holds for the purposes it covers. Under consent_management a refreshed token's
      // transaction could select the patient row; only the service's choice of SQL per route keeps it from doing so.
      expect(await outcome(h.readPatient(REFRESHED(), 'consent_management'))).toBe('admitted');
      expect(await outcome(h.readPatient(REFRESHED(), 'clinical_data'))).toBe(CLOSED);
    });

    it('COVERAGE: a compromised login is refused at once inside the window, for every purpose; a colleague is not', async () => {
      const operator = randomUUID();
      await db.query('insert into clinical_private.workforce_platform_operators(operator_subject) values($1) on conflict do nothing', [operator]);
      await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after'");
      expect(await outcome(h.decisionGrant())).toBe('admitted');
      await h.status('suspended');
      await db.transaction(async tx => {
        await tx.exec('set local role clinical_workforce_operator');
        await tx.query("select clinical_private.propose_workforce_identity_revocation($1,$2,$3,'suspected_compromise')", [operator, randomUUID(), h.subject(h.ids.practitioner)]);
      });
      expect(await outcome(h.readPatient(BEFORE()))).toBe(CLOSED);
      expect(await outcome(h.currentConsent(BEFORE()))).toBe(CLOSED);
      expect(await outcome(h.decisionWithdraw(BEFORE()))).toBe(CLOSED);
      expect(await outcome(h.decisionWithdraw(undefined, h.ids.colleague))).toBe('admitted');
    });
  });
});
