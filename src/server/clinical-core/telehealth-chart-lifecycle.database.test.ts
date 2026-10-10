import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { createAwsProductionDesktopAdapter, ProductionDesktopError, type ProductionRequestContext } from './aws-production-desktop';
import { classifyDatabaseRejection } from './rds-data-database';
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
let pg: PGlite, artifact: Artifact, admin: ClinicalCoreDatabase;
let org: string, foreignOrg: string, practitioner: string, colleague: string, staff: string, outsider: string, admin_: string, patient: string, otherPatient: string, appointment: string;
/** A fictional admission key, registered with a privileged connection exactly as an operator would — never through any API role. */
const ADMISSION_KEY = { keyId: 'fictional-admission-key-1', secret: Buffer.from('ab'.repeat(32), 'hex') };
const RETIRED_KEY = { keyId: 'fictional-admission-key-0', secret: Buffer.from('cd'.repeat(32), 'hex') };

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
/** Deterministic JSON (sorted keys): what the telehealth boundary signs and sends, byte for byte. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
type TransferArgs = { organization: string; transferId: string; appointmentId: string; patientId: string; revision: number; digest: string;
  content: unknown; payload: unknown; provenance: unknown; practitioner: string; key: { keyId: string; secret: Buffer };
  issuedAt: string; expiresAt: string; admissionOverrides: Record<string, unknown> };
/**
 * What the telehealth boundary does after it has verified the signed visit
 * record and the caller's retained-record authority: hash the exact bytes it
 * will send and sign the admission under its key. The test is the boundary.
 */
