import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { createProductionCareConnections } from './production-care-connections';
import { bindCareConnectionDatabase, type CareConnectionFunctionBinding } from './care-connections-database-binding';

/**
 * The patient's own consent withdrawal through the care-connections route in a suspended or archived clinic, and the
 * BLOCKED successor care-connections-patient-withdrawal-clinic-status.sql. Fictional rows only, on the real
 * 106-migration schema, alone and under the full BLOCKED workforce chain. PGlite is one session: it is not Aurora.
 *
 * The owner's rule: new practitioner consent grants are blocked in a suspended clinic, withdrawals remain possible,
 * and the patient's own withdrawal stays open (docs/suspended-clinic-custody-2026-10-16.md, D2(B)). The route's own
 * contract: "status and withdrawal remain available" for an archived chart (docs/care-connections-source-candidate.md).
 * As deployed, clinical_private.care_connection_actor refuses every consumer action when the clinic is not active, so
 * neither holds in a closed clinic. The failing-before run is in the scratchpad (wp5-care-connections-failing-before.log).
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SOURCE = 'infra/aws-clinical-core/source-candidates/';
const SUCCESSOR = `${SOURCE}care-connections-patient-withdrawal-clinic-status.sql`;
const ROLLBACK = `${SOURCE}care-connections-patient-withdrawal-clinic-status-rollback.sql`;
const PINS = {
  sha256: '0b5a6fc9cd75a8a4e3fe9e80f341c32db4c6f86b48ae6acb2987b63591540011',
  rollbackSha256: '28e78b681fd8d53032ce26e6ef6755fcbdddf851ae1677f79390bd155417cb89',
  prosrc: { parent: '1a0712788bb5ad19b098bb288eb11df9fcfa9833ba4f1cda808b1585e92366ea', successor: 'f1658585b2b3c66c4ba959c9aeff8242042be6159d30bf6202793c7b982a4b95' },
  /** care_connection_actor: unchanged by the successor; the clinic-records dispatcher (D5) keeps calling it. */
  actor: '9948892ba79f9848ef66cf9e1cc403a38f55b8735f58b3535c760dfb2c6aed93',
};
const REQUEST = 'clinical_core.production_care_connection_request(jsonb)';
const ACTOR = 'clinical_private.care_connection_actor(text,text)';
const FULL_CHAIN = [
  `${SOURCE}workforce-token-binding-lookup.sql`, `${SOURCE}workforce-clinic-approved-onboarding.sql`,
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql', `${SOURCE}workforce-join-review-uniform-refusal.sql`,
  `${SOURCE}workforce-current-membership-context.sql`, `${SOURCE}workforce-onboarding-approval-authority.sql`,
  `${SOURCE}workforce-identity-emergency-revocation.sql`, `${SOURCE}workforce-ordinary-suspension-window.sql`,
  `${SOURCE}workforce-consent-decision-clinic-status.sql`, `${SOURCE}workforce-consent-grant-paths-clinic-status.sql`,
];
let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
});
async function apply(db: PGlite, file: string) {
  try { for (const statement of splitPostgresStatements(read(file))) await db.exec(statement); } catch (error) {
    await db.exec('rollback').catch(() => undefined);
    throw error;
  }
}
async function build(files: readonly string[]) {
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of files) await apply(db, file);
  return db;
}
const prosrc = async (db: PGlite, signature: string) =>
  (await db.query<{ h: string | null }>(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid=to_regprocedure($1)`, [signature])).rows[0]?.h ?? null;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
  const text = message(error);
  return `refused:${classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category ?? 'unclassified'}:${(text.match(/\b[a-z_]+_(?:refused|required|conflict|invalid)\b/) ?? [text])[0]}`;
});
const REFUSED = 'refused:identity_refused:care_connection_refused';
const COPY = 'FICTIONAL TEST consent text. No real personal or health data.';

function harness(db: () => PGlite) {
  const ids = { clinic: '', practitioner: '', patientAccount: '', otherAccount: '', patient: '', otherPatient: '', connection: '', otherConnection: '', artifact: '' };
  const subject = (person: string, pool: string) => `subject-${pool}-${person}`;
  const as = (who: string, pool: 'consumer' | 'workforce', purpose: string, request: Record<string, unknown>) => db().transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", [who, ids.clinic, pool, subject(who, pool), purpose]);
    return (await tx.query<{ r: Record<string, unknown> }>('select clinical_core.production_care_connection_request($1::jsonb) as r', [JSON.stringify(request)])).rows[0]!.r;
  });
  const consumer = (who: string, request: Record<string, unknown>, purpose?: string) =>
    as(who, 'consumer', purpose ?? (request.action === 'claim' ? 'identity_link' : 'consent_management'), request);
  const patient = (request: Record<string, unknown>, purpose?: string) => consumer(ids.patientAccount, request, purpose);
  const link = async (patientRecord: string, account: string) => {
    const invitation = await as(ids.practitioner, 'workforce', 'clinical_data', { action: 'issue', patientRecordId: patientRecord });
    const connection = (await consumer(account, { action: 'claim', token: invitation.token })).connectionId as string;
    await consumer(account, { action: 'grant', connectionId: connection, scope: 'messaging', artifactId: ids.artifact, contentSha256: sha(COPY), expectedVersion: 0 });
    return connection;
  };
  const setup = async () => {
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) ids[key] = randomUUID();
    await db().query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic')", [ids.clinic]);
    for (const [id, pool] of [[ids.practitioner, 'workforce'], [ids.patientAccount, 'consumer'], [ids.otherAccount, 'consumer']] as const) {
      await db().query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db().query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id, pool)]);
    }
    await db().query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [ids.clinic, ids.practitioner]);
    for (const record of [ids.patient, ids.otherPatient]) await db().query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')",
      [record, ids.clinic, 'patient_' + record.replaceAll('-', '')]);
    await db().query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'messaging','FICTIONAL-test/1',$3,'TEST','approved',clock_timestamp(),$4)`, [ids.artifact, ids.clinic, sha(COPY), ids.practitioner]);
    await db().query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [ids.artifact, ids.clinic, COPY, sha(COPY)]);
    ids.connection = await link(ids.patient, ids.patientAccount);
    ids.otherConnection = await link(ids.otherPatient, ids.otherAccount);
  };
  const consent = (purpose?: string) => patient({ action: 'consent', connectionId: ids.connection, scope: 'messaging' }, purpose);
  const withdraw = (expectedVersion = 1, connectionId = ids.connection) => patient({ action: 'withdraw', connectionId, scope: 'messaging', expectedVersion });
  const regrant = (expectedVersion = 2) => patient({ action: 'grant', connectionId: ids.connection, scope: 'messaging', artifactId: ids.artifact, contentSha256: sha(COPY), expectedVersion });
  const close = (status = 'suspended') => db().query('update clinical_core.organizations set status=$2 where id=$1', [ids.clinic, status]);
  const history = async (connection = ids.connection) => (await db().query<{ s: string }>(`select version||':'||status s from clinical_core.consent_grants
    where connection_id=$1 and scope='messaging' order by version`, [connection])).rows.map(row => row.s);
  const rows = async () => (await db().query<{ n: number }>('select count(*)::int n from clinical_core.consent_grants where organization_id=$1', [ids.clinic])).rows[0]!.n;
  return { ids, setup, as, patient, consumer, consent, withdraw, regrant, close, history, rows };
}

