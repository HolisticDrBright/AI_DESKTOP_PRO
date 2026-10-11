import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import { createProductionClinicRecordsConsumer, createProductionClinicRecordsWorkforce, ClinicRecordError } from './production-clinic-records';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicRecordConsumerRequest, ClinicRecordWorkforceRequest } from '../../contracts/clinicRecordRequests';

/**
 * The distinct 114-migration clinic-record privacy candidate under the ACTUAL
 * restricted API role in an embedded database, through the production adapters
 * (consumer and workforce) and through raw SQL. Two clinics, two same-clinic
 * patients, consumers, practitioner/staff/admin roles, missing or revoked
 * authority and replaced links. Every identity is fictional and in memory;
 * disclosure releases are clearly fictional review fixtures, never approvals.
 * Embedded Postgres runs one transaction at a time: race orders are proven as
 * both serial orders plus row locks and unique indexes, not as interleaving.
 */
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>; releaseHash: string; candidate: Record<string, unknown> };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let pg: PGlite;
let org: string, otherOrg: string, practitioner: string, colleague: string, staff: string, outsider: string;
let consumer: string, secondConsumer: string, foreignConsumer: string, patient: string, secondPatient: string, foreignPatient: string;
let connection: string;

type Caller = { who?: string; organization?: string; pool?: 'workforce' | 'consumer'; purpose?: string };
function context(caller: Caller = {}): ProductionClinicalRequestContext {
  const { who = practitioner, organization = org, pool = 'workforce', purpose = pool === 'consumer' ? 'consent_management' : 'clinical_data' } = caller;
  return { actorPersonId: who, organizationId: organization, identityPool: pool, identitySubject: 'subject-' + who, purpose: purpose as 'clinical_data',
    environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
}
// The production connection IS the restricted API role; the production wrapper classifies authored refusals as rejections.
const api: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => { await tx.exec('set local role clinical_core_api'); return work({ query: async (sql, parameters = []) => {
  const values = parameters.map((value) => value && typeof value === 'object' && (value as { kind?: string }).kind === 'uuid' ? (value as { value: string }).value : value);
  try { return await tx.query(sql, values); }
  catch (error) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error; }
} }); }) };
const asConsumer = (body: ClinicRecordConsumerRequest, caller: Caller = {}) => createProductionClinicRecordsConsumer(api)(context({ pool: 'consumer', who: consumer, ...caller }), body);
const asWorkforce = (body: ClinicRecordWorkforceRequest, caller: Caller = {}) => createProductionClinicRecordsWorkforce(api)(context({ pool: 'workforce', ...caller }), body);
async function call<T = unknown>(sql: string, args: unknown[] = [], caller: Caller = {}) {
  const { who = practitioner, organization = org, pool = 'workforce', purpose = pool === 'consumer' ? 'consent_management' : 'clinical_data' } = caller;
  return pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", [who, organization, pool, 'subject-' + who, purpose]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result as T;
  });
}
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) {
    if (error instanceof ClinicRecordError) return error.category === 'service_unavailable' ? 'service_unavailable: ' + ((error as { cause?: unknown }).cause instanceof Error ? ((error as { cause?: Error }).cause as Error).message : '') : error.category;
    return error instanceof Error ? error.message : String(error);
  }
  return 'no_error';
};
const count = async (sql: string, args: unknown[] = []) => (await pg.query<{ n: number }>(`select count(*)::int n from ${sql}`, args)).rows[0].n;
/** What the device does with a delivered item (expo/lib/clinicRecords/awsClinicRecords.ts): hash the received text, check its length, only then parse. */
const verifyItem = (it: { payloadText: string; payloadSha256: string; byteLength: number }) => {
  expect(sha(it.payloadText)).toBe(it.payloadSha256); expect(Buffer.byteLength(it.payloadText, 'utf8')).toBe(it.byteLength);
  return JSON.parse(it.payloadText) as Record<string, unknown>;
};
const FIXTURE = 'src/contracts/fixtures/clinic-record-copy-lab-item.json';