function admit(args: TransferArgs) {
  const contentText = canonicalJson(args.content), payloadText = canonicalJson(args.payload), provenanceText = canonicalJson(args.provenance);
  const admission = canonicalJson({
    contract: 'telehealth-chart-admission/1', intent: 'chart_draft', key_id: args.key.keyId, transfer_id: args.transferId,
    organization_id: args.organization, patient_record_id: args.patientId, appointment_id: args.appointmentId, practitioner_person_id: args.practitioner,
    source_custody: 'telehealth-visit-record', source_record_version: 6, source_revision: args.revision, source_digest: args.digest,
    content_sha256: sha(contentText), payload_sha256: sha(payloadText), provenance_sha256: sha(provenanceText),
    issued_at: args.issuedAt, expires_at: args.expiresAt, ...args.admissionOverrides,
  });
  const signature = createHmac('sha256', args.key.secret).update(admission, 'utf8').digest('hex');
  return { contentText, payloadText, provenanceText, admission, signature };
}
function transferArgs(overrides: Partial<TransferArgs> = {}): TransferArgs {
  const now = Date.now();
  const appointmentId = overrides.appointmentId ?? appointment;
  return { organization: org, transferId: randomUUID(), appointmentId, patientId: patient, revision: 2, digest: digestOf(payload),
    content, payload, provenance: provenance(appointmentId), practitioner, key: ADMISSION_KEY,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(), admissionOverrides: {}, ...overrides };
}
const TRANSFER_SQL = 'select clinical_core.transfer_telehealth_note($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result';
const transfer = (overrides: Partial<TransferArgs> = {}, caller: Caller = {}, signature?: string) => {
  const args = transferArgs(overrides); const signed = admit(args);
  return call<Transfer>(TRANSFER_SQL, [args.organization, args.transferId, args.appointmentId, args.patientId, args.revision, args.digest,
    signed.contentText, signed.payloadText, signed.provenanceText, signed.admission, signature ?? signed.signature], caller);
};
/** The same call with the admission minted for one set of values and the SQL arguments carrying another (a substitution). */
const substituted = (admitted: Partial<TransferArgs>, sent: Partial<TransferArgs & { contentText: string; payloadText: string; provenanceText: string }>, caller: Caller = {}) => {
  const args = transferArgs(admitted); const signed = admit(args); const s = { ...args, ...sent };
  return call<Transfer>(TRANSFER_SQL, [s.organization, s.transferId, s.appointmentId, s.patientId, s.revision, s.digest,
    sent.contentText ?? signed.contentText, sent.payloadText ?? signed.payloadText, sent.provenanceText ?? signed.provenanceText, signed.admission, signed.signature], caller);
};
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
  admin = { transaction: work => pg.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  // Forward source rehearsal only: 107..113 are fictional in-memory ledger rows, not a reviewed preserving upgrade.
  for (const entry of migrations.slice(106)) {
    try { await pg.exec(entry.sql); }
    catch (cause) { throw new Error(entry.name + ': ' + (cause instanceof Error ? cause.message : 'failed')); }
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers')).rows[0].n).toBe(0);
  // The artifact seeds no key: before an operator registers one, every transfer is unavailable (proven below), then the fictional keys are registered.
  expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_private.telehealth_admission_keys')).rows[0].n).toBe(0);
}, 120000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  [org, foreignOrg, practitioner, colleague, staff, outsider, admin_, patient, otherPatient] = Array.from({ length: 9 }, () => randomUUID());
  for (const id of [org, foreignOrg]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const [id, role, organization] of [[practitioner, 'practitioner', org], [colleague, 'practitioner', org], [staff, 'staff', org], [outsider, 'practitioner', foreignOrg], [admin_, 'admin', org]] as const) {
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [id, 'subject-' + id]);
    await pg.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [organization, id, role]);
  }
  for (const [id, organization] of [[patient, org], [otherPatient, foreignOrg]] as const) {
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')", [id, organization, 'patient_' + id.replaceAll('-', '')]);
  }
  appointment = await bookAppointment();
  if ((await pg.query<{ n: number }>('select count(*)::int n from clinical_private.telehealth_admission_keys')).rows[0].n === 0) {
    expect(await refusal(transfer())).toMatch(/telehealth_admission_unavailable/);
    for (const key of [RETIRED_KEY, ADMISSION_KEY]) await pg.query('insert into clinical_private.telehealth_admission_keys(key_id,secret) values($1,$2)', [key.keyId, key.secret]);
    await pg.query('update clinical_private.telehealth_admission_keys set retired_at=now() where key_id=$1', [RETIRED_KEY.keyId]);
  }
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
    const row = (await pg.query<{ source_payload: unknown; source_note_revision: number; source_digest: string; patient_record_id: string; transferred_by_person_id: string; admission_key_id: string; admission: Record<string, unknown>; admission_sha256: string }>(
      'select source_payload,source_note_revision,source_digest,patient_record_id,transferred_by_person_id,admission_key_id,admission,admission_sha256 from clinical_core.telehealth_note_transfers where id=$1', [receipt.transfer_id])).rows[0];
    expect(row).toMatchObject({ source_payload: payload, source_note_revision: 2, source_digest: digestOf(payload), patient_record_id: patient, transferred_by_person_id: practitioner, admission_key_id: ADMISSION_KEY.keyId });
    expect(row.admission).toMatchObject({ contract: 'telehealth-chart-admission/1', intent: 'chart_draft', transfer_id: receipt.transfer_id, practitioner_person_id: practitioner, content_sha256: sha(canonicalJson(content)) });
    expect(row.admission_sha256).toMatch(/^[0-9a-f]{64}$/);
    const audit = (await pg.query<{ action: string; resource_id: string }>("select action,resource_id from clinical_audit.events where action in ('telehealth.note_transferred','note.draft_created','encounter.started') and organization_id=$1 order by action", [org])).rows;
    expect(audit.map(e => e.action)).toEqual(['encounter.started', 'note.draft_created', 'telehealth.note_transferred']);
    expect(audit.find(e => e.action === 'telehealth.note_transferred')?.resource_id).toBe(receipt.note_id);
    expect((await pg.query<{ m: Record<string, unknown> }>("select safe_metadata m from clinical_audit.events where action='telehealth.note_transferred' and organization_id=$1", [org])).rows[0].m).toMatchObject({ admission_key_id: ADMISSION_KEY.keyId });
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
    const racer = await transfer({ transferId: randomUUID(), practitioner: colleague }, { who: colleague });
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
      ['foreign clinic member', () => transfer({ practitioner: outsider }, { who: outsider }), /request_context_refused|clinical_role_required|membership/],
      ['foreign organization claim', () => transfer({ organization: foreignOrg, practitioner: outsider }, { who: outsider, organization: foreignOrg }), /patient_not_found/],
      ['staff role', () => transfer({ practitioner: staff }, { who: staff }), /clinical_role_required/],
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
    expect(await refusal(transfer({ appointmentId: second, content: [] })), 'content not an object').toMatch(/telehealth_transfer_invalid/);
    expect(await refusal(transfer({ appointmentId: second, provenance: {} })), 'provenance not an array').toMatch(/telehealth_transfer_invalid/);
    expect(await refusal(call(TRANSFER_SQL, [org, randomUUID(), second, patient, 2, digestOf(payload), '{not json', '{}', '[]', '{}', 'f'.repeat(64)])), 'unparseable content').toMatch(/telehealth_transfer_invalid/);
    expect(await refusal(call(TRANSFER_SQL, [org, randomUUID(), second, patient, 2, digestOf(payload), '{}', '{}', '[]', '{"key_id":1}', 'zz'])), 'malformed signature').toMatch(/telehealth_transfer_invalid/);
    expect(await refusal(call(TRANSFER_SQL, [org, randomUUID(), second, patient, 2, digestOf(payload), '{}', '{}', '[]', '{"transfer_id":"not-a-uuid"}', 'f'.repeat(64)])), 'unparseable admission binding').toMatch(/telehealth_transfer_invalid/);
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

  it('survives calendar changes: a rescheduled or deleted appointment does not erase access to the retained record, and says so', async () => {
    const receipt = await transfer();
    await pg.query("update clinical_core.appointments set starts_at='2025-01-01T17:00:00Z',ends_at='2025-01-01T17:30:00Z' where id=$1", [appointment]);
    expect((await authority()).transfer?.transfer_id).toBe(receipt.transfer_id);
    await pg.query('update clinical_core.appointments set deleted_at=now() where id=$1', [appointment]);
    const deleted = await authority();
    expect(deleted.authorized).toBe(true);
    expect(deleted.appointment?.deleted).toBe(true);
    expect(deleted.transfer?.note_id).toBe(receipt.note_id);
    expect((await authority({ appointmentId: randomUUID() })).appointment).toBeNull();
  });

  it('Codex A2: never returns another same-clinic patient\'s transfer receipt, and describes their appointment only as not this patient\'s', async () => {
    const receipt = await transfer();
    const unrelated = randomUUID();
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')", [unrelated, org, 'patient_' + unrelated.replaceAll('-', '')]);
    const response = await authority({ patientId: unrelated });
    expect(response).toMatchObject({ authorized: true, patient_record_id: unrelated, transfer: null });
    expect(response.appointment).toEqual({ id: appointment, patient_matches: false });
    expect(JSON.stringify(response)).not.toContain(receipt.note_id);
    expect(JSON.stringify(response)).not.toContain(receipt.transfer_id);
    expect(JSON.stringify(response)).not.toContain(receipt.encounter_id);
    // The original patient's read is unchanged.
    expect((await authority()).transfer).toMatchObject({ transfer_id: receipt.transfer_id, note_id: receipt.note_id });
    expect((await authority()).appointment).toMatchObject({ id: appointment, patient_matches: true, status: 'completed' });
  });

  it('Codex A3 — the correction contract: patient identity of an appointment that carries clinical records is immutable; correction is a status correction plus a successor appointment, and the original record stays with its patient', async () => {
    const receipt = await transfer();
    const unrelated = randomUUID();
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')", [unrelated, org, 'patient_' + unrelated.replaceAll('-', '')]);
    // A raw re-patienting of the original appointment is refused by name, with a privileged connection, before any foreign key.
    expect(await refusal(pg.query('update clinical_core.appointments set patient_record_id=$2 where id=$1', [appointment, unrelated]))).toMatch(/appointment_patient_identity_immutable/);
    expect((await pg.query<{ p: string }>('select patient_record_id p from clinical_core.appointments where id=$1', [appointment])).rows[0].p).toBe(patient);
    // An appointment with NO clinical record is not what this guard is about: the foreign keys and the absence of any re-patienting operation govern it; the guard lets it through.
    const bare = await bookAppointment();
    await pg.query('update clinical_core.appointments set patient_record_id=$2 where id=$1', [bare, unrelated]);
    // No governed operation re-patients: the scheduling corrections change status (admin, with reason, audited) and never the patient.
    const corrected = await call<{ ok: boolean; status: string }>("select clinical_core.correct_appointment_status($1,'cancelled','Fictional: booked under the wrong patient',null) as result", [appointment], { who: admin_ });
    expect(corrected).toMatchObject({ ok: true, status: 'cancelled' });
    expect(await refusal(call("select clinical_core.correct_appointment_status($1,'cancelled','Fictional',null) as result", [bare], { who: practitioner }))).toMatch(/organization_admin_required|correction_refused/);
    const successor = await bookAppointment(unrelated);
    // The original record stays with the patient it was recorded for, under the corrected appointment.
    const original = await authority();
    expect(original.transfer).toMatchObject({ transfer_id: receipt.transfer_id, note_id: receipt.note_id, note_status: 'draft' });
    expect(original.appointment).toMatchObject({ id: appointment, status: 'cancelled', patient_matches: true });
    expect((await pg.query<{ action: string }>("select action from clinical_audit.events where resource_id=$1 and action='appointment.corrected'", [appointment])).rows).toHaveLength(1);
    // The right patient's successor appointment carries no transfer; the original appointment is "not this patient's" for them.
    expect(await authority({ patientId: unrelated, appointmentId: successor })).toMatchObject({ transfer: null, appointment: { id: successor, patient_matches: true, status: 'completed' } });
    expect((await authority({ patientId: unrelated })).appointment).toEqual({ id: appointment, patient_matches: false });
    // A transfer to the successor needs its own admitted signed source; the original admission is bound to the original appointment and patient.
    expect(await refusal(substituted({}, { appointmentId: successor, patientId: unrelated }))).toMatch(/telehealth_admission_mismatch/);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers where organization_id=$1', [org])).rows[0].n).toBe(1);
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

describe('Codex A1: source admission at the chart write boundary', () => {
  const noWrites = async () => {
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers where organization_id=$1', [org])).rows[0].n).toBe(0);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where organization_id=$1', [org])).rows[0].n).toBe(0);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.encounters where organization_id=$1', [org])).rows[0].n).toBe(0);
  };

  it('refuses forged source/signature claims with no admitted signed visit: no admission, a self-made admission, a retired or unknown key', async () => {
    const forged = { text: 'FABRICATED signed telehealth source' };
    const forgedPayload = { signedAt: '2026-10-10T00:00:00Z', signedBy: colleague, aiOriginal: 'Fabricated provider summary' };
    const forgedProvenance = [{ sectionKey: 'text', refType: 'telehealth_visit', refId: appointment, label: 'Fabricated signed source' }];
    // The audit's reproduction: valid workforce context, completed calendar appointment, fabricated revision 99, digest, payload and provenance — and no admission.
    expect(await refusal(call(TRANSFER_SQL, [org, randomUUID(), appointment, patient, 99, sha('unverified source claim'),
      JSON.stringify(forged), JSON.stringify(forgedPayload), JSON.stringify(forgedProvenance), '{}', 'f'.repeat(64)]))).toMatch(/telehealth_admission_refused|telehealth_transfer_invalid/);
    // The same claim under an admission the caller wrote and signed with a key of its own.
    expect(await refusal(transfer({ content: forged, payload: forgedPayload, provenance: forgedProvenance, revision: 99, digest: sha('unverified source claim'), key: { keyId: ADMISSION_KEY.keyId, secret: Buffer.from('99'.repeat(32), 'hex') } }))).toMatch(/telehealth_admission_refused/);
    // A key id this database never registered, and a retired key.
    expect(await refusal(transfer({ key: { keyId: 'fictional-unknown-key', secret: ADMISSION_KEY.secret } }))).toMatch(/telehealth_admission_refused/);
    expect(await refusal(transfer({ key: RETIRED_KEY }))).toMatch(/telehealth_admission_refused/);
    // A correctly signed admission whose signature is then tampered.
    const args = transferArgs(); const signed = admit(args);
    expect(await refusal(call(TRANSFER_SQL, [org, args.transferId, appointment, patient, 2, args.digest, signed.contentText, signed.payloadText, signed.provenanceText, signed.admission, signed.signature.replace(/^./, (c) => c === '0' ? '1' : '0')]))).toMatch(/telehealth_admission_refused/);
    expect(await refusal(call(TRANSFER_SQL, [org, args.transferId, appointment, patient, 2, args.digest, signed.contentText, signed.payloadText, signed.provenanceText, signed.admission.replace('chart_draft', 'chart_draft '), signed.signature]))).toMatch(/telehealth_admission_refused|telehealth_transfer_invalid/);
    await noWrites();
  });

  it('refuses substituted text under the same digest claim, a substituted signer/provenance, another clinic/patient/appointment, another practitioner and a reused intent', async () => {
    const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['substituted content bytes (admission for the real content)', () => substituted({}, { contentText: canonicalJson({ text: 'SUBSTITUTED after admission' }) }), /telehealth_admission_mismatch/],
      ['substituted payload (another signer claimed)', () => substituted({}, { payloadText: canonicalJson({ ...payload, signedBy: colleague, signedAt: '2026-10-10T00:00:00Z' }) }), /telehealth_admission_mismatch/],
      ['substituted provenance', () => substituted({}, { provenanceText: canonicalJson([{ sectionKey: 'text', refType: 'telehealth_visit', refId: appointment, label: 'Fabricated' }]) }), /telehealth_admission_mismatch/],
      ['substituted source revision', () => substituted({}, { revision: 3 }), /telehealth_admission_mismatch/],
      ['substituted source digest', () => substituted({}, { digest: sha('other source') }), /telehealth_admission_mismatch/],
      ['substituted transfer id', () => substituted({}, { transferId: randomUUID() }), /telehealth_admission_mismatch/],
      ['admission for another practitioner', () => transfer({ practitioner: colleague }), /telehealth_admission_mismatch/],
      ['presented by another practitioner', () => transfer({}, { who: colleague }), /telehealth_admission_mismatch/],
      ['admission naming another patient', () => transfer({ admissionOverrides: { patient_record_id: otherPatient } }), /telehealth_admission_mismatch/],
      ['admission naming another clinic', () => transfer({ admissionOverrides: { organization_id: foreignOrg } }), /telehealth_admission_mismatch/],
      ['admission for another intent', () => transfer({ admissionOverrides: { intent: 'chart_signed' } }), /telehealth_admission_mismatch/],
      ['admission under another contract', () => transfer({ admissionOverrides: { contract: 'telehealth-chart-admission/0' } }), /telehealth_admission_mismatch/],
      ['admission from another custody', () => transfer({ admissionOverrides: { source_custody: 'spreadsheet' } }), /telehealth_admission_mismatch/],
      ['admission with an extra member', () => transfer({ admissionOverrides: { signed_by_chart: true } }), /telehealth_admission_mismatch/],
      ['admission with a member missing', () => transfer({ admissionOverrides: { source_record_version: undefined } }), /telehealth_admission_mismatch|telehealth_transfer_invalid/],
    ];
    for (const [label, attempt, pattern] of cases) expect(await refusal(attempt()), label).toMatch(pattern);
    const otherAppointment = await bookAppointment();
    expect(await refusal(substituted({}, { appointmentId: otherAppointment })), 'admission for another appointment').toMatch(/telehealth_admission_mismatch/);
    // Authority withdrawn between admission and the chart write: the chart re-checks it and refuses, whatever the admission says.
    const minted = transferArgs(); const signed = admit(minted);
    await pg.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [practitioner]);
    expect(await refusal(call(TRANSFER_SQL, [org, minted.transferId, appointment, patient, 2, minted.digest, signed.contentText, signed.payloadText, signed.provenanceText, signed.admission, signed.signature])), 'withdrawn authority').toMatch(/request_context_refused|clinical_role_required|membership/);
    await pg.query("update clinical_core.patient_records set status='archived' where id=$1", [patient]);
    expect(await refusal(transfer({ practitioner: colleague }, { who: colleague })), 'archived patient').toMatch(/patient_not_found|clinical_role_required/);
    await noWrites();
  });

  it('refuses an expired, not-yet-issued or over-long admission; a valid one within its window is accepted once and its exact retry returns the receipt', async () => {
    const now = Date.now();
    expect(await refusal(transfer({ issuedAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now - 60_000).toISOString() })), 'expired').toMatch(/telehealth_admission_mismatch/);
    expect(await refusal(transfer({ issuedAt: new Date(now + 3_600_000).toISOString(), expiresAt: new Date(now + 7_200_000).toISOString() })), 'issued in the future').toMatch(/telehealth_admission_mismatch/);
    expect(await refusal(transfer({ issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 2 * 3_600_000).toISOString() })), 'window over one hour').toMatch(/telehealth_admission_mismatch/);
    await noWrites();
    const args = transferArgs(); const signed = admit(args);
    const params = [org, args.transferId, appointment, patient, 2, args.digest, signed.contentText, signed.payloadText, signed.provenanceText, signed.admission, signed.signature];
    const first = await call<Transfer>(TRANSFER_SQL, params);
    expect(first.created).toBe(true);
    // The exact same admitted bytes again (a lost response): the original receipt, nothing written.
    expect(await call<Transfer>(TRANSFER_SQL, params)).toMatchObject({ transfer_id: first.transfer_id, note_id: first.note_id, created: false });
    // A fresh admission for the same source (the boundary re-issues on retry): the original receipt.
    expect(await transfer({ transferId: args.transferId })).toMatchObject({ transfer_id: first.transfer_id, created: false });
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where organization_id=$1', [org])).rows[0].n).toBe(1);
    // Retiring the key afterwards revokes every admission under it (a replacement key is registered first, as a rotation would); the receipt it produced stands.
    const retired = { ...ADMISSION_KEY };
    ADMISSION_KEY.keyId = 'fictional-admission-key-' + Date.now().toString(36);
    await pg.query('insert into clinical_private.telehealth_admission_keys(key_id,secret) values($1,$2)', [ADMISSION_KEY.keyId, ADMISSION_KEY.secret]);
    await pg.query('update clinical_private.telehealth_admission_keys set retired_at=now() where key_id=$1', [retired.keyId]);
    expect(await refusal(transfer({ transferId: args.transferId, key: retired }))).toMatch(/telehealth_admission_refused/);
    expect(await transfer({ transferId: args.transferId })).toMatchObject({ transfer_id: first.transfer_id, created: false });
    expect((await authority()).transfer?.transfer_id).toBe(first.transfer_id);
    // A key is never rewritten, deleted or un-retired.
    expect(await refusal(pg.query('update clinical_private.telehealth_admission_keys set secret=$2 where key_id=$1', [retired.keyId, Buffer.alloc(32, 1)]))).toMatch(/append_only_record/);
    expect(await refusal(pg.query('delete from clinical_private.telehealth_admission_keys where key_id=$1', [retired.keyId]))).toMatch(/append_only_record/);
    expect(await refusal(pg.query('update clinical_private.telehealth_admission_keys set retired_at=null where key_id=$1', [retired.keyId]))).toMatch(/append_only_record/);
  });

  it('Codex B1 refuses an admission that expires while current clinical authority is being resolved', async () => {
    await pg.exec(`alter function clinical_private.require_clinical_patient(uuid,uuid) rename to codex_authority_before_delay;
      create function clinical_private.require_clinical_patient(uuid,uuid) returns uuid
      language plpgsql security definer set search_path='' as $$
      declare actor uuid;
      begin
        actor:=clinical_private.codex_authority_before_delay($1,$2);
        perform pg_catalog.pg_sleep(0.25);
        return actor;
      end $$;`);
    try {
      const start = (await pg.query<{ at: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`)).rows[0].at;
      const issuedAt = new Date(Date.parse(start) - 1000).toISOString();
      const expiresAt = new Date(Date.parse(start) + 100).toISOString();
      await expect(transfer({ issuedAt, expiresAt })).rejects.toThrow('telehealth_admission_mismatch');
      await noWrites();
    } finally {
      await pg.exec(`drop function clinical_private.require_clinical_patient(uuid,uuid);
        alter function clinical_private.codex_authority_before_delay(uuid,uuid) rename to require_clinical_patient;`);
    }
  });

  it('refuses an admission that expires between the admission check and the mutation (a slow destination), with nothing written', async () => {
    // The destination path (start_encounter) is delayed past the admission's expiry; the second clock read at the mutation point must refuse.
    await pg.exec(`alter function clinical_core.start_encounter(uuid,uuid,text,uuid) rename to codex_start_before_delay;
      create function clinical_core.start_encounter(_organization_id uuid,_patient_id uuid,_visit_type text,_appointment_id uuid) returns uuid
      language plpgsql security definer set search_path='' as $$
      declare id uuid;
      begin
        perform pg_catalog.pg_sleep(0.25);
        id:=clinical_core.codex_start_before_delay(_organization_id,_patient_id,_visit_type,_appointment_id);
        return id;
      end $$;`);
    try {
      const start = (await pg.query<{ at: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`)).rows[0].at;
      await expect(transfer({ issuedAt: new Date(Date.parse(start) - 1000).toISOString(), expiresAt: new Date(Date.parse(start) + 150).toISOString() })).rejects.toThrow('telehealth_admission_mismatch');
      await noWrites();
    } finally {
      await pg.exec(`drop function clinical_core.start_encounter(uuid,uuid,text,uuid);
        alter function clinical_core.codex_start_before_delay(uuid,uuid,text,uuid) rename to start_encounter;`);
    }
  });

  it('the key table is reachable by no API role, and a transfer without any registered key is unavailable, not refused as forged', async () => {
    for (const sql of ['select key_id from clinical_private.telehealth_admission_keys', "insert into clinical_private.telehealth_admission_keys(key_id,secret) values('fictional-api-key-1',decode('00','hex'))"]) {
      expect(await refusal(call(sql))).toMatch(/permission denied/);
    }
  });
});

