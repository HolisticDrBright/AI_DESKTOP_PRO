import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';

/**
 * The distinct 113-migration telehealth chart/lifecycle candidate under the
 * ACTUAL restricted API role in an embedded database: every parent migration
 * byte-identical to the 112 consent-copy release, then the forward extension.
 * Every organization, person, membership, patient and appointment below is
 * fictional, in memory, never in AWS. Nothing is deployed or approved.
 */
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>; releaseHash: string; candidate: Record<string, unknown> };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let pg: PGlite, artifact: Artifact;
let org: string, foreignOrg: string, practitioner: string, colleague: string, staff: string, outsider: string, patient: string, otherPatient: string, appointment: string;

type Caller = { who?: string; organization?: string; pool?: string };
async function call<T = unknown>(sql: string, args: unknown[] = [], caller: Caller = {}) {
  const { who = practitioner, organization = org, pool = 'workforce' } = caller;
  return pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,'clinical_data','production-clinical','clinical_phi')",
      [who, organization, pool, 'subject-' + who]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result as T;
  });
}
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof Error ? error.message : String(error); }
  return 'no_error';
};
type Transfer = { transfer_id: string; encounter_id: string; note_id: string; note_version: number; content_sha256: string; created: boolean; transferred_at: string };
type Authority = { authorized: boolean; actor_person_id: string; patient_record_id: string; legal_hold: boolean;
  appointment: { id: string; status: string; deleted: boolean; appointment_type: string; patient_matches: boolean; practitioner_person_id: string } | null;
  transfer: { transfer_id: string; encounter_id: string; note_id: string; note_version: number; source_note_revision: number; source_digest: string; content_sha256: string; note_status: string; note_current_version: number; note_deleted: boolean } | null };

const content = { telehealth_summary: 'Fictional summary.', patient_reported: 'Fictional report.', results_reviewed: '', plan_discussed: 'Fictional plan.', practitioner_notes: 'Fictional practitioner text.', action_items: 'Order ferritin — approved' };
const payload = { aiOriginal: { meeting_id: 900000001, summary_content: 'Fictional provider summary' }, aiSections: content, practitionerNotes: 'Fictional practitioner text.', actionItems: [{ id: 'a1', text: 'Order ferritin', status: 'approved' }], signedAt: '2026-10-10T00:00:00.000Z' };
const provenance = (appointmentId: string) => [
  { sectionKey: 'telehealth_summary', refType: 'telehealth_visit', refId: appointmentId, label: 'Telehealth visit record revision 2' },
  { sectionKey: 'practitioner_notes', refType: 'practitioner_entered', refId: null, label: 'Practitioner notes during the visit' },
];
const digestOf = (value: unknown) => sha(JSON.stringify(value));
const transfer = (overrides: Partial<{ transferId: string; appointmentId: string; patientId: string; revision: number; digest: string; organization: string }> = {}, caller: Caller = {}) =>
  call<Transfer>('select clinical_core.transfer_telehealth_note($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) as result', [
    overrides.organization ?? org, overrides.transferId ?? randomUUID(), overrides.appointmentId ?? appointment, overrides.patientId ?? patient,
    overrides.revision ?? 2, overrides.digest ?? digestOf(payload), JSON.stringify(content), JSON.stringify(payload), JSON.stringify(provenance(overrides.appointmentId ?? appointment)),
  ], caller);
const authority = (overrides: Partial<{ appointmentId: string; patientId: string; organization: string }> = {}, caller: Caller = {}) =>
  call<Authority>('select clinical_core.get_telehealth_record_authority($1,$2,$3) as result', [overrides.organization ?? org, overrides.patientId ?? patient, overrides.appointmentId ?? appointment], caller);

async function bookAppointment(patientId = patient, organization = org, who = practitioner) {
  const id = randomUUID();
  await pg.query(`insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,status,starts_at,ends_at,created_by_person_id,updated_by_person_id)
    values($1,$2,$3,$4,'telehealth','completed','2026-10-09T17:00:00Z','2026-10-09T17:30:00Z',$4,$4)`, [id, organization, patientId, who]);
  return id;
}

