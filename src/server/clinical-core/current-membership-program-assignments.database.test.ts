import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCurrentMembershipProgramAssignments } from './current-membership-program-assignments';
import { createProductionProgramAssignments, PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256, PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256,
  ProductionProgramAssignmentError } from './production-program-assignments';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';

// Assigned programs under the unactivated `database_current` workforce authority: the real current-membership adapter
// for the practitioner, the real production adapter for the patient app, the assembled production schema, the two lab
// candidates, the BLOCKED program candidate and consumer boundary, and the UNREGISTERED current-membership setter, in
// PGlite with fictional rows. Nothing here registers, applies or deploys SQL, and nothing is hosted evidence.
const PARENT = 'infra/aws-clinical-core/production-candidates/production-program-assignments.sql';
const BOUNDARY = 'infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql';
const LAB_CANDIDATES = ['infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql', 'infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql'];
const SETTER = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const SETTER_ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context-rollback.sql';
const DESTINATION = 'https://shop.example.test/fictional-destination-5a1e';
const CLINIC = randomUUID(), SECOND = randomUUID();
const worker = () => ({ person: randomUUID(), sub: randomUUID() });
const practitioner = worker(), colleague = worker(), staff = worker(), outsider = worker();
let owner: string, otherOwner: string, patient: string, connection: string, program: string, version: string, secondVersion: string;

let db: PGlite;
let afterBinding: ((tx: Transaction) => Promise<void>) | undefined;
let transactions = 0;
const queries: string[] = [];
const REQUEST_INVALID = /\bprogram_assignment_invalid\b/;
const CONFLICT = /\b(program_assignment_conflict|program_assignment_version_changed|program_assignment_revision_stale|program_review_stale|program_assignment_state_invalid|program_tasks_remaining|program_phase_not_due|program_check_in_required|program_practitioner_review_required|program_clinical_items_held|program_item_held)\b/;
const unwrap = (v: unknown) => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v;
const database: ClinicalCoreDatabase = { transaction: async work => {
  transactions += 1;
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    return work({ query: async (sql: string, parameters: readonly unknown[] = []) => {
      queries.push(sql);
      try {
        const result = await tx.query(sql, parameters.map(unwrap));
        if (sql.startsWith('select clinical_private.set_current_workforce_context(') && afterBinding) await afterBinding(tx);
        return result as never;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection(
          REQUEST_INVALID.test(message) ? 'request_invalid' : CONFLICT.test(message) ? 'conflict' : 'operation_refused');
      }
    } });
  });
} };
const activation = { contract: 'production-program-activation/1', enabled: true, target: 'production-clinical',
  schemaCandidateSha256: PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' };
const boundaryActivation = { contract: 'program-consumer-boundary-activation/1', enabled: true, target: 'production-clinical',
  programCandidateSha256: PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256, boundaryCandidateSha256: PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256,
  evidenceSha256: 'd'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-14T00:00:00Z' };
const workforce = createCurrentMembershipProgramAssignments({ database, activation, boundaryActivation });
const consumerCore = vi.fn(async () => undefined);
const app = createProductionProgramAssignments({ database, activation, boundaryActivation, verifyConsumerCore: consumerCore });
const as = (who: { sub: string }, clinic = CLINIC) => ({ subject: who.sub, selectedOrganizationId: clinic });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers are checked field by field
const practice = async (request: unknown, who: { sub: string } = practitioner, clinic = CLINIC) => await workforce(as(who, clinic), request) as Json;
const patientApp = async (request: unknown, person = owner, clinic = CLINIC) => await app({ actorPersonId: person, organizationId: clinic,
  identitySubject: 'fictional-' + person, identityPool: 'consumer', purpose: 'clinical_data', environment: 'production-clinical',
  dataClassification: 'clinical_phi', productionBound: true, containsPhi: true, realPatientData: true } satisfies ProductionClinicalRequestContext,
request, 'Bearer fictional-consumer') as Json;
async function refusal(call: Promise<unknown>): Promise<ProductionProgramAssignmentError> {
  try { await call; } catch (error) { if (error instanceof ProductionProgramAssignmentError) return error; throw error; }
  throw new Error('expected a refusal');
}
const setterCalls = () => queries.filter(sql => sql.startsWith('select clinical_private.set_current_workforce_context(')).length;
const programCalls = () => queries.filter(sql => sql.includes('production_program_bounded_request')).length;
const count = async (sql: string, args: unknown[] = []) => Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, args)).rows[0]!.n);
const membership = (who: { person: string }, clinic: string, set: string) =>
  db.query(`update clinical_core.organization_memberships set ${set} where organization_id=$1 and person_id=$2`, [clinic, who.person]);