describe('the authenticated desktop dispatch (aws-production-desktop) in front of the same SQL', () => {
  const context = (who = practitioner): ProductionRequestContext => ({ actorPersonId: who, organizationId: org, identityPool: 'workforce', identitySubject: 'subject-' + who,
    purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true });
  // The production connection IS the restricted API role; the dispatcher only sets the request context.
  // The production connection IS the restricted API role, and the production database wrapper classifies authored refusals (and nothing else) as rejections.
  const api: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => { await tx.exec('set local role clinical_core_api'); return work({ query: async (sql, parameters = []) => {
    // Typed uuid parameters are unwrapped exactly as the RDS Data wrapper encodes them.
    const values = parameters.map((value) => value && typeof value === 'object' && (value as { kind?: string }).kind === 'uuid' ? (value as { value: string }).value : value);
    try { return await tx.query(sql, values); }
    catch (error) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error; }
  } }); }) };
  const dispatch = (args: Record<string, unknown>, who = practitioner) => createAwsProductionDesktopAdapter(api).execute(context(who), { kind: 'rpc', functionName: 'transfer_telehealth_note', args });
  const rpcArgs = (overrides: Partial<TransferArgs> = {}, sent: Record<string, unknown> = {}) => {
    const args = transferArgs(overrides); const signed = admit(args);
    return { _organization_id: args.organization, _transfer_id: args.transferId, _appointment_id: args.appointmentId, _patient_id: args.patientId, _source_revision: args.revision, _source_digest: args.digest,
      _content: signed.contentText, _source_payload: signed.payloadText, _provenance: signed.provenanceText, _admission: signed.admission, _admission_signature: signed.signature, ...sent };
  };
  const category = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error instanceof ProductionDesktopError ? error.category : String(error); } return 'no_error'; };

  it('passes the exact admitted bytes through and creates the draft; the receipt reads back patient-bound', async () => {
    const receipt = await dispatch(rpcArgs()) as Transfer;
    expect(receipt).toMatchObject({ created: true, note_version: 1 });
    const read = await createAwsProductionDesktopAdapter(api).execute(context(), { kind: 'rpc', functionName: 'get_telehealth_record_authority', args: { _organization_id: org, _patient_id: patient, _appointment_id: appointment } }) as Authority;
    expect(read.transfer).toMatchObject({ transfer_id: receipt.transfer_id, note_id: receipt.note_id, note_status: 'draft' });
    const unrelated = randomUUID();
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')", [unrelated, org, 'patient_' + unrelated.replaceAll('-', '')]);
    const other = await createAwsProductionDesktopAdapter(api).execute(context(), { kind: 'rpc', functionName: 'get_telehealth_record_authority', args: { _organization_id: org, _patient_id: unrelated, _appointment_id: appointment } }) as Authority;
    expect(other.transfer).toBeNull();
    expect(other.appointment).toEqual({ id: appointment, patient_matches: false });
  });

  it('refuses, through the dispatcher, a missing admission, a forged one, substituted bytes, another practitioner and a foreign organization claim — and shapes before the database', async () => {
    expect(await category(dispatch(rpcArgs({}, { _admission: undefined, _admission_signature: undefined })))).toBe('request_invalid');
    expect(await category(dispatch(rpcArgs({}, { _admission: '{}', _admission_signature: 'f'.repeat(64) })))).toBe('request_invalid');
    expect(await category(dispatch(rpcArgs({ key: { keyId: ADMISSION_KEY.keyId, secret: Buffer.alloc(32, 7) } })))).toBe('operation_refused');
    expect(await category(dispatch(rpcArgs({}, { _content: canonicalJson({ text: 'SUBSTITUTED' }) })))).toBe('operation_refused');
    expect(await category(dispatch(rpcArgs({}, { _content: '{not json' })))).toBe('request_invalid');
    expect(await category(dispatch(rpcArgs({ practitioner: colleague })))).toBe('operation_refused');
    expect(await category(dispatch(rpcArgs(), colleague))).toBe('operation_refused');
    expect(await category(dispatch(rpcArgs({}, { _organization_id: foreignOrg })))).toBe('request_invalid');
    expect(await category(dispatch(rpcArgs({ practitioner: staff }), staff))).toBe('operation_refused');
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.telehealth_note_transfers where organization_id=$1', [org])).rows[0].n).toBe(0);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinical_notes where organization_id=$1', [org])).rows[0].n).toBe(0);
  });
});