async function person(role: 'practitioner' | 'staff' | 'admin' | null, organization: string, pool: 'workforce' | 'consumer' = 'workforce') {
  const id = randomUUID();
  await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
  await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, 'subject-' + id]);
  if (role) await pg.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [organization, id, role]);
  return id;
}
async function patientRecord(organization: string) {
  const id = randomUUID();
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')", [id, organization, 'patient_' + id.replaceAll('-', '')]);
  return id;
}
async function connect(organization: string, patientId: string, consumerId: string, state = 'verified') {
  const id = randomUUID();
  await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,$5,now())", [id, organization, patientId, consumerId, state]);
  return id;
}
/** A signed narrative note for the patient, authored and signed by the practitioner through the chart's own path. */
async function signedNote(patientId: string, text: string, who = practitioner, organization = org) {
  const encounter = await call<string>("select clinical_core.start_encounter($1,$2,'follow-up',null) as result", [organization, patientId], { who, organization });
  const saved = await call<{ note_id: string }>("select clinical_core.save_note_draft($1,$2,'narrative',$3::jsonb,0,null,'manual','[]'::jsonb) as result", [organization, encounter, JSON.stringify({ text })], { who, organization });
  await call('select clinical_core.sign_note($1,1) as result', [saved.note_id], { who, organization });
  return saved.note_id;
}
async function draftNote(patientId: string, text: string) {
  const encounter = await call<string>("select clinical_core.start_encounter($1,$2,'follow-up',null) as result", [org, patientId]);
  return (await call<{ note_id: string }>("select clinical_core.save_note_draft($1,$2,'narrative',$3::jsonb,0,null,'manual','[]'::jsonb) as result", [org, encounter, JSON.stringify({ text })])).note_id;
}
/** A fictional telehealth chart-transfer receipt (the signed visit record), inserted with a privileged connection as the chart would hold it. */
async function telehealthTransfer(patientId: string, summary: string) {
  const appointment = randomUUID();
  await pg.query(`insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,status,starts_at,ends_at,created_by_person_id,updated_by_person_id)
    values($1,$2,$3,$4,'telehealth','completed','2026-10-09T17:00:00Z','2026-10-09T17:30:00Z',$4,$4)`, [appointment, org, patientId, practitioner]);
  const encounter = await call<string>("select clinical_core.start_encounter($1,$2,'telehealth',$3) as result", [org, patientId, appointment]);
  const saved = await call<{ note_id: string }>("select clinical_core.save_note_draft($1,$2,'narrative',$3::jsonb,0,null,'manual','[]'::jsonb) as result", [org, encounter, JSON.stringify({ text: summary })]);
  if (!(await count('clinical_private.telehealth_admission_keys'))) await pg.query("insert into clinical_private.telehealth_admission_keys(key_id,secret) values('fictional-admission-key-1',decode(repeat('ab',32),'hex'))");
  const id = randomUUID(), payload = { aiOriginal: { summary_content: summary }, practitionerNotes: 'Fictional practitioner text', actionItems: [{ text: 'Order ferritin', status: 'approved' }], signedAt: '2026-10-10T00:00:00Z' };
  const admission = JSON.stringify({ contract: 'telehealth-chart-admission/1' });
  await pg.query(`insert into clinical_core.telehealth_note_transfers(id,organization_id,patient_record_id,appointment_id,source_note_revision,source_digest,source_payload,source_payload_sha256,
    encounter_id,note_id,note_version,content_sha256,transferred_by_person_id,admission,admission_sha256,admission_key_id,admitted_at,admission_expires_at)
    values($1,$2,$3,$4,2,$5,$6::jsonb,$7,$8,$9,1,$10,$11,$12::jsonb,$13,'fictional-admission-key-1',now(),now()+interval '15 minutes')`,
    [id, org, patientId, appointment, sha('source'), JSON.stringify(payload), sha(JSON.stringify(payload)), encounter, saved.note_id, sha('content'), practitioner, admission, sha(admission)]);
  return id;
}
async function labObservation(patientId: string, connectionId: string, marker: string, reviewed: boolean) {
  const provider = (await pg.query<{ id: string }>("select id from clinical_core.sync_providers where organization_id=$1 limit 1", [org])).rows[0]?.id
    ?? (await pg.query<{ id: string }>("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'fictional_lab','patient-sync/1','lab-result/1','1','active',$2,now()) returning id", [org, practitioner])).rows[0].id;
  const event = (await pg.query<{ id: string }>(`insert into clinical_core.lab_import_events(organization_id,patient_record_id,connection_id,provider_id,provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,marker_name,value_numeric,unit,collected_at,occurred_at,payload_sha256,state,reviewed_at,reviewed_by_person_id)
    values($1,$2,$3,$4,$5,'panel-1',$6,'1','Iron panel',$6,42,'ng/mL',now(),now(),$7,'accepted',now(),$8) returning id`, [org, patientId, connectionId, provider, 'evt-' + randomUUID(), marker, sha(marker), practitioner])).rows[0].id;
  const id = randomUUID();
  await pg.query(`insert into clinical_core.lab_observations(id,organization_id,patient_record_id,import_event_id,panel_name,marker_name,value_numeric,unit,observed_at,review_status,provenance,reviewed_at,reviewed_by_person_id)
    values($1,$2,$3,$4,'Iron panel',$5,42,'ng/mL',now(),$6,$7::jsonb,$8,$9)`, [id, org, patientId, event, marker, reviewed ? 'accepted' : 'unreviewed', JSON.stringify({ source: 'fictional_lab', importEventId: event }), reviewed ? new Date().toISOString() : null, reviewed ? practitioner : null]);
  return id;
}
async function fictionalRelease(organization = org, sections = ['signed_notes', 'telehealth_visits', 'lab_observations']) {
  const version = 'fictional-review-' + randomUUID().slice(0, 8);
  const id = (await pg.query<{ id: string }>("insert into clinical_private.clinic_disclosure_releases(organization_id,release_version,sections,reviewed_by,review_sha256) values($1,$2,$3,'FICTIONAL REVIEWER (test fixture, not an approval)',$4) returning id",
    [organization, version, sections, sha('fictional ' + version)])).rows[0].id;
  return { id, version };
}
const decision = (requestId: string, expectedRevision: number) => ({ requestId, expectedRevision, decisionId: randomUUID() });

beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })) as Artifact;
  expect(artifact.manifest.migrations).toHaveLength(114);
  expect(artifact.candidate).toMatchObject({ contract: 'clinic-record-privacy-candidate/3', activation: 'blocked', phiAllowed: false, seededDisclosureReleases: false, seededRequests: false });
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(entry => ({ version: entry.version, name: entry.file.slice(15, -4), sql: artifact.files[entry.file], sha256: sha(artifact.files[entry.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  for (const entry of migrations.slice(106)) {
    try { await pg.exec(entry.sql); } catch (cause) { throw new Error(entry.name + ': ' + (cause instanceof Error ? cause.message : 'failed')); }
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  expect(await count('clinical_core.clinic_record_requests')).toBe(0);
  expect(await count('clinical_private.clinic_disclosure_releases')).toBe(0);
}, 120000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  org = randomUUID(); otherOrg = randomUUID();
  for (const id of [org, otherOrg]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  [practitioner, colleague, staff, outsider] = await Promise.all([person('practitioner', org), person('practitioner', org), person('staff', org), person('practitioner', otherOrg)]);
  [consumer, secondConsumer, foreignConsumer] = await Promise.all([person(null, org, 'consumer'), person(null, org, 'consumer'), person(null, otherOrg, 'consumer')]);
  [patient, secondPatient, foreignPatient] = await Promise.all([patientRecord(org), patientRecord(org), patientRecord(otherOrg)]);
  connection = await connect(org, patient, consumer); await connect(org, secondPatient, secondConsumer); await connect(otherOrg, foreignPatient, foreignConsumer);
});

describe('patient copy request → practitioner fulfilment → owner reads the snapshot', () => {
  it('fails closed without a reviewed disclosure release, then fulfils only disclosed records under a fictional release, with an honest manifest', async () => {
    const signed = await signedNote(patient, 'Fictional signed narrative.'); await draftNote(patient, 'Fictional DRAFT never disclosed.');
    const addendum = await call<string>("select clinical_core.add_note_addendum($1,'Fictional reason','Fictional addendum text') as result", [signed]);
    const transfer = await telehealthTransfer(patient, 'Fictional telehealth summary');
    const reviewed = await labObservation(patient, connection, 'Ferritin', true); await labObservation(patient, connection, 'Iron', false);
    const requestId = randomUUID();
    const submitted = await asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes', 'telehealth_visits', 'lab_observations', 'correspondence'] });
    expect(submitted).toMatchObject({ action: 'submit_copy', alreadyApplied: false, request: { requestId, kind: 'copy', status: 'submitted', revision: 1, outcome: null } });
    // Replay with the same bytes: the same row; different bytes under the same id: a conflict; a second open copy request: refused.
    expect(await asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes', 'telehealth_visits', 'lab_observations', 'correspondence'] })).toMatchObject({ alreadyApplied: true, request: { requestId } });
    expect(await refusal(asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes'] }))).toBe('conflict');
    expect(await refusal(asConsumer({ action: 'submit_copy', requestId: randomUUID(), sections: ['signed_notes'] }))).toBe('conflict');
    // The clinic sees it, reviews it (counts only, no text), and cannot fulfil without a release.
    const queue = await asWorkforce({ action: 'queue', limit: 10 });
    expect(queue).toMatchObject({ action: 'queue', requests: [{ requestId, patientRecordId: patient, status: 'submitted' }], next: null });
    const review = await asWorkforce({ action: 'review', requestId });
    expect(review.action === 'review' && review.preview).toEqual([
      { section: 'signed_notes', readable: true, exclusionReason: null, includable: 1, excluded: { unsigned_not_disclosable: 2 } }, // the draft and the telehealth chart draft
      { section: 'telehealth_visits', readable: true, exclusionReason: null, includable: 1, excluded: {} },
      { section: 'lab_observations', readable: true, exclusionReason: null, includable: 1, excluded: { not_reviewed: 1 } },
      { section: 'correspondence', readable: false, exclusionReason: 'available_through_care_message_export', includable: 0, excluded: {} }]);
    expect(review.action === 'review' && review.release).toBeNull();
    expect(JSON.stringify(review)).not.toContain('Fictional signed narrative');
    const began = await asWorkforce({ action: 'begin_review', ...decision(requestId, 1) });
    expect(began).toMatchObject({ request: { status: 'in_review', revision: 2 }, alreadyApplied: false });
    expect(await refusal(asWorkforce({ action: 'fulfill', ...decision(requestId, 2), sections: ['signed_notes', 'telehealth_visits', 'lab_observations'] }))).toBe('disclosure_release_required');
    expect(await count('clinical_core.clinic_record_copies where organization_id=$1', [org])).toBe(0);
    expect((await asConsumer({ action: 'get', requestId })).action === 'get' && (await asConsumer({ action: 'get', requestId }) as { copy: unknown }).copy).toBeNull();
    // A fictional release covering only two sections: the third must be excluded with a reason or the fulfilment is refused.
    const partial = await fictionalRelease(org, ['signed_notes', 'lab_observations']);
    expect(await refusal(asWorkforce({ action: 'fulfill', ...decision(requestId, 2), sections: ['signed_notes', 'telehealth_visits', 'lab_observations'] }))).toBe('disclosure_release_required');
    expect(await refusal(asWorkforce({ action: 'fulfill', ...decision(requestId, 2), sections: ['signed_notes', 'lab_observations'] }))).toBe('request_invalid'); // telehealth neither included nor excluded with a reason
    const fulfilled = await asWorkforce({ action: 'fulfill', ...decision(requestId, 2), sections: ['signed_notes', 'lab_observations'], excluded: [{ section: 'telehealth_visits', reason: 'Not released by the clinic for this request' }] });
    expect(fulfilled).toMatchObject({ action: 'fulfill', alreadyApplied: false, request: { status: 'fulfilled', revision: 3, outcome: 'copy_delivered' } });
    const manifest = fulfilled.action === 'fulfill' ? fulfilled.copy!.manifest : null;
    expect(manifest).toMatchObject({ contract: 'clinic-record-copy/1', requestId, consistency: 'snapshot_at_fulfillment', releaseVersion: partial.version, coverage: { completeClinicRecord: false } });
    expect(manifest!.sections).toEqual([
      { section: 'signed_notes', included: true, itemCount: 1, byteTotal: expect.any(Number), omittedCount: 0, exclusionReason: null, excluded: { unsigned_not_disclosable: 2 } },
      { section: 'telehealth_visits', included: false, itemCount: 0, byteTotal: 0, omittedCount: 0, exclusionReason: 'Not released by the clinic for this request', excluded: {} },
      { section: 'lab_observations', included: true, itemCount: 1, byteTotal: expect.any(Number), omittedCount: 0, exclusionReason: null, excluded: { not_reviewed: 1 } },
      { section: 'correspondence', included: false, itemCount: 0, byteTotal: 0, omittedCount: 0, exclusionReason: 'available_through_care_message_export', excluded: {} }]);
    // The owner reads the snapshot: the signed note with its addendum, the reviewed observation; never the draft, the unreviewed row or the transfer.
    const notes = await asConsumer({ action: 'read_copy', requestId, section: 'signed_notes', limit: 10 });
    expect(notes).toMatchObject({ action: 'read_copy', requestId, section: 'signed_notes', next: null, items: [{ seq: 1, recordKind: 'clinical_note', recordId: signed, revision: 1 }] });
    const note = notes.action === 'read_copy' ? verifyItem(notes.items[0]) : {};
    expect(note).toMatchObject({ noteId: signed, status: 'amended', version: 1, content: { text: 'Fictional signed narrative.' }, signedByPersonId: practitioner, addenda: [{ addendumId: addendum, referencedVersion: 1, reason: 'Fictional reason', content: 'Fictional addendum text', authorPersonId: practitioner }] });
    expect(JSON.stringify(notes)).not.toContain('DRAFT');
    const labs = await asConsumer({ action: 'read_copy', requestId, section: 'lab_observations', limit: 10 });
    expect(labs.action === 'read_copy' && labs.items.map(i => i.recordId)).toEqual([reviewed]);
    expect(JSON.stringify(labs)).not.toContain('"Iron"');
    expect(await refusal(asConsumer({ action: 'read_copy', requestId, section: 'telehealth_visits', limit: 10 }))).toBe('request_invalid'); // excluded section is not readable
    expect(JSON.stringify(await asConsumer({ action: 'get', requestId }))).not.toContain(transfer);
    // Audit and events: submitted → review_started → copy_fulfilled, and one copy_read per page.
    const events = (await asConsumer({ action: 'get', requestId })) as { events: Array<{ action: string }> };
    expect(events.events.map(e => e.action)).toEqual(['submitted', 'review_started', 'copy_fulfilled']);
    const audit = (await pg.query<{ action: string }>("select action from clinical_audit.events where resource_type='privacy_request' and resource_id=$1 order by occurred_at, action", [requestId])).rows.map(r => r.action);
    expect(audit).toEqual(['clinic_record.request_submitted', 'clinic_record.review_started', 'clinic_record.copy_fulfilled', 'clinic_record.copy_read', 'clinic_record.copy_read']);
  });

  it('includes the telehealth visit record without any admission or signing material, pages by keyset within a byte budget, and refuses a stale or foreign cursor', async () => {
    const transfers = await Promise.all([1, 2, 3].map(n => telehealthTransfer(patient, 'Fictional telehealth summary ' + n)));
    await fictionalRelease();
    const requestId = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId, sections: ['telehealth_visits'] });
    await asWorkforce({ action: 'fulfill', ...decision(requestId, 1), sections: ['telehealth_visits'] });
    await signedNote(patient, 'Fictional note with unicode — “quotes” and a tab\there.');
    const notesRequest = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId: notesRequest, sections: ['signed_notes', 'lab_observations'] });
    await labObservation(patient, connection, 'VitaminD', true);
    await asWorkforce({ action: 'fulfill', ...decision(notesRequest, 1), sections: ['signed_notes', 'lab_observations'] });
    const notesPage = await asConsumer({ action: 'read_copy', requestId: notesRequest, section: 'lab_observations', limit: 10 });
    const first = await asConsumer({ action: 'read_copy', requestId, section: 'telehealth_visits', limit: 2 });
    expect(first.action === 'read_copy' && first.items.map(i => i.seq)).toEqual([1, 2]);
    expect(first.action === 'read_copy' && first.next).toBe(2);
    const second = await asConsumer({ action: 'read_copy', requestId, section: 'telehealth_visits', limit: 2, after: 2 });
    expect(second.action === 'read_copy' && second.items.map(i => i.seq)).toEqual([3]);
    expect(second.action === 'read_copy' && second.next).toBeNull();
    const ids = [...(first.action === 'read_copy' ? first.items : []), ...(second.action === 'read_copy' ? second.items : [])].map(i => i.recordId).sort();
    expect(ids).toEqual([...transfers].sort());
    const text = JSON.stringify([first, second]);
    for (const forbidden of ['admission', 'signature', 'secret', 'key_id', 'fictional-admission-key']) expect(text).not.toContain(forbidden);
    // The digest the clinic recorded is the digest a device recomputes from the delivered bytes: every item, both sections.
    for (const page of [first, second, notesPage]) for (const it of page.action === 'read_copy' ? page.items : []) verifyItem(it);
    expect(text).toContain('Fictional practitioner text');
    expect(first.action === 'read_copy' ? verifyItem(first.items[0]) : {}).toMatchObject({ sourceNoteRevision: 2, chart: { noteVersion: 1, noteStatus: 'draft' } });
    expect(await refusal(asConsumer({ action: 'read_copy', requestId, section: 'telehealth_visits', limit: 2, after: 99 }))).toBe('no_error'); // past the end: an empty page, not an error
    expect(await asConsumer({ action: 'read_copy', requestId, section: 'telehealth_visits', limit: 2, after: 99 })).toMatchObject({ items: [], next: null });
    // Byte budget: a page stops before exceeding 256 KiB once it holds one item.
    const big = 'x'.repeat(40000);
    for (let n = 0; n < 8; n++) await signedNote(patient, big + n);
    const bigRequest = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId: bigRequest, sections: ['signed_notes'] });
    await asWorkforce({ action: 'fulfill', ...decision(bigRequest, 1), sections: ['signed_notes'] });
    const page = await asConsumer({ action: 'read_copy', requestId: bigRequest, section: 'signed_notes', limit: 50 });
    expect(page.action === 'read_copy' && page.items.length).toBeLessThan(8);
    expect(page.action === 'read_copy' && page.items.reduce((sum, i) => sum + i.byteLength, 0)).toBeLessThanOrEqual(262144);
    expect(page.action === 'read_copy' && page.next).toBe(page.action === 'read_copy' ? page.items.at(-1)!.seq : null);
  });

  it('keeps the fulfilled copy readable by its immutable owner after the link is paused, revoked or replaced, and by nobody else', async () => {
    await signedNote(patient, 'Fictional retained note.'); await fictionalRelease();
    const requestId = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes'] });
    await asWorkforce({ action: 'fulfill', ...decision(requestId, 1), sections: ['signed_notes'] });
    for (const state of ['paused', 'revoked']) {
      await pg.query("update clinical_core.patient_connections set state=$2, paused_at=case when $2='paused' then now() end, revoked_at=case when $2='revoked' then now() end where id=$1", [connection, state]);
      expect(await asConsumer({ action: 'read_copy', requestId, section: 'signed_notes', limit: 5 })).toMatchObject({ items: [{ recordKind: 'clinical_note' }] });
      expect(await asConsumer({ action: 'get', requestId })).toMatchObject({ request: { status: 'fulfilled' } });
    }
    // The link is replaced by a new consumer for the same patient: the old copy never reaches the new owner, and the old owner still has it.
    const replacement = await person(null, org, 'consumer'); await connect(org, patient, replacement);
    expect(await refusal(asConsumer({ action: 'get', requestId }, { who: replacement }))).toBe('not_found');
    expect(await refusal(asConsumer({ action: 'read_copy', requestId, section: 'signed_notes', limit: 5 }, { who: replacement }))).toBe('not_found');
    expect((await asConsumer({ action: 'overview' }, { who: replacement })).action === 'overview' && (await asConsumer({ action: 'overview' }, { who: replacement }) as { requests: unknown[] }).requests).toEqual([]);
    expect(await asConsumer({ action: 'read_copy', requestId, section: 'signed_notes', limit: 5 })).toMatchObject({ items: [{ recordKind: 'clinical_note' }] });
    // But a NEW request needs a live, verified link: the revoked owner cannot submit again.
    expect(await refusal(asConsumer({ action: 'submit_copy', requestId: randomUUID(), sections: ['signed_notes'] }))).toBe('connection_required');
  });
});

describe('isolation: two clinics, two same-clinic patients, roles and pools', () => {
  it('leaks no row, text or receipt metadata across patients, clinics, roles or pools', async () => {
    await signedNote(patient, 'Fictional patient-one note.'); await signedNote(secondPatient, 'Fictional patient-two note.'); await fictionalRelease();
    const one = randomUUID(), two = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId: one, sections: ['signed_notes'] });
    await asConsumer({ action: 'submit_copy', requestId: two, sections: ['signed_notes'] }, { who: secondConsumer });
    await asWorkforce({ action: 'fulfill', ...decision(one, 1), sections: ['signed_notes'] });
    // Same-clinic second consumer: not found, never "forbidden with details"; and replaying patient one's request id is a conflict with nothing disclosed.
    for (const [label, attempt] of [
      ['second consumer get', () => asConsumer({ action: 'get', requestId: one }, { who: secondConsumer })],
      ['second consumer read', () => asConsumer({ action: 'read_copy', requestId: one, section: 'signed_notes', limit: 5 }, { who: secondConsumer })],
      ['second consumer withdraw', () => asConsumer({ action: 'withdraw', requestId: one, expectedRevision: 2 }, { who: secondConsumer })],
      ['foreign consumer get', () => asConsumer({ action: 'get', requestId: one }, { who: foreignConsumer, organization: otherOrg })],
    ] as const) expect(await refusal(attempt()), label).toBe('not_found');
    expect(await refusal(asConsumer({ action: 'submit_copy', requestId: one, sections: ['signed_notes'] }, { who: secondConsumer }))).toBe('conflict');
    const overviewTwo = await asConsumer({ action: 'overview' }, { who: secondConsumer });
    expect(overviewTwo.action === 'overview' && overviewTwo.requests.map(r => r.requestId)).toEqual([two]);
    expect(JSON.stringify(overviewTwo)).not.toContain(one);
    // Foreign clinic workforce, staff-only role and a consumer on the workforce route are refused; the workforce queue of the other clinic is empty.
    expect(await refusal(asWorkforce({ action: 'review', requestId: one }, { who: outsider, organization: otherOrg }))).toBe('not_found');
    expect(await refusal(asWorkforce({ action: 'queue', limit: 10 }, { who: outsider }))).toBe('identity_refused');
    expect(await refusal(asWorkforce({ action: 'review', requestId: one }, { who: staff }))).toBe('identity_refused');
    expect(await refusal(asWorkforce({ action: 'review', requestId: one }, { who: consumer, pool: 'workforce' }))).toBe('identity_refused');
    expect(await refusal(createProductionClinicRecordsWorkforce(api)(context({ pool: 'consumer', who: consumer }), { action: 'queue', limit: 10 }))).toBe('identity_refused');
    expect(await refusal(createProductionClinicRecordsConsumer(api)(context({ pool: 'workforce', who: practitioner }), { action: 'overview' }))).toBe('identity_refused');
    expect(await refusal(call("select clinical_core.clinic_record_request('{\"action\":\"queue\",\"limit\":10}'::jsonb) as result", [], { pool: 'consumer', who: consumer }))).toMatch(/care_connection_refused/);
    expect(await refusal(call("select clinical_core.clinic_record_request('{\"action\":\"overview\"}'::jsonb) as result", [], { pool: 'workforce', who: practitioner }))).toMatch(/care_connection_refused/);
    expect((await asWorkforce({ action: 'queue', limit: 10 }, { who: outsider, organization: otherOrg })).action === 'queue' && (await asWorkforce({ action: 'queue', limit: 10 }, { who: outsider, organization: otherOrg }) as { requests: unknown[] }).requests).toEqual([]);
    // A suspended membership, a disabled identity and an archived patient refuse the workforce decision.
    await pg.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [colleague]);
    expect(await refusal(asWorkforce({ action: 'review', requestId: two }, { who: colleague }))).toBe('identity_refused');
    await pg.query("update clinical_core.patient_records set status='archived' where id=$1", [secondPatient]);
    expect(await refusal(asWorkforce({ action: 'review', requestId: two }))).toBe('not_found');
    await pg.query("update clinical_core.identities set status='disabled' where person_id=$1", [consumer]);
    expect(await refusal(asConsumer({ action: 'get', requestId: one }))).toBe('identity_refused');
    // No API-role access to any ledger or the release table.
    for (const table of ['clinical_core.clinic_record_requests', 'clinical_core.clinic_record_copies', 'clinical_core.clinic_record_copy_items', 'clinical_core.clinic_record_request_events', 'clinical_private.clinic_disclosure_releases']) {
      expect(await refusal(call(`select count(*) as result from ${table}`)), table).toMatch(/permission denied/);
    }
  });
});