const lesson = (id: string) => ({ id, title: 'Fictional lesson ' + id, kind: 'lesson', instructions: 'Read the fictional lesson.', released: true, authorship: 'practitioner_authored' });
// A supplement step bound to a governed catalog product that this catalog does not hold: the catalog cannot vouch for it.
const supplement = () => ({ id: 'supp-1', title: 'Fictional supplement step', kind: 'supplement', instructions: 'Fictional instruction.', released: true,
  product: { id: 'product-fictional-1', ingredientKeys: ['fictional_other_mineral'], dose: '100 mg', purchaseUrl: DESTINATION,
    catalog: { stableId: 'prd_fictional_unlisted', version: 1, target: 'production-clinical' } } });
const content = () => ({ title: 'Fictional', modules: [], consumerProgram: { title: 'Fictional mineral guide', phases: [
  { id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [lesson('lesson-a'), supplement()] },
  { id: 'phase-2', title: 'Phase two', days: 1, transition: 'practitioner', items: [lesson('lesson-b')] }] } });
async function publish(clinic: string, author: string) {
  const programId = randomUUID(), versionId = randomUUID();
  await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL program','active',$3)", [programId, clinic, author]);
  await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at)
    values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp())`, [versionId, clinic, programId, author]);
  await db.query(`update clinical_core.program_versions set content=$2::jsonb,content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,
    [versionId, JSON.stringify(content())]);
  return { programId, versionId };
}
async function consumerPerson() {
  const person = randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [person, 'fictional-' + person]);
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','program-fixture')", [person]);
  return person;
}
async function link(person: string, clinic = CLINIC) {
  const record = randomUUID(), id = randomUUID();
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')", [record, clinic, 'patient_' + record.replaceAll('-', '')]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [id, clinic, record, person]);
  return { record, id };
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((m: { file: string }) => m.file.includes('current-membership'))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const candidate of LAB_CANDIDATES) await db.exec(readFileSync(candidate, 'utf8'));
  await db.exec(readFileSync(PARENT, 'utf8'));
  await db.exec(readFileSync(BOUNDARY, 'utf8'));
  await db.exec(readFileSync(SETTER, 'utf8'));
  for (const table of ['production_program_activation', 'program_consumer_boundary_activation']) {
    await db.query(`update clinical_core.${table} set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
  }
  await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values('protocols_supplements','program-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC A'),($2,'FICTIONAL CLINIC B')", [CLINIC, SECOND]);
  for (const who of [practitioner, colleague, staff, outsider]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, 'subject_' + who.person.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.sub]);
  }
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values
    ($1,$3,'practitioner','active'),($2,$3,'practitioner','active'),($1,$4,'practitioner','active'),($1,$5,'staff','active'),($2,$6,'practitioner','active')`,
  [CLINIC, SECOND, practitioner.person, colleague.person, staff.person, outsider.person]);
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  afterBinding = undefined; transactions = 0; queries.length = 0;
  owner = await consumerPerson(); otherOwner = await consumerPerson();
  ({ record: patient, id: connection } = await link(owner));
  ({ programId: program, versionId: version } = await publish(CLINIC, practitioner.person));
  ({ versionId: secondVersion } = await publish(SECOND, outsider.person));
});

