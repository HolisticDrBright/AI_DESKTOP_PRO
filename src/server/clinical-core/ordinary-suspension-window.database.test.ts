import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ClinicalCoreDatabase } from './database';
import { createAwsProductionDesktopAdapter, ProductionDesktopError, PRODUCTION_DESKTOP_CORE_RPCS, PRODUCTION_DESKTOP_CORE_SELECTS,
  type ProductionRequestContext } from './aws-production-desktop';
import {
  ORDINARY_SUSPENSION_WINDOW_PROSRC, ORDINARY_SUSPENSION_WINDOW_RELEASE, ORDINARY_SUSPENSION_WINDOW_ROLLBACK_SHA256,
  ORDINARY_SUSPENSION_WINDOW_SHA256, PRODUCTION_DESKTOP_READ_RPCS, tokenWindowFromClaims,
} from './ordinary-suspension-window';

/**
 * The BLOCKED ordinary-suspension window (workforce-ordinary-suspension-window.sql) on the real 106-migration schema,
 * over the emergency revocation it requires as parent, with the consent-decision candidate beside it. Fictional rows
 * only. The two-session lock orders are in scripts/qualify-ordinary-suspension-window-native.mjs.
 *
 * The owner's rule: a practitioner session already valid at an ordinary suspension may continue only until that token's
 * own expiry; a refreshed or new token does not inherit it; nothing extends it; new consent grants stay blocked; a
 * suspected compromise is the emergency revocation, refused at once.
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SOURCE = 'infra/aws-clinical-core/source-candidates/';
const CHAIN = [
  `${SOURCE}workforce-token-binding-lookup.sql`,
  `${SOURCE}workforce-clinic-approved-onboarding.sql`,
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  `${SOURCE}workforce-join-review-uniform-refusal.sql`,
  `${SOURCE}workforce-current-membership-context.sql`,
  `${SOURCE}workforce-onboarding-approval-authority.sql`,
];
const REVOCATION = `${SOURCE}workforce-identity-emergency-revocation.sql`;
const REVOCATION_ROLLBACK = `${SOURCE}workforce-identity-emergency-revocation-rollback.sql`;
const WINDOW = `${SOURCE}workforce-ordinary-suspension-window.sql`;
const ROLLBACK = `${SOURCE}workforce-ordinary-suspension-window-rollback.sql`;
const DECISION = `${SOURCE}workforce-consent-decision-clinic-status.sql`;
const STATUS = `${SOURCE}legacy-claims-clinic-status.sql`;
const SEVEN = 'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)';
const TEN = 'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)';
const ADMIT = 'clinical_private.admit_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)';

let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function build(files: string[]) {
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of files) await apply(db, file);
  return db;
}
async function apply(db: PGlite, file: string) {
  try { for (const statement of splitPostgresStatements(read(file))) await db.exec(statement); } catch (error) {
    await db.exec('rollback').catch(() => undefined);
    throw error;
  }
}
const prosrc = async (db: PGlite, signature: string) =>
  (await db.query<{ h: string | null }>(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid=to_regprocedure($1)`, [signature])).rows[0]?.h ?? null;
const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
  const text = message(error);
  const category = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category;
  return `refused:${category ?? 'unclassified'}:${(text.match(/\b[a-z_]+_(?:refused|held|required)\b|read-only transaction/) ?? [text])[0]}`;
});
const CLOSED = 'refused:identity_refused:request_context_refused';
const HELD = 'refused:operation_refused:ordinary_suspension_write_held';
const READ_ONLY = 'refused:unclassified:read-only transaction';

type Evidence = { iat: number | null; exp: number | null; access: string | null };
/** A token as Cognito would issue it, `issuedSecondsAgo` before now, valid for `lifetime` seconds. */
const token = (issuedSecondsAgo: number, lifetime = 3600, access = 'read'): Evidence => {
  const iat = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
  return { iat, exp: iat + lifetime, access };
};

