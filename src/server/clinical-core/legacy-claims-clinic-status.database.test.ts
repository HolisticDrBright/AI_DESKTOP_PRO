import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';

/**
 * The deployed default authority (`legacy_claims`) over the real 106-migration production schema, for the four
 * onboarding cases the route matrix asks about (src/server/route-authority-inventory.ts). Under legacy claims the clinic
 * and person come from the token, then each SQL operation checks current membership rows. What it does NOT check is
 * the clinic's own status: `assert_production_context` (64 call sites) compares the claimed clinic, and the role
 * checks read the membership row only. A session that selected a clinic before the clinic was suspended keeps
 * writing into it until its token is refused for another reason.
 *
 * The last two cases pin that gap on purpose. Closing it changes every legacy family at once, so it is a decision
 * (docs/desktop-onboarding-authority-2026-10-16.md), not a test to flip quietly: whoever closes it updates these
 * expectations and the inventory together. Fictional rows only; no AWS, no Data API, no token verification here.
 */
let db: PGlite;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let org: string, person: string, stranger: string;
const subject = (id: string) => 'subject-' + id;

async function asApi<T>(actor: string, work: (query: (sql: string, args?: unknown[]) => Promise<unknown[]>) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
      [actor, org, 'workforce', subject(actor), 'clinical_data', 'production-clinical', 'clinical_phi']);
    return work(async (sql, args = []) => (await tx.query(sql, args)).rows);
  });
}
const createPatient = (actor: string) => asApi(actor, query => query("select clinical_core.create_patient_profile($1,'Fictional','Patient') as created", [org]));
const myClinics = (actor: string) => asApi(actor, query => query('select organization_id from clinical_core.list_my_organizations()'));

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
  db = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) as never })) };
  await applyProductionClinicalCoreMigrations(admin, manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: files[m.file], sha256: sha(files[m.file]) })));
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [org, person, stranger] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic')", [org]);
  for (const id of [person, stranger]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [id, subject(id)]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, person]);
});

describe('legacy claims: what the operation itself refuses', () => {
  it('control: an active practitioner of an active clinic writes', async () => {
    await expect(createPatient(person)).resolves.toHaveLength(1);
  });
  it('an unapproved self-signed-up account (identity, no membership) naming the clinic is refused', async () => {
    await expect(createPatient(stranger)).rejects.toThrow();
    expect(await db.query('select count(*)::integer as n from clinical_core.patient_records where organization_id=$1', [org]))
      .toMatchObject({ rows: [{ n: 0 }] });
  });
  it('a removed (suspended) membership is refused on the next request, whatever the already-issued token claims', async () => {
    await expect(createPatient(person)).resolves.toHaveLength(1);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, person]);
    await expect(createPatient(person)).rejects.toThrow();
  });
});

describe('legacy claims: GAP (decision required) — the clinic\'s own status is not checked', () => {
  it.each(['suspended', 'archived'])('a %s clinic: its clinic list hides it, but an already-selected session still writes into it', async status => {
    await db.query('update clinical_core.organizations set status=$2 where id=$1', [org, status]);
    // Sign-in and the clinic chooser no longer offer it...
    expect(await myClinics(person)).toEqual([]);
    // ...but a session whose token and cookie already name it is admitted by the operation itself.
    await expect(createPatient(person)).resolves.toHaveLength(1);
    expect(await db.query('select count(*)::integer as n from clinical_core.patient_records where organization_id=$1', [org]))
      .toMatchObject({ rows: [{ n: 1 }] });
  });
});