describe('a practitioner with one selected clinic', () => {
  it('lists linked patients and published programs, previews without a destination, assigns, releases and reads status', async () => {
    expect((await practice({ action: 'connections' })).connections.map((c: Json) => c.connectionId)).toContain(connection);
    expect((await practice({ action: 'programs' })).programs.map((p: Json) => p.programVersionId)).toContain(version);
    const preview = await practice({ action: 'preview', programVersionId: version });
    expect(JSON.stringify(preview)).not.toContain(DESTINATION);
    expect(preview.phases[0].items[1].product.purchaseUrl).toBeNull();
    const assigned = await practice({ action: 'assign', connectionId: connection, programVersionId: version });
    expect(assigned).toMatchObject({ action: 'assign', state: 'offered', duplicate: false });
    expect((await db.query('select assigned_by from clinical_core.program_assignments where id=$1', [assigned.enrollmentId])).rows)
      .toEqual([{ assigned_by: practitioner.person }]);
    expect(await practice({ action: 'release', enrollmentId: assigned.enrollmentId, phaseId: 'phase-2' }))
      .toEqual({ action: 'release', enrollmentId: assigned.enrollmentId, phaseId: 'phase-2' });
    const status = await practice({ action: 'status', connectionId: connection });
    expect(status.assignments).toEqual([expect.objectContaining({ enrollmentId: assigned.enrollmentId, state: 'offered', connectionId: connection })]);
    expect(setterCalls()).toBe(6);
    expect(queries.filter(sql => sql.includes('set_request_context'))).toEqual([]);
  });

  it('the role is the one current rows hold: a staff member cannot assign or preview', async () => {
    for (const request of [{ action: 'assign', connectionId: connection, programVersionId: version }, { action: 'preview', programVersionId: version }]) {
      expect((await refusal(practice(request, staff))).category).toBe('identity_refused');
    }
    expect(await count('clinical_core.program_assignments where connection_id=$1', [connection])).toBe(0);
  });

  it('a patient app action is never taken on a practitioner\'s membership', async () => {
    for (const action of ['list', 'read', 'accept', 'complete', 'check_in', 'advance', 'pause', 'resume', 'withdraw']) {
      const request = action === 'list' ? { action } : action === 'read' ? { action, enrollmentId: randomUUID() }
        : { action, enrollmentId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedRevision: '1', ...(action === 'accept' ? { planRevision: 'x' } : {}), ...(action === 'complete' ? { itemId: 'lesson-a' } : {}) };
      expect((await refusal(practice(request))).category, action).toBe('identity_refused');
    }
    expect(transactions).toBe(0);
  });
});