function harness(db: () => PGlite) {
  const ids = { clinic: '', other: '', practitioner: '', consumer: '', reviewer: '', patient: '', otherPatient: '', connection: '', artifact: '' };
  const subject = (person: string, pool = 'workforce') => `subject-${pool}-${person}`;
  const setup = async () => {
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) ids[key] = randomUUID();
    await db().query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic'),($2,'FICTIONAL sibling clinic')", [ids.clinic, ids.other]);
    for (const [id, pool] of [[ids.practitioner, 'workforce'], [ids.reviewer, 'workforce'], [ids.consumer, 'consumer']] as const) {
      await db().query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db().query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id, pool)]);
    }
    await db().query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$3,'practitioner'),($2,$3,'practitioner')",
      [ids.clinic, ids.other, ids.practitioner]);
    await db().query(`insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values
      ($1,$2,$3,'Fictional','Patient'),($4,$5,$6,'Fictional','Sibling')`,
      [ids.patient, ids.clinic, 'patient_' + ids.patient.replaceAll('-', ''), ids.otherPatient, ids.other, 'patient_' + ids.otherPatient.replaceAll('-', '')]);
    await db().query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
      [ids.connection, ids.clinic, ids.patient, ids.consumer]);
    await db().query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'forms_checkins',$3,$4,'US-FICTIONAL','approved',clock_timestamp(),$5)`, [ids.artifact, ids.clinic, `fictional-${ids.artifact.slice(0, 8)}`, 'c'.repeat(64), ids.reviewer]);
  };
  /** One legacy request: the seven values, or the same with the token's evidence. */
  const as = async (evidence: Evidence | null, sql: string, args: unknown[] = [], o: { clinic?: string; purpose?: string; who?: string; pool?: string } = {}) =>
    db().transaction(async tx => {
      const who = o.who ?? ids.practitioner, pool = o.pool ?? 'workforce';
      const values = [who, o.clinic ?? ids.clinic, pool, subject(who, pool), o.purpose ?? 'clinical_data'];
      await tx.exec('set local role clinical_core_api');
      if (evidence) await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi',$6,$7,$8)", [...values, evidence.iat, evidence.exp, evidence.access]);
      else await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", values);
      return (await tx.query(sql, args)).rows;
    });
  const readPatient = (evidence: Evidence | null, clinic = ids.clinic, patient = ids.patient) =>
    as(evidence, 'select id from clinical_core.patient_records where id=$1', [patient], { clinic }).then(rows => {
      if (rows.length !== 1) throw new Error('patient_not_visible');
      return rows;
    });
  const writePatient = (evidence: Evidence | null, clinic = ids.clinic) =>
    as(evidence, "select clinical_core.create_patient_profile($1,'Fictional','Window') as id", [clinic], { clinic });
  const grant = () => as(null, "select consent_id from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')",
    [ids.connection, ids.artifact], { purpose: 'consent_management' });
  const withdraw = (who = ids.practitioner, pool = 'workforce') => as(null, "select consent_id from clinical_core.revoke_consent_grant($1,'forms_checkins','patient_request')",
    [ids.connection], { purpose: 'consent_management', who, pool });
  const status = (value: string, clinic = ids.clinic) => db().query('update clinical_core.organizations set status=$2 where id=$1', [clinic, value]);
  const profiles = async () => (await db().query<{ n: number }>("select count(*)::int n from clinical_core.patient_records where last_name='Window' and organization_id in ($1,$2)",
    [ids.clinic, ids.other])).rows[0]!.n;
  return { ids, subject, setup, as, readPatient, writePatient, grant, withdraw, status, profiles };
}

describe('as the parent stands (the emergency revocation, no window): failing before', () => {
  let db: PGlite;
  const h = harness(() => db);
  beforeAll(async () => { db = await build([...CHAIN, REVOCATION]); }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it('a token refreshed after an ordinary suspension reads and writes as if nothing happened; the database has no way to know', async () => {
    await h.status('suspended');
    // The same seven values arrive whether the token was issued before the suspension or refreshed after it.
    expect(await outcome(h.readPatient(null))).toBe('admitted');
    expect(await outcome(h.writePatient(null))).toBe('admitted');
    expect(await h.profiles()).toBe(1);
    expect(await prosrc(db, TEN)).toBeNull();
    expect((await db.query("select to_regclass('clinical_private.organization_status_transitions') t")).rows[0]).toEqual({ t: null });
  });
});

describe('the candidate', () => {
  let db: PGlite;
  const h = harness(() => db);
  const operator = randomUUID();
  beforeAll(async () => {
    db = await build([...CHAIN, REVOCATION, WINDOW, DECISION]);
    await db.query('insert into clinical_private.workforce_platform_operators(operator_subject) values($1)', [operator]);
    await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after'");
  }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it('is pinned: the file digests, the three function bodies, its parent; the release switch is blocked', async () => {
    expect(sha(read(WINDOW))).toBe(ORDINARY_SUSPENSION_WINDOW_SHA256);
    expect(sha(read(ROLLBACK))).toBe(ORDINARY_SUSPENSION_WINDOW_ROLLBACK_SHA256);
    expect(await prosrc(db, SEVEN)).toBe(ORDINARY_SUSPENSION_WINDOW_PROSRC.seven);
    expect(await prosrc(db, TEN)).toBe(ORDINARY_SUSPENSION_WINDOW_PROSRC.ten);
    expect(await prosrc(db, ADMIT)).toBe(ORDINARY_SUSPENSION_WINDOW_PROSRC.admit);
    expect(read(WINDOW)).toContain(ORDINARY_SUSPENSION_WINDOW_PROSRC.parent);
    expect(ORDINARY_SUSPENSION_WINDOW_RELEASE).toBe('blocked');
  });

  it('records every status change with the database clock, append-only even for the table owner', async () => {
    await h.status('suspended');
    await h.status('active');
    await db.query("update clinical_core.organizations set organization_label='FICTIONAL renamed' where id=$1", [h.ids.clinic]);
    const rows = (await db.query<{ from_status: string; to_status: string }>(
      'select from_status, to_status from clinical_private.organization_status_transitions where organization_id=$1 order by id', [h.ids.clinic])).rows;
    expect(rows).toEqual([{ from_status: 'active', to_status: 'suspended' }, { from_status: 'suspended', to_status: 'active' }]);
    for (const sql of ['update clinical_private.organization_status_transitions set to_status=$2 where organization_id=$1',
      'delete from clinical_private.organization_status_transitions where organization_id=$1 and $2::text is not null']) {
      expect(message(await db.query(sql, [h.ids.clinic, 'active']).catch(e => e))).toMatch(/organization_status_transition_append_only/);
    }
    expect(message(await db.exec('truncate clinical_private.organization_status_transitions').catch(e => e))).toMatch(/organization_status_transition_append_only/);
    // No API role can read or write it.
    expect(message(await db.transaction(async tx => { await tx.exec('set local role clinical_core_api');
      await tx.query('select count(*) from clinical_private.organization_status_transitions'); }).catch(e => e))).toMatch(/permission denied/);
  });

  it('an active clinic: unchanged without evidence; with evidence, read and write as before', async () => {
    expect(await outcome(h.readPatient(null))).toBe('admitted');
    expect(await outcome(h.writePatient(null))).toBe('admitted');
    expect(await outcome(h.readPatient(token(60)))).toBe('admitted');
    expect(await outcome(h.writePatient(token(60, 3600, 'write')))).toBe('admitted');
    expect(await h.profiles()).toBe(2);
    const settings = await h.as(token(60), "select current_setting('transaction_read_only') ro, current_setting('clinical.claim.admission', true) a");
    expect(settings).toEqual([{ ro: 'off', a: null }]);
  });

  it('malformed or expired evidence is refused even in an active clinic; nothing is repaired', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const evidence of [
      { iat: null, exp: now + 3600, access: 'read' }, { iat: now - 60, exp: null, access: 'read' }, { iat: now - 60, exp: now + 3600, access: null },
      { iat: now - 60, exp: now + 3600, access: 'delete' }, { iat: now, exp: now, access: 'read' }, { iat: now, exp: now + 200, access: 'read' },
      { iat: now - 60, exp: now - 60 + 2 * 86_400, access: 'read' }, { iat: now + 600, exp: now + 4200, access: 'read' },
      { iat: -5, exp: 3600, access: 'read' }, { iat: now - 7200, exp: now - 3600, access: 'read' },
    ]) expect([evidence, await outcome(h.readPatient(evidence))]).toEqual([evidence, CLOSED]);
  });

  it('a session issued before the suspension reads until its own expiry, read-only, its statements and lock waits bounded by the time left', async () => {
    const before = token(600, 3600);
    await h.status('suspended');
    expect(await outcome(h.readPatient(before))).toBe('admitted');
    const [settings] = await h.as(before, `select current_setting('transaction_read_only') ro, current_setting('statement_timeout') st,
      current_setting('lock_timeout') lt, current_setting('clinical.claim.admission', true) a`) as Array<Record<string, string>>;
    expect(settings!.ro).toBe('on');
    expect(settings!.a).toBe('ordinary_suspension_window');
    const left = (before.exp! * 1000) - Date.now();
    for (const value of [settings!.st, settings!.lt]) {
      const ms = Number(value.replace(/ms$/, '')) * (value.endsWith('min') ? 60_000 : value.endsWith('s') && !value.endsWith('ms') ? 1000 : 1);
      expect(ms).toBeGreaterThan(left - 120_000);
      expect(ms).toBeLessThanOrEqual(left + 1000);
    }
    // The clinic list is a read, and an identity_link read is admitted the same way.
    expect(await outcome(h.as(before, 'select count(*) from clinical_core.list_my_organizations()'))).toBe('admitted');
    expect(await outcome(h.as(before, 'select 1', [], { purpose: 'identity_link' }))).toBe('admitted');
  });

  it('in the window a declared write is held, and a write sent as a read cannot land: the transaction is read-only', async () => {
    const before = token(600, 3600, 'write');
    await h.status('suspended');
    expect(await outcome(h.writePatient(before))).toBe(HELD);
    expect(await outcome(h.writePatient({ ...before, access: 'read' }))).toBe(READ_ONLY);
    expect(await h.profiles()).toBe(0);
  });

  it('a token refreshed or issued after the suspension does not inherit the window, nor one issued within 60 seconds of it', async () => {
    const close = token(30);
    await h.status('suspended');
    expect(await outcome(h.readPatient(token(0)))).toBe(CLOSED);
    expect(await outcome(h.readPatient(close))).toBe(CLOSED);
  });

  it('an expired token is refused, and so is a request with no evidence (every unconverted caller) for clinical data and identity linking', async () => {
    const issued = Math.floor(Date.now() / 1000) - 4000;
    await h.status('suspended');
    expect(await outcome(h.readPatient({ iat: issued, exp: issued + 3600, access: 'read' }))).toBe(CLOSED);
    expect(await outcome(h.readPatient(null))).toBe(CLOSED);
    expect(await outcome(h.writePatient(null))).toBe(CLOSED);
    expect(await outcome(h.as(null, 'select 1', [], { purpose: 'identity_link' }))).toBe(CLOSED);
  });

  it('a clinic suspended with no recorded transition has no window: missing evidence is refused, never guessed', async () => {
    const before = token(600);
    const unrecorded = randomUUID();
    await db.query("insert into clinical_core.organizations(id,organization_label,status) values($1,'FICTIONAL suspended before the candidate','suspended')", [unrecorded]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [unrecorded, h.ids.practitioner]);
    expect(await outcome(h.as(before, 'select 1', [], { clinic: unrecorded }))).toBe(CLOSED);
    // A transition row the owner wrote that contradicts the status (latest says active) is no evidence either.
    await db.query("insert into clinical_private.organization_status_transitions(organization_id,from_status,to_status) values($1,'suspended','active')", [unrecorded]);
    expect(await outcome(h.as(before, 'select 1', [], { clinic: unrecorded }))).toBe(CLOSED);
  });

  it('suspended, reinstated and suspended again: the latest suspension decides', async () => {
    const before = token(600);
    await h.status('suspended');
    await h.status('active');
    expect(await outcome(h.writePatient({ ...before, access: 'write' }))).toBe('admitted');
    await h.status('suspended');
    expect(await outcome(h.readPatient(before))).toBe('admitted');
    expect(await outcome(h.readPatient(token(0)))).toBe(CLOSED);
  });

  it('an archived clinic has no window at all', async () => {
    const before = token(600);
    await h.status('suspended');
    await h.status('archived');
    expect(await outcome(h.readPatient(before))).toBe(CLOSED);
  });

  it('the sibling clinic is untouched, and the window opens nothing outside its own clinic', async () => {
    const before = token(600, 3600, 'write');
    await h.status('suspended');
    expect(await outcome(h.writePatient(before, h.ids.other))).toBe('admitted');
    expect(await outcome(h.readPatient({ ...before, access: 'read' }, h.ids.other, h.ids.otherPatient))).toBe('admitted');
    // Inside clinic A's window, clinic B's patient is not visible.
    expect(await h.as({ ...before, access: 'read' }, 'select id from clinical_core.patient_records where id=$1', [h.ids.otherPatient])).toEqual([]);
  });

  it('an emergency-revoked login is refused at once, whatever the window would allow', async () => {
    const before = token(600);
    await h.status('suspended');
    expect(await outcome(h.readPatient(before))).toBe('admitted');
    await db.transaction(async tx => {
      await tx.exec('set local role clinical_workforce_operator');
      await tx.query("select clinical_private.propose_workforce_identity_revocation($1,$2,$3,'suspected_compromise')", [operator, randomUUID(), h.subject(h.ids.practitioner)]);
    });
    expect(await outcome(h.readPatient(before))).toBe(CLOSED);
    expect(await outcome(h.readPatient(before, h.ids.other, h.ids.otherPatient))).toBe(CLOSED);
  });

  it('consent management is not windowed: new grants stay refused, an existing grant can be withdrawn, the patient can withdraw', async () => {
    expect(await outcome(h.grant())).toBe('admitted');
    await h.status('suspended');
    expect(await outcome(h.grant())).toBe('refused:identity_refused:consent_actor_refused');
    expect(await outcome(h.withdraw())).toBe('admitted');
    // The patient's own withdrawal of a later grant, in the same suspended clinic.
    await h.status('active');
    expect(await outcome(h.grant())).toBe('admitted');
    await h.status('suspended');
    expect(await outcome(h.withdraw(h.ids.consumer, 'consumer'))).toBe('admitted');
  });

  it('the production read set is exactly the STABLE functions with no write or row lock; everything else is a write', async () => {
    const functions = (await db.query<{ proname: string; v: string; writes: boolean; locks: boolean }>(`select p.proname, string_agg(distinct p.provolatile::text,'') v,
      bool_or(p.prosrc ~* '\\m(insert\\s+into|update\\s+[a-z_.]+\\s+set|delete\\s+from)\\M') writes,
      bool_or(p.prosrc ~* 'for (share|update|no key update|key share)') locks
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clinical_core' group by 1`)).rows;
    const byName = new Map(functions.map(row => [row.proname, row]));
    for (const name of PRODUCTION_DESKTOP_READ_RPCS) {
      expect([name, PRODUCTION_DESKTOP_CORE_RPCS.has(name), byName.get(name)]).toEqual([name, true, { proname: name, v: 's', writes: false, locks: false }]);
    }
    for (const name of PRODUCTION_DESKTOP_CORE_RPCS) {
      const row = byName.get(name);
      if (!PRODUCTION_DESKTOP_READ_RPCS.has(name)) expect([name, row ? row.v === 's' && !row.writes && !row.locks : 'not in this schema'])
        .not.toEqual([name, true]);
    }
    for (const fn of ['list_clinical_pathways', 'list_clinical_knowledge_import_batches', 'list_clinical_knowledge_import_items']) {
      expect(byName.get(fn)).toMatchObject({ v: 's', writes: false, locks: false });
    }
    expect([...PRODUCTION_DESKTOP_CORE_SELECTS].sort()).toEqual(['clinical_knowledge_import_batches', 'clinical_knowledge_import_items', 'clinical_pathways', 'lab_documents', 'patient_profiles']);
  });

  describe('the production adapter over this database', () => {
    /** The API connection as the Lambda sees it: role-scoped, typed uuids unwrapped, refusals classified as in production. */
    const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async raw => {
      await raw.exec('set local role clinical_core_api');
      return work({ query: async (sql, parameters = []) => {
        const values = parameters.map(value => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid' && 'value' in value ? value.value : value);
        try { return await raw.query(sql, values) as never; } catch (error) {
          throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: message(error) }) ?? error;
        }
      } });
    }) };
    const context = (window: ReturnType<typeof tokenWindowFromClaims>): ProductionRequestContext => ({
      actorPersonId: h.ids.practitioner, organizationId: h.ids.clinic, identityPool: 'workforce', identitySubject: h.subject(h.ids.practitioner),
      purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true,
      productionBound: true, ...(window ? { tokenWindow: window } : {}),
    });
    const claims = (evidence: Evidence) => tokenWindowFromClaims({ iat: String(evidence.iat), exp: String(evidence.exp) });
    const profilesSelect = () => ({ kind: 'select' as const, table: 'patient_profiles', query: `organization_id=eq.${h.ids.clinic}` });
    const listAudit = () => ({ kind: 'rpc' as const, functionName: 'list_audit_events', args: { _organization_id: h.ids.clinic, _limit: 10 } });
    const create = () => ({ kind: 'rpc' as const, functionName: 'create_patient_profile', args: { _organization_id: h.ids.clinic, _first_name: 'Fictional',
      _last_name: 'Window', _date_of_birth: null, _sex: 'unknown', _mrn: null, _email: null, _phone: null } });
    const result = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
      return error instanceof ProductionDesktopError ? error.category : `other:${message(error)}`;
    });

    it('blocked (the default): the seven-argument entry, refused in a suspended clinic as every unconverted caller is', async () => {
      const adapter = createAwsProductionDesktopAdapter(database);
      const before = claims(token(600));
      expect(await result(adapter.execute(context(before), profilesSelect()))).toBe('admitted');
      expect(await result(adapter.execute(context(before), create()))).toBe('admitted');
      await h.status('suspended');
      expect(await result(adapter.execute(context(before), profilesSelect()))).toBe('operation_refused');
    });

    it('qualification: reads in the window, writes held with no row, a later token refused, missing evidence refused before the database', async () => {
      const adapter = createAwsProductionDesktopAdapter(database, undefined, { suspensionWindow: 'qualification' });
      const before = claims(token(600));
      await h.status('suspended');
      expect(await result(adapter.execute(context(before), profilesSelect()))).toBe('admitted');
      expect(await result(adapter.execute(context(before), listAudit()))).toBe('admitted');
      expect(await result(adapter.execute(context(before), create()))).toBe('operation_refused');
      expect(await h.profiles()).toBe(0);
      expect(await result(adapter.execute(context(claims(token(0))), profilesSelect()))).toBe('operation_refused');
      expect(await result(adapter.execute(context(null), profilesSelect()))).toBe('identity_refused');
    });
  });
});