describe('as deployed (106 migrations, no successor): the gap, pinned', () => {
  let db: PGlite;
  const h = harness(() => db);
  beforeAll(async () => { db = await build([]); }, 300_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it.each(['suspended', 'archived'])('in a %s clinic the patient can neither read their own consent status nor withdraw it here', async status => {
    await h.close(status);
    expect(await outcome(h.consent())).toBe(REFUSED);
    expect(await outcome(h.withdraw())).toBe(REFUSED);
    expect(await h.history()).toEqual(['1:granted']);
  });

  it('the route\'s own rule for an archived chart: no new grant, but status and withdrawal stay available', async () => {
    await db.query("update clinical_core.patient_records set status='archived' where id=$1", [h.ids.patient]);
    expect(await outcome(h.consent())).toBe('admitted');
    expect(await outcome(h.withdraw())).toBe('admitted');
    expect(await outcome(h.regrant())).toBe(REFUSED);
    expect(await h.history()).toEqual(['1:granted', '2:revoked']);
  });

  it('the other patient route (the identity API\'s revoke_consent_grant, consumer branch) does withdraw in a suspended clinic', async () => {
    await h.close();
    await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'consent_management','production-clinical','clinical_phi')",
        [h.ids.patientAccount, h.ids.clinic, `subject-consumer-${h.ids.patientAccount}`]);
      await tx.query("select consent_id from clinical_core.revoke_consent_grant($1,'messaging','patient_request')", [h.ids.connection]);
    });
    expect(await h.history()).toEqual(['1:granted', '2:revoked']);
  });
});