describe('decisions: race orders, replay, stale revisions, withdrawal and supersession', () => {
  it('converges on one outcome in either order, replays a decision id, refuses a stale revision and a decision on a settled request', async () => {
    await signedNote(patient, 'Fictional note.'); await fictionalRelease();
    const requestId = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId, sections: ['signed_notes'] });
    const refuseFirst = { ...decision(requestId, 1), reasonCode: 'identity_unverified' as const, reason: 'Fictional reason' };
    const fulfilFirst = { ...decision(requestId, 1), sections: ['signed_notes' as const] };
    // Order A: refuse lands, then the colleague's fulfil with the same expected revision is a conflict (and writes nothing).
    expect(await asWorkforce({ action: 'refuse', ...refuseFirst })).toMatchObject({ request: { status: 'refused', outcome: 'copy_refused', decisionReasonCode: 'identity_unverified' } });
    expect(await refusal(asWorkforce({ action: 'fulfill', ...fulfilFirst }, { who: colleague }))).toBe('conflict');
    expect(await count('clinical_core.clinic_record_copies where organization_id=$1', [org])).toBe(0);
    // Replaying the applied decision id returns the same state; replaying it under another request is a conflict.
    expect(await asWorkforce({ action: 'refuse', ...refuseFirst })).toMatchObject({ alreadyApplied: true, request: { status: 'refused' } });
    const other = randomUUID(); await asConsumer({ action: 'submit_copy', requestId: other, sections: ['signed_notes'] });
    expect(await refusal(asWorkforce({ action: 'refuse', ...refuseFirst, requestId: other }))).toBe('conflict');
    // Order B on the second request: fulfil lands, then refuse is a conflict; the owner's withdraw after fulfilment is a conflict too.
    expect(await asWorkforce({ action: 'fulfill', ...decision(other, 1), sections: ['signed_notes'] }, { who: colleague })).toMatchObject({ request: { status: 'fulfilled' } });
    expect(await refusal(asWorkforce({ action: 'refuse', ...decision(other, 1), reasonCode: 'other', reason: 'late' }))).toBe('conflict');
    expect(await refusal(asWorkforce({ action: 'refuse', ...decision(other, 2), reasonCode: 'other', reason: 'late' }))).toBe('conflict');
    expect(await refusal(asConsumer({ action: 'withdraw', requestId: other, expectedRevision: 2 }))).toBe('conflict');
    expect(await count('clinical_core.clinic_record_copies where organization_id=$1', [org])).toBe(1);
    // Withdrawal before a decision: idempotent, and a later decision is a conflict.
    const third = randomUUID(); await asConsumer({ action: 'submit_copy', requestId: third, sections: ['signed_notes'] });
    expect(await refusal(asConsumer({ action: 'withdraw', requestId: third, expectedRevision: 9 }))).toBe('conflict');
    expect(await asConsumer({ action: 'withdraw', requestId: third, expectedRevision: 1 })).toMatchObject({ alreadyApplied: false, request: { status: 'withdrawn', revision: 2 } });
    expect(await asConsumer({ action: 'withdraw', requestId: third, expectedRevision: 2 })).toMatchObject({ alreadyApplied: true });
    expect(await refusal(asWorkforce({ action: 'begin_review', ...decision(third, 2) }))).toBe('conflict');
    // Supersession: a new copy request naming the open one closes it; without naming it, the new one is refused.
    const fourth = randomUUID(), fifth = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId: fourth, sections: ['signed_notes'] });
    expect(await refusal(asConsumer({ action: 'submit_copy', requestId: fifth, sections: ['signed_notes', 'lab_observations'] }))).toBe('conflict');
    expect(await asConsumer({ action: 'submit_copy', requestId: fifth, sections: ['signed_notes', 'lab_observations'], supersedes: fourth })).toMatchObject({ request: { requestId: fifth, status: 'submitted' } });
    expect(await asConsumer({ action: 'get', requestId: fourth })).toMatchObject({ request: { status: 'superseded', supersededBy: fifth } });
    expect(await refusal(asWorkforce({ action: 'begin_review', ...decision(fourth, 2) }))).toBe('conflict');
    // The queue pages by (submittedAt, requestId) and filters by status.
    const page = await asWorkforce({ action: 'queue', status: 'submitted', limit: 1 });
    expect(page.action === 'queue' && page.requests.map(r => r.requestId)).toEqual([fifth]);
    expect(page.action === 'queue' && page.next).toMatchObject({ requestId: fifth });
    expect((await asWorkforce({ action: 'queue', status: 'submitted', limit: 1, after: page.action === 'queue' ? page.next! : undefined })).action === 'queue').toBe(true);
    // Ledgers are append-only.
    expect(await refusal(pg.query("update clinical_core.clinic_record_requests set owner_person_id=$2 where id=$1", [requestId, secondConsumer]))).toMatch(/append_only_record/);
    expect(await refusal(pg.query('delete from clinical_core.clinic_record_request_events where request_id=$1', [requestId]))).toMatch(/append_only_record/);
    expect(await refusal(pg.query('delete from clinical_core.clinic_record_copies where request_id=$1', [other]))).toMatch(/append_only_record/);
    expect(await refusal(pg.query("update clinical_private.clinic_disclosure_releases set sections='{signed_notes,correspondence}'"))).toMatch(/append_only_record/);
  });
});