describe('guards and rollback', () => {
  it('refuses the deployed entry and the clinic-status successor as parent; applies once', async () => {
    const deployed = await build([...CHAIN]);
    expect(message(await apply(deployed, WINDOW).catch(e => e))).toMatch(/ordinary_suspension_window_parent_refused/);
    await deployed.close();
    const status = await build([...CHAIN, STATUS]);
    expect(message(await apply(status, WINDOW).catch(e => e))).toMatch(/ordinary_suspension_window_parent_refused/);
    // And the clinic-status successor refuses this one as its parent.
    await status.close();
    const both = await build([...CHAIN, REVOCATION, WINDOW]);
    expect(message(await apply(both, WINDOW).catch(e => e))).toMatch(/ordinary_suspension_window_parent_refused/);
    expect(message(await apply(both, STATUS).catch(e => e))).toMatch(/clinic_status_parent_refused/);
    await both.close();
  }, 300_000);

  it('the rollback restores the parent entry exactly, keeps every recorded transition, and must come before the revocation rollback', async () => {
    const db = await build([...CHAIN, REVOCATION, WINDOW]);
    const clinic = randomUUID();
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL rollback clinic')", [clinic]);
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinic]);
    expect(message(await apply(db, REVOCATION_ROLLBACK).catch(e => e))).toMatch(/emergency_revocation_rollback_refused/);
    await apply(db, ROLLBACK);
    expect(await prosrc(db, SEVEN)).toBe(ORDINARY_SUSPENSION_WINDOW_PROSRC.parent);
    expect(await prosrc(db, TEN)).toBeNull();
    expect(await prosrc(db, ADMIT)).toBeNull();
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_private.organization_status_transitions where organization_id=$1', [clinic])).rows[0]!.n).toBe(1);
    // Recording stops; the rows stay append-only.
    await db.query("update clinical_core.organizations set status='active' where id=$1", [clinic]);
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_private.organization_status_transitions where organization_id=$1', [clinic])).rows[0]!.n).toBe(1);
    expect(message(await db.query('delete from clinical_private.organization_status_transitions').catch(e => e))).toMatch(/organization_status_transition_append_only/);
    expect(message(await apply(db, ROLLBACK).catch(e => e))).toMatch(/ordinary_suspension_window_rollback_refused/);
    // Now the revocation rollback is possible again.
    await apply(db, REVOCATION_ROLLBACK);
    expect(await prosrc(db, SEVEN)).toBe('36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea');
    await db.close();
  }, 300_000);
});

describe('token evidence from verified claims', () => {
  it('takes iat and exp only as whole NumericDate seconds within Cognito\'s ID-token lifetime bounds', () => {
    expect(tokenWindowFromClaims({ iat: '1700000000', exp: '1700003600' })).toEqual({ issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 });
    expect(tokenWindowFromClaims({ iat: 1_700_000_000, exp: 1_700_003_600 })).toEqual({ issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 });
    for (const claims of [undefined, {}, { iat: '1700000000' }, { iat: '1700000000.5', exp: '1700003600' }, { iat: '-1', exp: '3600' },
      { iat: '1700003600', exp: '1700000000' }, { iat: '1700000000', exp: '1700000100' }, { iat: '1700000000', exp: '1700200000' },
      { iat: '01700000000', exp: '1700003600' }, { iat: ' 1700000000', exp: '1700003600' }]) {
      expect(tokenWindowFromClaims(claims as Record<string, unknown> | undefined)).toBeNull();
    }
  });
});