for (const [stage, files] of [['on the deployed schema', [SUCCESSOR]], ['on the full BLOCKED workforce chain', [...FULL_CHAIN, SUCCESSOR]]] as const) {
  describe(`the successor ${stage}`, () => {
    let db: PGlite;
    const h = harness(() => db);
    beforeAll(async () => { db = await build(files); }, 300_000);
    afterAll(async () => { await db?.close(); });
    beforeEach(() => h.setup());

    it.each(['suspended', 'archived'])('in a %s clinic the patient reads their own consent status and withdraws it', async status => {
      await h.close(status);
      expect(await h.consent()).toMatchObject({ connectionId: h.ids.connection, status: 'granted', version: 1 });
      expect(await h.withdraw()).toMatchObject({ status: 'revoked', version: 2, alreadyApplied: false });
      expect(await h.history()).toEqual(['1:granted', '2:revoked']);
      // A retry is a receipt; a stale version is a conflict; nothing is recorded twice.
      expect(await h.withdraw()).toMatchObject({ status: 'revoked', version: 2, alreadyApplied: true });
      expect(await outcome(h.withdraw(0))).toBe('refused:conflict:care_connection_conflict');
      expect(await h.history()).toEqual(['1:granted', '2:revoked']);
    });

    it('a closed clinic still admits no new grant, no new link and no connection lookup, and nothing is written', async () => {
      await h.withdraw();
      await h.close();
      const before = await h.rows();
      expect(await outcome(h.regrant())).toBe(REFUSED);
      expect(await outcome(h.patient({ action: 'connection' }))).toBe(REFUSED);
      expect(await outcome(h.patient({ action: 'claim', token: 'ABCDEFGHJKLMN' }))).toBe(REFUSED);
      // Under the full chain the window's entry refuses the unconverted workforce caller first.
      expect(await outcome(h.as(h.ids.practitioner, 'workforce', 'clinical_data', { action: 'issue', patientRecordId: h.ids.patient })))
        .toBe(files.length > 1 ? 'refused:identity_refused:request_context_refused' : REFUSED);
      expect(await h.rows()).toBe(before);
    });

    it('only the owner withdraws: another patient\'s connection, a disabled account and the wrong purpose are refused', async () => {
      await h.close();
      expect(await outcome(h.withdraw(1, h.ids.otherConnection))).toBe(REFUSED);
      expect(await outcome(h.consent('identity_link'))).toBe(REFUSED);
      await db.query("update clinical_core.identities set status='disabled' where person_id=$1", [h.ids.patientAccount]);
      expect(await outcome(h.withdraw())).toMatch(/^refused:identity_refused:/);
      expect(await h.history()).toEqual(['1:granted']);
      expect(await h.history(h.ids.otherConnection)).toEqual(['1:granted']);
    });

    it('an active clinic is unchanged: status, withdrawal, a new grant and the connection lookup all work', async () => {
      expect(await outcome(h.patient({ action: 'connection' }))).toBe('admitted');
      expect(await outcome(h.withdraw())).toBe('admitted');
      expect(await outcome(h.regrant())).toBe('admitted');
      expect(await h.history()).toEqual(['1:granted', '2:revoked', '3:granted']);
    });

    it('decides nothing about patient copies (D5): care_connection_actor is unchanged and still private', async () => {
      expect(await prosrc(db, ACTOR)).toBe(PINS.actor);
      expect((await db.query<{ x: boolean }>(`select has_function_privilege('clinical_core_api', to_regprocedure($1), 'EXECUTE') x`, [ACTOR])).rows[0]!.x).toBe(false);
    });

    if (files.length > 1) it('under the full chain: the practitioner still cannot grant in the suspended clinic, and the patient still withdraws', async () => {
      await h.close();
      const asPractitioner = (sql: string, args: unknown[]) => db.transaction(async tx => {
        await tx.exec('set local role clinical_core_api');
        await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'consent_management','production-clinical','clinical_phi')",
          [h.ids.practitioner, h.ids.clinic, `subject-workforce-${h.ids.practitioner}`]);
        return (await tx.query(sql, args)).rows;
      });
      expect(await outcome(asPractitioner("select consent_id from clinical_core.record_consent_grant($1,$2,'messaging','in_person','self')", [h.ids.otherConnection, h.ids.artifact])))
        .toBe('refused:identity_refused:consent_actor_refused');
      expect(await outcome(h.withdraw())).toBe('admitted');
    });
  });
}