describe('corrections: an owner request against a disclosed signed revision; clinician amendment is append-only', () => {
  it('requires a disclosed revision, amends through add_note_addendum without touching the signed content, or declines with the disagreement recorded', async () => {
    const note = await signedNote(patient, 'Fictional signed content that the patient disputes.');
    const other = await signedNote(patient, 'Fictional note never disclosed.');
    const correction = { action: 'submit_correction' as const, subjectKind: 'clinical_note' as const, subjectId: note, subjectRevision: 1, reasonCode: 'not_true_of_me' as const, statement: 'Fictional: this is not true of me.' };
    // Not yet disclosed to this owner: refused, nothing written.
    expect(await refusal(asConsumer({ ...correction, requestId: randomUUID() }))).toBe('identity_refused');
    await fictionalRelease(); const copy = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId: copy, sections: ['signed_notes'] });
    await asWorkforce({ action: 'fulfill', ...decision(copy, 1), sections: ['signed_notes'] });
    // Now both notes are disclosed; a wrong revision, a draft, another patient's note or the second consumer are refused.
    expect(await refusal(asConsumer({ ...correction, requestId: randomUUID(), subjectRevision: 2 }))).toBe('identity_refused');
    expect(await refusal(asConsumer({ ...correction, requestId: randomUUID(), subjectId: await draftNote(patient, 'draft') }))).toBe('identity_refused');
    expect(await refusal(asConsumer({ ...correction, requestId: randomUUID() }, { who: secondConsumer }))).toBe('identity_refused');
    const requestId = randomUUID();
    const submitted = await asConsumer({ ...correction, requestId });
    expect(submitted).toMatchObject({ request: { kind: 'correction', status: 'submitted', subject: { kind: 'clinical_note', id: note, revision: 1 }, reasonCode: 'not_true_of_me' } });
    expect(await refusal(asConsumer({ ...correction, requestId: randomUUID(), subjectId: other }))).toBe('conflict'); // one open correction per link
    // The clinic reviews: the subject note's state, never a rewrite path.
    const review = await asWorkforce({ action: 'review', requestId });
    expect(review.action === 'review' && review.subjectNote).toMatchObject({ noteId: note, status: 'signed', currentVersion: 1, addenda: 0 });
    expect(await refusal(asWorkforce({ action: 'fulfill', ...decision(requestId, 1), sections: ['signed_notes'] }))).toBe('request_invalid'); // a correction is not a copy
    expect(await refusal(asWorkforce({ action: 'refuse', ...decision(requestId, 1), reasonCode: 'other', reason: 'x' }))).toBe('request_invalid'); // refuse is for copies; decline is for corrections
    const amended = await asWorkforce({ action: 'amend', ...decision(requestId, 1), addendumReason: 'Patient correction request accepted', addendumContent: 'Fictional correction: the statement is withdrawn by the clinician.' });
    expect(amended).toMatchObject({ action: 'amend', request: { status: 'fulfilled', outcome: 'amended' } });
    const addendumId = amended.action === 'amend' ? amended.addendumId : null;
    expect(amended.action === 'amend' && amended.request.fulfillmentId).toBe(addendumId);
    const stored = (await pg.query<{ status: string; current_version: number }>('select status,current_version from clinical_core.clinical_notes where id=$1', [note])).rows[0];
    expect(stored).toEqual({ status: 'amended', current_version: 1 });
    expect((await pg.query<{ content: unknown }>('select content from clinical_core.clinical_note_versions where note_id=$1 and version=1', [note])).rows[0].content).toEqual({ text: 'Fictional signed content that the patient disputes.' });
    expect((await pg.query<{ reason: string; author_person_id: string; referenced_version: number }>('select reason,author_person_id,referenced_version from clinical_core.note_addenda where id=$1', [addendumId])).rows[0])
      .toEqual({ reason: 'Patient correction request accepted', author_person_id: practitioner, referenced_version: 1 });
    expect(await refusal(asWorkforce({ action: 'amend', ...decision(requestId, 2), addendumReason: 'again', addendumContent: 'again' }))).toBe('conflict');
    expect(await count('clinical_core.note_addenda where note_id=$1', [note])).toBe(1);
    // Declining keeps the record and records the disagreement.
    const second = randomUUID();
    await asConsumer({ ...correction, requestId: second, subjectId: other, reasonCode: 'missing_context', statement: 'Fictional: context missing.' });
    const declined = await asWorkforce({ action: 'decline', ...decision(second, 1), reasonCode: 'record_accurate', reason: 'Fictional: the record is accurate as signed.' });
    expect(declined).toMatchObject({ request: { status: 'refused', outcome: 'declined', decisionReasonCode: 'record_accurate', statement: 'Fictional: context missing.' } });
    expect(await count('clinical_core.note_addenda where note_id=$1', [other])).toBe(0);
    const owner = await asConsumer({ action: 'get', requestId: second });
    expect(owner.action === 'get' && owner.events.map(e => e.action)).toEqual(['submitted', 'declined']);
    expect(await refusal(asConsumer({ ...correction, requestId: second, subjectId: other, reasonCode: 'missing_context', statement: 'Fictional: context missing.' }))).toBe('no_error'); // exact replay of a settled request is still the same row
  });
});

