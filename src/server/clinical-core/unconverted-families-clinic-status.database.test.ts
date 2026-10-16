import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Two of the unconverted claims families under the deployed default (`legacy_claims`), path by path, on the real
 * production schema: the encounter-recording authority (a `clinical_data` request: the practitioner adds a recording
 * participant to an encounter) and privacy operations (a `consent_management` request: the assigned operator's queue).
 * Each runs as its service runs it: set_request_context with the token's clinic and person, then the operation.
 *
 * - The recording authority checks the membership row, so a removed member is refused on the next request; it does not
 *   check the clinic's status, so a member of a suspended clinic keeps writing (the same gap as the compatibility RPC).
 *   The BLOCKED successor legacy-claims-clinic-status.sql refuses it.
 * - Privacy operations are not decided by clinic membership at all: a reviewed operator assignment with its own expiry
 *   and revocation is the authority, so neither a removed membership nor a suspended clinic changes the answer, with
 *   or without the successor (which leaves consent management running by design). Revoking the assignment refuses.
 *
 * Fictional rows only; no AWS, no Data API, no token verification here.
 */
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql';
let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };

async function database(withSuccessor: boolean) {
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  if (withSuccessor) await db.exec(readFileSync(SUCCESSOR, 'utf8'));
  return db;
}

beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
});

describe.each([false, true])('legacy claims, successor applied: %s', withSuccessor => {
  let db: PGlite;
  let org: string, practitioner: string, operator: string, reviewer: string, owner: string, patient: string;
  beforeAll(async () => { db = await database(withSuccessor); }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    [org, practitioner, operator, reviewer, owner, patient] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic')", [org]);
    for (const [id, pool] of [[practitioner, 'workforce'], [operator, 'workforce'], [reviewer, 'workforce'], [owner, 'consumer']] as const) {
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, 'subject-' + id]);
    }
    // The practitioner is a member; the privacy operator is not a member of any clinic, only assigned.
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, practitioner]);
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
      [patient, org, 'patient_' + patient.replaceAll('-', '')]);
    await db.query(`insert into clinical_private.owned_privacy_operator_assignments(operator_id,owner_id,reviewed_by,evidence_sha256,approved_at,expires_at)
      values($1,$2,$3,repeat('a',64),now()-interval '1 day',now()+interval '1 day')`, [operator, owner, reviewer]);
    await db.query("insert into clinical_private.owned_privacy_requests(id,owner_id,request_id,kind,status) values($1,$2,$3,'deletion','in_progress')",
      [randomUUID(), owner, randomUUID()]);
  });

  async function as<T>(who: string, purpose: 'clinical_data' | 'consent_management', sql: string, args: unknown[] = []): Promise<T> {
    return db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,$4,'production-clinical','clinical_phi')",
        [who, org, 'subject-' + who, purpose]);
      return (await tx.query<{ result: T }>(sql, args)).rows[0]!.result;
    });
  }
  const encounter = () => as<string>(practitioner, 'clinical_data', 'select clinical_core.start_encounter($1,$2) as result', [org, patient]);
  const addParticipant = (encounterId: string) => as<string>(practitioner, 'clinical_data',
    "select clinical_private.add_encounter_recording_participant($1,'patient','FICTIONAL PARTICIPANT',true,$2) as result", [encounterId, randomUUID()]);
  const participants = async (encounterId: string) => (await db.query<{ n: number }>(
    'select count(*)::int as n from clinical_private.recording_participants where encounter_id=$1', [encounterId])).rows[0]!.n;
  const privacyQueue = () => as<Array<{ ownerId: string }>>(operator, 'consent_management',
    'select clinical_private.list_assigned_privacy_requests(null,25,false) as result');

  it('control: the recording authority admits a current practitioner; the privacy queue admits the assigned operator', async () => {
    const encounterId = await encounter();
    await expect(addParticipant(encounterId)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect((await privacyQueue()).map(row => row.ownerId)).toEqual([owner]);
  });

  it('encounter recording: a removed membership is refused on the next request, and nothing is written', async () => {
    const encounterId = await encounter();
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, practitioner]);
    await expect(addParticipant(encounterId)).rejects.toThrow();
    expect(await participants(encounterId)).toBe(0);
  });

  it.each(['suspended', 'archived'])(`encounter recording: a %s clinic — ${withSuccessor ? 'refused by the successor, nothing written' : 'GAP: the already-selected session still writes'}`, async clinicStatus => {
    const encounterId = await encounter();
    await db.query('update clinical_core.organizations set status=$2 where id=$1', [org, clinicStatus]);
    if (withSuccessor) {
      await expect(addParticipant(encounterId)).rejects.toThrow(/request_context_refused/);
      expect(await participants(encounterId)).toBe(0);
    } else {
      await expect(addParticipant(encounterId)).resolves.toMatch(/^[0-9a-f-]{36}$/);
      expect(await participants(encounterId)).toBe(1);
    }
  });

  it('privacy operations: decided by the operator assignment, not clinic membership or clinic status; revoking the assignment refuses', async () => {
    // No membership anywhere, and the clinic suspended: the separately reviewed assignment still decides.
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [org]);
    expect((await privacyQueue()).map(row => row.ownerId)).toEqual([owner]);
    await db.query('update clinical_private.owned_privacy_operator_assignments set revoked_at=now() where operator_id=$1', [operator]);
    expect(await privacyQueue()).toEqual([]);
  });
});