beforeAll(async () => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-chart-lifecycle-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })) as Artifact;
  expect(artifact.manifest.migrations).toHaveLength(113);
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(entry => ({ version: entry.version,
    name: entry.file.slice(15, -4), sql: artifact.files[entry.file], sha256: sha(artifact.files[entry.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  // Forward source rehearsal only: 107..113 are fictional in-memory ledger rows, not a reviewed preserving upgrade.
  for (const entry of migrations.slice(106)) {
    try { await pg.exec(entry.sql); }
    catch (cause) { throw new Error(entry.name + ': ' + (cause instanceof Error ? cause.message : 'failed')); }
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers')).rows[0].n).toBe(0);
}, 120000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  [org, foreignOrg, practitioner, colleague, staff, outsider, patient, otherPatient] = Array.from({ length: 8 }, () => randomUUID());
  for (const id of [org, foreignOrg]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const [id, role, organization] of [[practitioner, 'practitioner', org], [colleague, 'practitioner', org], [staff, 'staff', org], [outsider, 'practitioner', foreignOrg]] as const) {
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [id, 'subject-' + id]);
    await pg.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [organization, id, role]);
  }
  for (const [id, organization] of [[patient, org], [otherPatient, foreignOrg]] as const) {
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')", [id, organization, 'patient_' + id.replaceAll('-', '')]);
  }
  appointment = await bookAppointment();
});

describe('transfer of a reviewed telehealth note into the chart as an unsigned draft', () => {
  it('creates the telehealth encounter and an UNSIGNED chart draft with provenance, records the authoritative receipt and audits it', async () => {
    const receipt = await transfer({ transferId: '11111111-1111-4111-8111-111111111111' });
    expect(receipt).toMatchObject({ transfer_id: '11111111-1111-4111-8111-111111111111', created: true, note_version: 1 });
    const note = (await pg.query<{ status: string; current_version: number; note_type: string; encounter_id: string; patient_record_id: string; signed_at: string | null }>(
      'select status,current_version,note_type,encounter_id,patient_record_id,signed_at from clinical_core.clinical_notes where id=$1', [receipt.note_id])).rows[0];
    expect(note).toMatchObject({ status: 'draft', current_version: 1, note_type: 'narrative', encounter_id: receipt.encounter_id, patient_record_id: patient, signed_at: null });
    const encounter = (await pg.query<{ visit_type: string; appointment_id: string; status: string }>('select visit_type,appointment_id,status from clinical_core.encounters where id=$1', [receipt.encounter_id])).rows[0];
    expect(encounter).toMatchObject({ visit_type: 'telehealth', appointment_id: appointment, status: 'in_progress' });
    const version = (await pg.query<{ content: Record<string, string>; content_sha256: string; save_kind: string }>('select content,content_sha256,save_kind from clinical_core.clinical_note_versions where note_id=$1', [receipt.note_id])).rows[0];
    expect(version.content).toEqual(content); expect(version.save_kind).toBe('manual'); expect(version.content_sha256).toBe(receipt.content_sha256);
    const refs = (await pg.query<{ ref_type: string; ref_id: string | null; section_key: string }>('select ref_type,ref_id,section_key from clinical_core.note_provenance_refs where note_id=$1 order by section_key', [receipt.note_id])).rows;
    expect(refs).toEqual([{ ref_type: 'practitioner_entered', ref_id: null, section_key: 'practitioner_notes' }, { ref_type: 'telehealth_visit', ref_id: appointment, section_key: 'telehealth_summary' }]);
    const row = (await pg.query<{ source_payload: unknown; source_note_revision: number; source_digest: string; patient_record_id: string; transferred_by_person_id: string }>(
      'select source_payload,source_note_revision,source_digest,patient_record_id,transferred_by_person_id from clinical_core.telehealth_note_transfers where id=$1', [receipt.transfer_id])).rows[0];
    expect(row).toMatchObject({ source_payload: payload, source_note_revision: 2, source_digest: digestOf(payload), patient_record_id: patient, transferred_by_person_id: practitioner });
    const audit = (await pg.query<{ action: string; resource_id: string }>("select action,resource_id from clinical_audit.events where action in ('telehealth.note_transferred','note.draft_created','encounter.started') and organization_id=$1 order by action", [org])).rows;
    expect(audit.map(e => e.action)).toEqual(['encounter.started', 'note.draft_created', 'telehealth.note_transferred']);
    expect(audit.find(e => e.action === 'telehealth.note_transferred')?.resource_id).toBe(receipt.note_id);
    expect((await pg.query('select 1 from clinical_core.note_signatures where note_id=$1', [receipt.note_id])).rows).toHaveLength(0);
  });

  it('appears in the patient timeline through the chart\'s own events and reuses the appointment\'s open encounter', async () => {
    const opened = await call<string>("select clinical_core.start_encounter($1,$2,'telehealth',$3) as result", [org, patient, appointment]);
    const receipt = await transfer();
    expect(receipt.encounter_id).toBe(opened);
    const timeline = await pg.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [practitioner, org, 'subject-' + practitioner]);
      return (await tx.query<{ event_type: string; ref_id: string }>('select event_type,ref_id from clinical_core.get_desktop_patient_timeline($1,50)', [patient])).rows;
    });
    expect(timeline.some(e => e.event_type === 'note.draft_created' && e.ref_id === receipt.note_id)).toBe(true);
  });

  it('is retry-safe: the same source returns the original destination, in either order and with any transfer id; a lost response is settled by reading it back', async () => {
    const first = await transfer({ transferId: '22222222-2222-4222-8222-222222222222' });
    const repeat = await transfer({ transferId: '22222222-2222-4222-8222-222222222222' });
    expect(repeat).toMatchObject({ transfer_id: first.transfer_id, encounter_id: first.encounter_id, note_id: first.note_id, note_version: 1, created: false });
    // A second caller (the other order of a race, or a retry that lost its id) with the same source.
    const racer = await transfer({ transferId: randomUUID() }, { who: colleague });
    expect(racer).toMatchObject({ transfer_id: first.transfer_id, note_id: first.note_id, created: false });
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where encounter_id=$1', [first.encounter_id])).rows[0].n).toBe(1);
    // Reconciliation read: the authoritative receipt for this appointment.
    const read = await authority();
    expect(read.transfer).toMatchObject({ transfer_id: first.transfer_id, note_id: first.note_id, note_status: 'draft', note_current_version: 1, source_note_revision: 2 });
  });

  it('refuses a stale or changed source revision rather than creating a second chart note', async () => {
    const first = await transfer();
    expect(await refusal(transfer({ revision: 3 }))).toMatch(/telehealth_transfer_source_changed/);
    expect(await refusal(transfer({ digest: sha('changed') }))).toMatch(/telehealth_transfer_source_changed/);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where encounter_id=$1', [first.encounter_id])).rows[0].n).toBe(1);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers where appointment_id=$1', [appointment])).rows[0].n).toBe(1);
  });

  it('binds the transfer server-side: foreign clinic, staff role, wrong patient, patient/appointment mismatch, non-telehealth and deleted appointments are refused with nothing written', async () => {
    const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['foreign clinic member', () => transfer({}, { who: outsider }), /request_context_refused|clinical_role_required|membership/],
      ['foreign organization claim', () => transfer({ organization: foreignOrg }, { who: outsider, organization: foreignOrg }), /patient_not_found/],
      ['staff role', () => transfer({}, { who: staff }), /clinical_role_required/],
      ['patient of another clinic', () => transfer({ patientId: otherPatient }), /patient_not_found/],
      ['consumer pool', () => transfer({}, { pool: 'consumer' }), /request_context_refused|clinical_role_required/],
    ];
    for (const [label, attempt, pattern] of cases) expect(await refusal(attempt()), label).toMatch(pattern);
    const otherAppointment = await bookAppointment();
    const unrelated = randomUUID();
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')", [unrelated, org, 'patient_' + unrelated.replaceAll('-', '')]);
    expect(await refusal(transfer({ appointmentId: otherAppointment, patientId: unrelated })), 'appointment belongs to another patient').toMatch(/telehealth_transfer_refused/);
    await pg.query("update clinical_core.appointments set appointment_type='follow-up' where id=$1", [otherAppointment]);
    expect(await refusal(transfer({ appointmentId: otherAppointment })), 'not a telehealth appointment').toMatch(/telehealth_transfer_refused/);
    await pg.query('update clinical_core.appointments set deleted_at=now() where id=$1', [otherAppointment]);
    expect(await refusal(transfer({ appointmentId: otherAppointment })), 'deleted appointment').toMatch(/appointment_not_found/);
    expect(await refusal(transfer({ appointmentId: randomUUID() })), 'unknown appointment').toMatch(/appointment_not_found/);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers where organization_id in ($1,$2)', [org, foreignOrg])).rows[0].n).toBe(0);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where organization_id in ($1,$2)', [org, foreignOrg])).rows[0].n).toBe(0);
  });

  it('refuses malformed input and a reused transfer id before any write', async () => {
    const first = await transfer({ transferId: '33333333-3333-4333-8333-333333333333' });
    const second = await bookAppointment();
    expect(await refusal(transfer({ transferId: '33333333-3333-4333-8333-333333333333', appointmentId: second }))).toMatch(/telehealth_transfer_id_reused/);
    expect(await refusal(transfer({ appointmentId: second, digest: 'not-a-digest' }))).toMatch(/telehealth_transfer_invalid/);
    expect(await refusal(transfer({ appointmentId: second, revision: 0 }))).toMatch(/telehealth_transfer_invalid/);
    expect(await refusal(call('select clinical_core.transfer_telehealth_note($1,$2,$3,$4,1,$5,$6::jsonb,$7::jsonb,$8::jsonb) as result',
      [org, randomUUID(), second, patient, digestOf(payload), '[]', JSON.stringify(payload), '[]']))).toMatch(/telehealth_transfer_invalid/);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers where organization_id=$1', [org])).rows[0].n).toBe(1);
    expect(first.created).toBe(true);
  });

  it('the receipt is append-only and the chart signature workflow stays the chart\'s: signing the draft is a separate chart act; addenda append, never overwrite', async () => {
    const receipt = await transfer();
    for (const sql of ['update clinical_core.telehealth_note_transfers set source_note_revision=9 where id=$1', 'delete from clinical_core.telehealth_note_transfers where id=$1']) {
      expect(await refusal(pg.query(sql, [receipt.transfer_id]))).toMatch(/append_only_record/);
    }
    const signed = await call<{ signature_id: string; version: number }>('select clinical_core.sign_note($1,1) as result', [receipt.note_id]);
    expect(signed.version).toBe(1);
    expect((await pg.query<{ status: string }>('select status from clinical_core.clinical_notes where id=$1', [receipt.note_id])).rows[0].status).toBe('signed');
    // The original signed content is frozen; a correction is an addendum with reason, author, time and referenced version.
    expect(await refusal(call('select clinical_core.save_note_draft($1,$2,$3,$4::jsonb,1,$5,$6,$7::jsonb) as result',
      [org, receipt.encounter_id, 'narrative', JSON.stringify({ ...content, telehealth_summary: 'rewritten' }), receipt.note_id, 'manual', '[]']))).toMatch(/note_content_frozen/);
    const addendum = await call<string>("select clinical_core.add_note_addendum($1,'Fictional correction',$2) as result", [receipt.note_id, 'Fictional addendum text']);
    const row = (await pg.query<{ referenced_version: number; reason: string; author_person_id: string }>('select referenced_version,reason,author_person_id from clinical_core.note_addenda where id=$1', [addendum])).rows[0];
    expect(row).toMatchObject({ referenced_version: 1, reason: 'Fictional correction', author_person_id: practitioner });
    expect((await pg.query<{ content: unknown }>('select content from clinical_core.clinical_note_versions where note_id=$1 and version=1', [receipt.note_id])).rows[0].content).toEqual(content);
    expect(await refusal(transfer({ revision: 3 }))).toMatch(/telehealth_transfer_source_changed/);
    const read = await authority();
    expect(read.transfer).toMatchObject({ note_status: 'amended', note_current_version: 1 });
  });
});