describe('the release unit: the deployed service binds every function body by digest', () => {
  let db: PGlite;
  const h = harness(() => db);
  const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    const query: ClinicalCoreTransaction['query'] = async (sql, args = []) => {
      try { return await tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)); } catch (error) {
        const text = message(error);
        if (/care_connection_conflict/.test(text)) throw new ClinicalCoreDatabaseRejection('conflict');
        if (/care_connection_refused|request_context_refused/.test(text)) throw new ClinicalCoreDatabaseRejection('identity_refused');
        throw error;
      }
    };
    return work({ query });
  }) };
  const deployedDigests = (): CareConnectionFunctionBinding[] => [...schema.files['20261006020000_production_care_connections.sql']!
    .matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, name, body]) => ({ name: name!, bodySha256: sha(body!), apiExecute: name!.startsWith('clinical_core.') }));
  const context = (): ProductionClinicalRequestContext => ({ actorPersonId: h.ids.patientAccount, organizationId: h.ids.clinic, identityPool: 'consumer',
    identitySubject: `subject-consumer-${h.ids.patientAccount}`, purpose: 'consent_management', environment: 'production-clinical', dataClassification: 'clinical_phi',
    containsPhi: true, realPatientData: true, productionBound: true });
  beforeAll(async () => { db = await build([SUCCESSOR]); }, 300_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it('bound to the deployed digests, the service refuses every action once the successor is applied: it never runs a body it was not built for', async () => {
    const service = createProductionCareConnections(bindCareConnectionDatabase(database, deployedDigests()));
    await h.close();
    for (const request of [{ action: 'consent', connectionId: h.ids.connection, scope: 'messaging' }, { action: 'withdraw', connectionId: h.ids.connection, scope: 'messaging', expectedVersion: 1 }])
      await expect(service(context(), request)).rejects.toThrow('service_unavailable');
    expect(await h.history()).toEqual(['1:granted']);
  });

  it('bound to the successor\'s digest, the service serves the patient\'s status and withdrawal in a suspended clinic', async () => {
    const digests = deployedDigests().map(f => f.name === 'clinical_core.production_care_connection_request' ? { ...f, bodySha256: PINS.prosrc.successor } : f);
    const service = createProductionCareConnections(bindCareConnectionDatabase(database, digests));
    await h.close();
    expect(await service(context(), { action: 'consent', connectionId: h.ids.connection, scope: 'messaging' })).toMatchObject({ status: 'granted', version: 1 });
    expect(await service(context(), { action: 'withdraw', connectionId: h.ids.connection, scope: 'messaging', expectedVersion: 1 })).toMatchObject({ status: 'revoked', version: 2 });
    await expect(service(context(), { action: 'connection' })).rejects.toThrow('identity_refused');
  });
});