describe('the selected clinic and current membership', () => {
  it('a practitioner in two clinics acts only in the one selected: no cross-clinic version, connection or status', async () => {
    const assigned = await practice({ action: 'assign', connectionId: connection, programVersionId: version });
    const inSecond = (await practice({ action: 'programs' }, practitioner, SECOND)).programs.map((p: Json) => p.programVersionId);
    expect(inSecond).toContain(secondVersion);
    expect(inSecond).not.toContain(version);
    expect((await practice({ action: 'status' }, practitioner, SECOND)).assignments.map((a: Json) => a.enrollmentId)).not.toContain(assigned.enrollmentId);
    expect((await practice({ action: 'connections' }, practitioner, SECOND)).connections.map((c: Json) => c.connectionId)).not.toContain(connection);
    await expect(practice({ action: 'assign', connectionId: connection, programVersionId: version }, practitioner, SECOND)).rejects.toBeInstanceOf(ProductionProgramAssignmentError);
    await expect(practice({ action: 'release', enrollmentId: assigned.enrollmentId, phaseId: 'phase-2' }, practitioner, SECOND)).rejects.toBeInstanceOf(ProductionProgramAssignmentError);
    // A member of only the other clinic is refused in this one by current rows.
    expect((await refusal(practice({ action: 'status' }, outsider))).category).toBe('identity_refused');
  });

  it('a suspended, removed or pending membership is refused; restored access works on the next request', async () => {
    await membership(colleague, CLINIC, "status='suspended'");
    try { expect((await refusal(practice({ action: 'programs' }, colleague))).category).toBe('identity_refused'); }
    finally { await membership(colleague, CLINIC, "status='active'"); }
    await membership(colleague, CLINIC, "status='pending'");
    try { expect((await refusal(practice({ action: 'programs' }, colleague))).category).toBe('identity_refused'); }
    finally { await membership(colleague, CLINIC, "status='active'"); }
    expect((await practice({ action: 'programs' }, colleague)).action).toBe('programs');
    expect((await refusal(practice({ action: 'programs' }, { sub: randomUUID() }))).category).toBe('identity_refused');
  });

  it('a suspension inside the transaction after binding refuses the assignment and keeps nothing', async () => {
    afterBinding = async tx => {
      await tx.exec('reset role');
      await tx.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [CLINIC, practitioner.person]);
      await tx.exec('set local role clinical_core_api');
    };
    expect((await refusal(practice({ action: 'assign', connectionId: connection, programVersionId: version })))).toBeInstanceOf(ProductionProgramAssignmentError);
    expect(await count('clinical_core.program_assignments where connection_id=$1', [connection])).toBe(0);
    expect((await db.query('select status from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [CLINIC, practitioner.person])).rows)
      .toEqual([{ status: 'active' }]);
  });
});

describe('the patient app: its own owner, its current connection, the exact released program', () => {
  async function offered() {
    const assigned = await practice({ action: 'assign', connectionId: connection, programVersionId: version });
    const seen = await patientApp({ action: 'read', enrollmentId: assigned.enrollmentId });
    return { assigned, seen };
  }
  it('a replayed assignment is the same assignment, and the app adopts only the exact version, revision and review it was shown', async () => {
    const { assigned, seen } = await offered();
    expect(await practice({ action: 'assign', connectionId: connection, programVersionId: version }))
      .toMatchObject({ enrollmentId: assigned.enrollmentId, duplicate: true });
    expect(await count('clinical_core.program_assignments where connection_id=$1', [connection])).toBe(1);
    expect((await refusal(patientApp({ action: 'accept', enrollmentId: assigned.enrollmentId, sourceDigest: 'f'.repeat(64),
      expectedRevision: seen.assignment.revision, planRevision: seen.review.planRevision })))).toBeInstanceOf(ProductionProgramAssignmentError);
    expect((await refusal(patientApp({ action: 'accept', enrollmentId: assigned.enrollmentId, sourceDigest: seen.assignment.sourceDigest,
      expectedRevision: '99', planRevision: seen.review.planRevision }))).category).toBe('conflict');
    expect((await refusal(patientApp({ action: 'read', enrollmentId: assigned.enrollmentId }, otherOwner))).category).toBe('identity_refused');
    expect((await refusal(patientApp({ action: 'read', enrollmentId: assigned.enrollmentId }, owner, SECOND))).category).toBe('identity_refused');
    const accepted = await patientApp({ action: 'accept', enrollmentId: assigned.enrollmentId, sourceDigest: seen.assignment.sourceDigest,
      expectedRevision: seen.assignment.revision, planRevision: seen.review.planRevision });
    expect(accepted).toMatchObject({ action: 'accept', enrollmentId: assigned.enrollmentId, state: 'active' });
    expect(consumerCore).toHaveBeenCalled();
  });

  it('a supplement step whose governed catalog cannot vouch for it stays held, with no destination; lessons and progress go on', async () => {
    const { assigned, seen } = await offered();
    expect(seen.review.held).toContain('supp-1');
    expect(JSON.stringify(seen)).not.toContain(DESTINATION);
    await patientApp({ action: 'accept', enrollmentId: assigned.enrollmentId, sourceDigest: seen.assignment.sourceDigest,
      expectedRevision: seen.assignment.revision, planRevision: seen.review.planRevision });
    const active = await patientApp({ action: 'read', enrollmentId: assigned.enrollmentId });
    const bound = (itemId: string, view = active) => patientApp({ action: 'complete', enrollmentId: assigned.enrollmentId, sourceDigest: view.assignment.sourceDigest,
      expectedRevision: view.assignment.revision, planRevision: view.review.planRevision, itemId });
    // Held is refused before any write. (The production adapter reports program_item_held as a refusal, 403, not a
    // conflict: the database classifies it as operation_refused. Recorded, not changed here.)
    const before = await count('clinical_core.program_assignment_completions where assignment_id=$1', [assigned.enrollmentId]);
    expect((await refusal(bound('supp-1'))).category).toBe('identity_refused');
    expect(await count('clinical_core.program_assignment_completions where assignment_id=$1', [assigned.enrollmentId])).toBe(before);
    expect(await bound('lesson-a')).toMatchObject({ action: 'complete', itemId: 'lesson-a' });
    // Refused practitioner requests (another clinic, a stale membership) leave the patient's progress as it was.
    await refusal(practice({ action: 'release', enrollmentId: assigned.enrollmentId, phaseId: 'phase-2' }, outsider));
    await refusal(practice({ action: 'status' }, staff));
    expect((await patientApp({ action: 'read', enrollmentId: assigned.enrollmentId })).completed).toEqual(['lesson-a']);
  });

  it('a replaced connection: the old assignment leaves the app, and the practitioner cannot assign to the old link', async () => {
    const { assigned } = await offered();
    await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1", [connection]);
    const replacement = randomUUID();
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
      [replacement, CLINIC, patient, owner]);
    expect((await patientApp({ action: 'list' })).assignments.map((a: Json) => a.enrollmentId)).not.toContain(assigned.enrollmentId);
    expect((await refusal(practice({ action: 'assign', connectionId: connection, programVersionId: version })))).toBeInstanceOf(ProductionProgramAssignmentError);
    expect((await practice({ action: 'connections' })).connections.map((c: Json) => c.connectionId)).toContain(replacement);
    expect((await practice({ action: 'assign', connectionId: replacement, programVersionId: version }))).toMatchObject({ duplicate: false });
  });

  it('a withdrawal by the patient is what the practitioner sees, and is not undone by a later release', async () => {
    const { assigned, seen } = await offered();
    await patientApp({ action: 'accept', enrollmentId: assigned.enrollmentId, sourceDigest: seen.assignment.sourceDigest,
      expectedRevision: seen.assignment.revision, planRevision: seen.review.planRevision });
    const active = await patientApp({ action: 'read', enrollmentId: assigned.enrollmentId });
    expect(await patientApp({ action: 'withdraw', enrollmentId: assigned.enrollmentId, sourceDigest: active.assignment.sourceDigest,
      expectedRevision: active.assignment.revision })).toMatchObject({ action: 'withdraw', state: 'withdrawn' });
    await practice({ action: 'release', enrollmentId: assigned.enrollmentId, phaseId: 'phase-2' });
    expect((await practice({ action: 'status', connectionId: connection })).assignments[0]).toMatchObject({ state: 'withdrawn' });
    expect((await patientApp({ action: 'list' })).assignments.map((a: Json) => a.enrollmentId)).not.toContain(assigned.enrollmentId);
  });
});

describe('held before any request', () => {
  it('without the activation evidence or the boundary evidence, nothing reaches the database', async () => {
    for (const deps of [{ database }, { database, activation }, { database, boundaryActivation },
      { database, activation: { ...activation, schemaCandidateSha256: 'a'.repeat(64) }, boundaryActivation }]) {
      expect((await refusal(createCurrentMembershipProgramAssignments(deps)(as(practitioner), { action: 'programs' }))).category).toBe('activation_refused');
    }
    expect(transactions).toBe(0);
  });

  it('while the setter is not registered, every request is unavailable before any program function runs', async () => {
    await db.exec(readFileSync(SETTER_ROLLBACK, 'utf8'));
    try {
      expect((await refusal(practice({ action: 'programs' }))).category).toBe('service_unavailable');
      expect(programCalls()).toBe(0);
    } finally { await db.exec(readFileSync(SETTER, 'utf8')); }
    expect((await practice({ action: 'programs' })).action).toBe('programs');
  });

  it('a body that names a clinic, a person or a content is not a request', async () => {
    for (const request of [{ action: 'programs', organizationId: SECOND }, { action: 'assign', connectionId: connection, programVersionId: version, phases: [] },
      { action: 'status', actorPersonId: colleague.person }]) {
      expect((await refusal(practice(request))).category).toBe('request_invalid');
    }
    expect(transactions).toBe(0);
    void program;
  });
});