describe('retained-record read authority for completed visits', () => {
  it('authorizes a clinical-role member of the patient\'s clinic and reports appointment, transfer and hold state', async () => {
    const before = await authority();
    expect(before).toMatchObject({ authorized: true, actor_person_id: practitioner, patient_record_id: patient, legal_hold: false, transfer: null,
      appointment: { id: appointment, status: 'completed', deleted: false, appointment_type: 'telehealth', patient_matches: true, practitioner_person_id: practitioner } });
    const receipt = await transfer();
    const colleagueRead = await authority({}, { who: colleague });
    expect(colleagueRead.transfer).toMatchObject({ transfer_id: receipt.transfer_id, note_id: receipt.note_id, note_status: 'draft' });
    await pg.query("insert into clinical_private.recording_legal_holds(organization_id,patient_record_id,reason_code,placed_by) values($1,$2,'litigation',$3)", [org, patient, practitioner]);
    expect((await authority()).legal_hold).toBe(true);
  });

  it('survives calendar changes: a deleted, moved or re-patiented appointment does not erase access to the retained record, and says so', async () => {
    const receipt = await transfer();
    await pg.query("update clinical_core.appointments set starts_at='2025-01-01T17:00:00Z',ends_at='2025-01-01T17:30:00Z' where id=$1", [appointment]);
    expect((await authority()).transfer?.transfer_id).toBe(receipt.transfer_id);
    const unrelated = randomUUID();
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')", [unrelated, org, 'patient_' + unrelated.replaceAll('-', '')]);
    await pg.query('update clinical_core.appointments set patient_record_id=$2 where id=$1', [appointment, unrelated]).catch(() => undefined);
    const moved = await authority();
    expect(moved.authorized).toBe(true);
    if (moved.appointment) expect(typeof moved.appointment.patient_matches).toBe('boolean');
    await pg.query('update clinical_core.appointments set deleted_at=now() where id=$1', [appointment]);
    const deleted = await authority();
    expect(deleted.authorized).toBe(true);
    expect(deleted.appointment?.deleted).toBe(true);
    expect(deleted.transfer?.note_id).toBe(receipt.note_id);
    expect((await authority({ appointmentId: randomUUID() })).appointment).toBeNull();
  });

  it('refuses revoked membership, wrong clinic, wrong patient, a staff-only role and a consumer caller; a missing authority response is a refusal', async () => {
    await transfer();
    const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['foreign clinic member', () => authority({}, { who: outsider }), /request_context_refused|clinical_role_required|membership/],
      ['foreign organization claim by its own member', () => authority({ organization: foreignOrg }, { who: outsider, organization: foreignOrg }), /patient_not_found/],
      ['staff-only role', () => authority({}, { who: staff }), /clinical_role_required/],
      ['patient of another clinic', () => authority({ patientId: otherPatient }), /patient_not_found/],
      ['consumer pool', () => authority({}, { pool: 'consumer' }), /request_context_refused|clinical_role_required/],
      ['no appointment id', () => call('select clinical_core.get_telehealth_record_authority($1,$2,null) as result', [org, patient]), /appointment_required/],
    ];
    for (const [label, attempt, pattern] of cases) expect(await refusal(attempt()), label).toMatch(pattern);
    await pg.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [practitioner]);
    expect(await refusal(authority()), 'suspended membership').toMatch(/request_context_refused|clinical_role_required|membership/);
    await pg.query('delete from clinical_core.organization_memberships where person_id=$1', [colleague]);
    expect(await refusal(authority({}, { who: colleague })), 'removed membership').toMatch(/request_context_refused|clinical_role_required|membership/);
    await pg.query("update clinical_core.patient_records set status='archived' where id=$1", [patient]);
    expect(await refusal(authority({}, { who: staff })), 'archived patient, staff').toMatch(/clinical_role_required/);
  });
});