describe('AUDIT exact-byte wire contract', () => {
  it('AUDIT reads a valid decimal lab payload digested by PostgreSQL jsonb: the text travels as digested, and the committed fixture is byte-identical to what the reader produced', async () => {
    // Fixed identities so the produced bytes are reproducible and can be pinned for the V2 client test.
    const reviewer = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', eventId = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', observation = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [reviewer, 'subject_fixture_reviewer']);
    await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce','subject-fixture-reviewer',true)", [reviewer]);
    await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, reviewer]);
    const provider = (await pg.query<{ id: string }>("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'fictional_lab','patient-sync/1','lab-result/1','1','active',$2,now()) returning id", [org, practitioner])).rows[0].id;
    await pg.query(`insert into clinical_core.lab_import_events(id,organization_id,patient_record_id,connection_id,provider_id,provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,marker_name,value_numeric,unit,collected_at,occurred_at,payload_sha256,state,reviewed_at,reviewed_by_person_id)
      values($1,$2,$3,$4,$5,'evt-fixture-decimal','panel-1','VitaminD','1','Vitamin panel','VitaminD',1.20,'ng/mL','2026-10-09T12:00:00Z','2026-10-09T12:00:00Z',$6,'accepted','2026-10-09T13:00:00Z',$7)`,
      [eventId, org, patient, connection, provider, sha('fixture'), reviewer]);
    await pg.query(`insert into clinical_core.lab_observations(id,organization_id,patient_record_id,import_event_id,panel_name,marker_name,value_numeric,unit,reference_min,reference_max,observed_at,review_status,provenance,reviewed_at,reviewed_by_person_id)
      values($1,$2,$3,$4,'Vitamin panel','VitaminD',1.20,'ng/mL',0.0000001,1000000.50,'2026-10-09T12:00:00Z','accepted',$5::jsonb,'2026-10-09T13:00:00Z',$6)`,
      // Hand-written JSON text: a JavaScript JSON.stringify would already have rounded these before PostgreSQL saw them.
      [observation, org, patient, eventId, '{"source": "fictional_lab", "importEventId": "' + eventId + '", "unicode": "µg/L — fictional ✓", "nested": [1.50, [2.0e-7, "x"], {"n": 12345678901234567890}]}', reviewer]);
    const requestId = randomUUID();
    await asConsumer({ action: 'submit_copy', requestId, sections: ['lab_observations'] });
    await fictionalRelease(org, ['lab_observations']);
    await asWorkforce({ action: 'fulfill', ...decision(requestId, 1), sections: ['lab_observations'] });
    const page = await asConsumer({ action: 'read_copy', requestId, section: 'lab_observations', limit: 10 });
    if (page.action !== 'read_copy') throw new Error('page');
    const item = page.items[0];
    // The bytes PostgreSQL digested are the bytes delivered: decimals keep their scale and small numbers never become exponents.
    expect(item.payloadText).toContain('"valueNumeric": 1.20'); expect(item.payloadText).toContain('"referenceMin": 0.0000001');
    expect(item.payloadText).toContain('"referenceMax": 1000000.50'); expect(item.payloadText).toContain('12345678901234567890');
    expect(item.payloadText).toContain('[1.50, [0.00000020, "x"]'); expect(item.payloadText).toContain('µg/L — fictional ✓');
    const parsed = verifyItem(item);
    expect(parsed).toMatchObject({ observationId: observation, markerName: 'VitaminD', unit: 'ng/mL', reviewedByPersonId: reviewer });
    // The defect this guards against: a JavaScript round trip re-serializes 1.20 as 1.2 and 0.0000001 as 1e-7, so hashing a rebuilt object can never verify these bytes.
    expect(JSON.stringify(JSON.parse(item.payloadText))).not.toContain('1.20');
    expect(sha(JSON.stringify(JSON.parse(item.payloadText)))).not.toBe(item.payloadSha256);
    const pinned = { recordKind: item.recordKind, recordId: item.recordId, revision: item.revision, payloadText: item.payloadText, payloadSha256: item.payloadSha256, byteLength: item.byteLength };
    if (process.env.WRITE_CLINIC_RECORD_FIXTURE === '1') writeFileSync(FIXTURE, JSON.stringify(pinned, null, 2) + '\n');
    // Byte-identical with the committed fixture that the V2 client test replays through the real transport (expo/contracts/fixtures).
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(pinned);
  });
});