describe('pins, guards and the preserving rollback', () => {
  it('is pinned: both file digests, the parent and successor bodies; the rollback names both', async () => {
    expect(sha(read(SUCCESSOR))).toBe(PINS.sha256);
    expect(sha(read(ROLLBACK))).toBe(PINS.rollbackSha256);
    for (const file of [SUCCESSOR, ROLLBACK]) for (const hash of [PINS.prosrc.parent, PINS.prosrc.successor, PINS.actor]) expect(read(file)).toContain(hash);
    const db = await build([]);
    expect(await prosrc(db, REQUEST)).toBe(PINS.prosrc.parent);
    await apply(db, SUCCESSOR);
    expect(await prosrc(db, REQUEST)).toBe(PINS.prosrc.successor);
    expect((await db.query<{ x: boolean }>(`select has_function_privilege('clinical_core_api', to_regprocedure($1), 'EXECUTE') x`, [REQUEST])).rows[0]!.x).toBe(true);
    await db.close();
  }, 300_000);

  it('applies once; refuses a drifted parent, a drifted care_connection_actor and the synthetic-staging schema', async () => {
    const db = await build([SUCCESSOR]);
    expect(message(await apply(db, SUCCESSOR).catch(e => e))).toMatch(/care_connection_patient_withdrawal_parent_refused/);
    await db.close();
    const drifted = await build([]);
    await drifted.exec("alter function clinical_private.care_connection_actor(text,text) rename to care_connection_actor_original");
    await drifted.exec(`create function clinical_private.care_connection_actor(_pool text,_purpose text) returns uuid language plpgsql stable security definer set search_path='' as $$ begin return null; end $$`);
    expect(message(await apply(drifted, SUCCESSOR).catch(e => e))).toMatch(/care_connection_patient_withdrawal_parent_refused/);
    expect(await prosrc(drifted, REQUEST)).toBe(PINS.prosrc.parent);
    await drifted.close();
    const synthetic = new PGlite({ extensions: { pgcrypto } });
    try {
      const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: Array<{ file: string }> };
      for (const migration of manifest.migrations) await synthetic.exec(readFileSync('infra/aws-clinical-core/migrations/' + migration.file, 'utf8'));
      expect(message(await apply(synthetic, SUCCESSOR).catch(e => e))).toMatch(/care_connection_patient_withdrawal_parent_refused/);
    } finally { await synthetic.close(); }
  }, 300_000);

  it('the rollback restores the parent byte for byte, keeps every consent row, refuses twice, and the successor applies again over it', async () => {
    const db = await build([SUCCESSOR]);
    const h = harness(() => db);
    await h.setup();
    await h.close();
    await h.withdraw();
    const before = await h.rows();
    await apply(db, ROLLBACK);
    expect(await prosrc(db, REQUEST)).toBe(PINS.prosrc.parent);
    expect(await h.rows()).toBe(before);
    expect(await h.history()).toEqual(['1:granted', '2:revoked']);
    // The gap returns with the parent: that is what restoring it means.
    expect(await outcome(h.consent())).toBe(REFUSED);
    expect(message(await apply(db, ROLLBACK).catch(e => e))).toMatch(/care_connection_patient_withdrawal_rollback_refused/);
    await apply(db, SUCCESSOR);
    expect(await prosrc(db, REQUEST)).toBe(PINS.prosrc.successor);
    expect(await outcome(h.consent())).toBe('admitted');
    await db.close();
  }, 300_000);
});
