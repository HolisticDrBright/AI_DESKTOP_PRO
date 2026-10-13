import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defaultNotificationPreferences } from '@/contracts/patientNotifications';
import { PATIENT_NOTIFICATIONS_SCHEMA_CANDIDATE_SHA256, PATIENT_NOTIFICATIONS_PARENTS, createSqlNoticeEnqueuer, createSqlPatientNotificationLedger, createSqlPatientNotificationSettings } from './patient-notification-ledger';
import { createAppointmentTextReminders, createInboundTextHandler, createNoticeDispatcher, createNoticeEmitter } from './notification-dispatcher';
import { createFictionalSenders } from './notification-providers';
import { classifyDatabaseRejection } from '@/server/clinical-core/rds-data-database';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '@/server/clinical-core/database';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';

/**
 * The BLOCKED candidate patient-notifications.sql on the installed migration chain, on an embedded
 * engine. Calls are made as the reduced roles (clinical_core_api, patient_notification_worker) with
 * the request context a verified session would set. Fictional clinics, patients and numbers only.
 * One embedded connection and one superuser for fixture setup: grants and row policies are
 * exercised, but nothing here is hosted isolation, provider delivery or carrier evidence.
 */
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (n: number) => '7d000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), otherOrg = id(2), owner = id(3), clinician = id(4), staff = id(5), outsider = id(6);
const ava = id(10), ben = id(11), cal = id(12);
const avaRecord = id(20), benRecord = id(21), calRecord = id(22), otherRecord = id(23);
const avaConn = id(30), benConn = id(31), calConn = id(32), otherConn = id(33);
const WORDING = 'FICTIONAL TEST WORDING: I agree to receive texts about my care from my clinic at this number. Reply STOP to stop, HELP for help.';
const AVA_PHONE = '+15555550101', BEN_PHONE = '+15555550102', NEW_PHONE = '+15555550109';
type Who = { person: string; org: string | null; pool: 'workforce' | 'consumer'; subject: string };
const as = {
  owner: { person: owner, org, pool: 'workforce', subject: 'wf_fictional_owner_01' },
  clinician: { person: clinician, org, pool: 'workforce', subject: 'wf_fictional_clinician_01' },
  staff: { person: staff, org, pool: 'workforce', subject: 'wf_fictional_staff_01' },
  outsider: { person: outsider, org: otherOrg, pool: 'workforce', subject: 'wf_fictional_outsider_01' },
  ava: { person: ava, org: null, pool: 'consumer', subject: 'cn_fictional_ava_0001' },
  ben: { person: ben, org: null, pool: 'consumer', subject: 'cn_fictional_ben_0001' },
  cal: { person: cal, org: null, pool: 'consumer', subject: 'cn_fictional_cal_0001' },
} satisfies Record<string, Who>;

let db!: PGlite;
const fixture = async (sql: string, args: unknown[] = []) => db.transaction(async tx => {
  await tx.exec("set local session_replication_role = 'replica'");
  await tx.query(sql, args);
});
/** One call from the reduced role, in the request context of `who` (or none, for the worker). */
async function call<T = Record<string, unknown>>(role: 'clinical_core_api' | 'patient_notification_worker', who: Who | null, sql: string, args: unknown[] = []): Promise<T> {
  return db.transaction(async (tx: Transaction) => {
    await tx.exec(`set local role ${role}`);
    if (who) await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [who.person, who.org, who.pool, who.subject, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
    return (await tx.query<{ r: T }>(`select (${sql}) as r`, args)).rows[0]!.r;
  });
}
async function refusal(role: 'clinical_core_api' | 'patient_notification_worker', who: Who | null, sql: string, args: unknown[] = []) {
  try { await call(role, who, sql, args); } catch (error) { return (error as Error).message; }
  return 'none';
}
const api = <T = Record<string, unknown>>(who: Who, sql: string, args: unknown[] = []) => call<T>('clinical_core_api', who, sql, args);
const worker = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => call<T>('patient_notification_worker', null, sql, args);
const enqueue = (who: Who, kind: string, subject: Record<string, string>) => api<{ queued: boolean; reason?: string; duplicate?: boolean }>(who, 'clinical_core.enqueue_patient_notice($1,$2::jsonb)', [kind, JSON.stringify(subject)]);
const settings = (who: Who) => api<{ preferences: ReturnType<typeof defaultNotificationPreferences>; timeZone: string | null; version: number; textConsent: null | { phone: string }; textStopped: boolean; pushAvailable: boolean }>(who, 'clinical_core.my_patient_notification_settings()');
const save = (who: Who, prefs: unknown, zone: string | null, version: number) => api(who, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(prefs), zone, version]);
type Prefs = ReturnType<typeof defaultNotificationPreferences>;
const textsOn = (base: Prefs = defaultNotificationPreferences()): Prefs => ({ ...base, appointmentReminders: { email: true, sms: true }, notices: Object.fromEntries(Object.entries(base.notices).map(([k, v]) => [k, { ...v, sms: true }])) as Prefs['notices'] });
/** A zone whose local hour is `hour` right now (Etc/GMT zones have whole-hour offsets, sign inverted). */
function zoneAtLocalHour(hour: number) {
  const utc = new Date().getUTCHours();
  for (let offset = -12; offset <= 14; offset++) if (((utc + offset) % 24 + 24) % 24 === hour) return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
  throw new Error('no zone');
}
const backdate = (minutes: number) => fixture(`update clinical_core.patient_notice_events set visible_at=clock_timestamp()-make_interval(mins=>$1) where notice_id is null`, [minutes]);
const activate = (notices: boolean, texts: boolean) => db.query(`update clinical_core.patient_notification_activation set notices_enabled=$1,texts_enabled=$2,evidence_sha256=$3,reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`, [notices, texts, 'e'.repeat(64)]);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const dir = 'infra/aws-clinical-core/';
  const manifestText = readFileSync(dir + 'migrations/manifest.json', 'utf8');
  for (const [file, digest] of Object.entries(PATIENT_NOTIFICATIONS_PARENTS)) {
    expect(sha(readFileSync(dir + file, 'utf8')), file + ' moved since the candidate was written').toBe(digest);
  }
  for (const { file } of (JSON.parse(manifestText) as { migrations: { file: string }[] }).migrations) await db.exec(readFileSync(dir + 'migrations/' + file, 'utf8'));
  const candidate = readFileSync(dir + 'source-candidates/patient-notifications.sql', 'utf8');
  expect(sha(candidate)).toBe(PATIENT_NOTIFICATIONS_SCHEMA_CANDIDATE_SHA256);
  await db.exec(candidate);

  for (const [o, label] of [[org, 'FICTIONAL notification clinic'], [otherOrg, 'FICTIONAL other clinic']]) await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [o, label]);
  for (const who of Object.values(as)) {
    await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [who.person, 'syn_' + who.subject]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)', [who.person, who.pool, who.subject]);
  }
  for (const [p, role, o] of [[owner, 'owner', org], [clinician, 'practitioner', org], [staff, 'staff', org], [outsider, 'practitioner', otherOrg]]) {
    await db.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [o, p, role]);
  }
  for (const [record, o, key] of [[avaRecord, org, 'ava'], [benRecord, org, 'ben'], [calRecord, org, 'cal'], [otherRecord, otherOrg, 'other']]) {
    await db.query('insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)', [record, o, `patient_syn_fictional_${key}_01`]);
  }
  await db.query(`insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values
    ($1,$4,$5,$8,'verified',now()),($2,$4,$6,$9,'verified',now()),($3,$4,$7,$10,'paused',now())`, [avaConn, benConn, calConn, org, avaRecord, benRecord, calRecord, ava, ben, cal]);
  await db.query(`insert into clinical_core.patient_connections(id,organization_id,patient_record_id,state) values($1,$2,$3,'invitation_pending')`, [otherConn, otherOrg, otherRecord]);
}, 180_000);
afterAll(async () => { await db?.close(); });

/* fixture items, written as the clinical actions would leave them */
let seq = 100;
async function message(connection: string, sender: string, pool: 'workforce' | 'consumer') {
  const thread = id(seq++), msg = id(seq++);
  await fixture(`insert into clinical_core.care_message_threads(id,connection_id,subject) values($1,$2,'Fictional thread')`, [thread, connection]);
  await fixture(`insert into clinical_core.care_messages(id,thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body) values($1,$2,$3,$4,$5,'h','care-messages/1','Fictional body that must never reach a notice')`, [msg, thread, sender, pool, id(seq++)]);
  return msg;
}
async function packet(connection: string, record: string, status: 'open' | 'cancelled') {
  const p = id(seq++);
  await fixture(`insert into clinical_core.intake_packets(id,organization_id,connection_id,patient_record_id,label,status,created_by_person_id,cancelled_at,cancelled_by_person_id)
    values($1,$2,$3,$4,'Fictional packet',$5,$6,$7,$8)`, [p, org, connection, record, status, clinician, status === 'cancelled' ? new Date() : null, status === 'cancelled' ? clinician : null]);
  return p;
}
async function observation(connection: string, record: string, state: 'accepted' | 'review_pending') {
  const event = id(seq++), obs = id(seq++), provider = id(seq++);
  await fixture(`insert into clinical_core.sync_providers(id,organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state) values($1,$2,$3,'patient-sync/1','lab-result/1','1','pending_review')`, [provider, org, 'fictional_' + seq]);
  await fixture(`insert into clinical_core.lab_import_events(id,organization_id,patient_record_id,connection_id,provider_id,provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,marker_name,value_numeric,collected_at,occurred_at,payload_sha256,state,reviewed_at,reviewed_by_person_id)
    values($1,$2,$3,$4,$5,$6,'panel','marker','1','Fictional panel','Fictional marker',1,now(),now(),$7,$8,$9,$10)`, [event, org, record, connection, provider, 'evt_fictional_' + seq, 'a'.repeat(64), state, state === 'accepted' ? new Date() : null, state === 'accepted' ? clinician : null]);
  await fixture(`insert into clinical_core.lab_observations(id,organization_id,patient_record_id,import_event_id,panel_name,marker_name,value_numeric,observed_at,provenance) values($1,$2,$3,$4,'Fictional panel','Fictional marker',1,now(),'{}')`, [obs, org, record, event]);
  return obs;
}
async function assignment(connection: string, person: string, state: 'offered' | 'active' | 'withdrawn', release?: string) {
  const a = id(seq++);
  await fixture(`insert into clinical_core.program_assignments(id,organization_id,connection_id,consumer_person_id,program_version_id,assigned_by,title,content,source_digest,state,started_at,phase_started_at)
    values($1,$2,$3,$4,$5,$6,'Fictional program','[]',$7,$8,$9,$9)`, [a, org, connection, person, id(seq++), clinician, 'b'.repeat(64), state, state === 'offered' ? null : new Date()]);
  if (release) await fixture(`insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by) values($1,$2,'practitioner_release',$3)`, [a, release, clinician]);
  return a;
}

describe('the candidate itself', () => {
  it('is BLOCKED and closed: two NOLOGIN non-bypass roles, no table privilege for the API or worker, both channels disabled, no wording seeded', async () => {
    expect((await db.query(`select rolname,rolcanlogin,rolbypassrls,rolsuper,rolinherit from pg_roles where rolname in('patient_notification_authority','patient_notification_worker') order by 1`)).rows).toEqual([
      { rolname: 'patient_notification_authority', rolcanlogin: false, rolbypassrls: false, rolsuper: false, rolinherit: false },
      { rolname: 'patient_notification_worker', rolcanlogin: false, rolbypassrls: false, rolsuper: false, rolinherit: false },
    ]);
    const tables = (await db.query<{ t: string }>(`select 'clinical_core.'||tablename t from pg_tables where schemaname='clinical_core' and (tablename like 'patient\\_notice%' or tablename like 'patient\\_text%' or tablename like 'patient\\_notification%' or tablename='patient_reminder_texts') order by 1`)).rows.map(r => r.t);
    expect(tables).toHaveLength(11);
    for (const t of tables) for (const role of ['clinical_core_api', 'patient_notification_worker']) {
      expect((await db.query<{ ok: boolean }>(`select has_table_privilege($1,$2,'SELECT') or has_table_privilege($1,$2,'INSERT') or has_table_privilege($1,$2,'UPDATE') as ok`, [role, t])).rows[0]!.ok, role + ' ' + t).toBe(false);
    }
    expect((await db.query('select notices_enabled,texts_enabled from clinical_core.patient_notification_activation')).rows).toEqual([{ notices_enabled: false, texts_enabled: false }]);
    expect((await db.query('select count(*)::int n from clinical_core.patient_text_consent_wordings')).rows).toEqual([{ n: 0 }]);
    const owners = (await db.query<{ owner: string }>(`select distinct r.rolname owner from pg_proc p join pg_roles r on r.oid=p.proowner join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='clinical_private' and p.proname like 'patient\\_%') or (n.nspname='clinical_core' and (p.proname like '%patient_notice%' or p.proname like '%notification%' or p.proname like '%text%consent%' or p.proname like '%reminder%text%' or p.proname='record_inbound_text' or p.proname='patient_reminder_channels'))`)).rows;
    expect(owners).toEqual([{ owner: 'patient_notification_authority' }]);
    // The API cannot run the worker's functions and the worker cannot run the API's.
    expect((await db.query(`select has_function_privilege('clinical_core_api','clinical_core.due_patient_notice_deliveries(integer)','EXECUTE') api_due,
      has_function_privilege('clinical_core_api','clinical_core.record_inbound_text(text,text,text)','EXECUTE') api_inbound,
      has_function_privilege('patient_notification_worker','clinical_core.enqueue_patient_notice(text,jsonb)','EXECUTE') worker_enqueue,
      has_function_privilege('patient_notification_worker','clinical_core.set_my_patient_notification_settings(jsonb,text,bigint)','EXECUTE') worker_settings`)).rows)
      .toEqual([{ api_due: false, api_inbound: false, worker_enqueue: false, worker_settings: false }]);
  });
  it('stores nothing about an item or a message: no body, title, address or value column anywhere', async () => {
    const columns = (await db.query<{ c: string }>(`select table_name||'.'||column_name c from information_schema.columns where table_schema='clinical_core'
      and table_name in('patient_notice_events','patient_notices','patient_notice_deliveries','patient_reminder_texts','patient_text_inbound','patient_text_stops') order by 1`)).rows.map(r => r.c);
    expect(columns.filter(c => /body|title|subject|email|address|value|content|text$/.test(c.split('.')[1]!))).toEqual([]);
    expect(columns.filter(c => /phone/.test(c))).toEqual(['patient_notice_deliveries.phone_sha256', 'patient_reminder_texts.phone_sha256', 'patient_text_inbound.phone_sha256', 'patient_text_stops.phone_sha256']);
  });
});

describe('preferences', () => {
  it('a patient with nothing saved sees the defaults: reminders and every kind by email, nothing by text, no push', async () => {
    const view = await settings(as.ava);
    expect(view.preferences).toEqual(defaultNotificationPreferences());
    expect(view).toMatchObject({ timeZone: null, version: 0, textConsent: null, textStopped: false, pushAvailable: false });
  });
  it('each kind is its own preference; only the exact shape is accepted, and push stays off', async () => {
    const prefs = defaultNotificationPreferences();
    const off = { ...prefs, notices: { ...prefs.notices, lab_result: { email: false, sms: false, push: false } } };
    const saved = await save(as.ava, off, 'America/Los_Angeles', 0) as { preferences: typeof prefs; version: number };
    expect(saved.preferences.notices.lab_result).toEqual({ email: false, sms: false, push: false });
    expect(saved.preferences.notices.message).toEqual({ email: true, sms: false, push: false });
    for (const bad of [
      { ...prefs, notices: { ...prefs.notices, marketing: { email: true, sms: false, push: false } } },
      { ...prefs, notices: { ...prefs.notices, message: { email: true, sms: false, push: true } } },
      { ...prefs, appointmentReminders: { email: true } },
      { ...prefs, contract: 'patient-notifications/2' },
    ]) expect(await refusal('clinical_core_api', as.ava, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(bad), null, 1])).toMatch(/notification_preferences_invalid/);
    for (const zone of ['EST', 'UTC+5', 'Not/AZone', 'america/new_york']) expect(await refusal('clinical_core_api', as.ava, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(prefs), zone, 1]), zone).toMatch(/time_zone_invalid/);
    expect(await refusal('clinical_core_api', as.ava, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(prefs), null, 0])).toMatch(/notification_settings_conflict/);
    await save(as.ava, prefs, 'America/Los_Angeles', 1);
  });
  it('a text preference cannot be turned on without consent at a number', async () => {
    expect(await refusal('clinical_core_api', as.ava, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(textsOn()), 'America/Los_Angeles', 2])).toMatch(/text_consent_required/);
  });
  it('only the patient themself reads or changes their settings; a workforce identity is refused', async () => {
    expect(await refusal('clinical_core_api', as.clinician, 'clinical_core.my_patient_notification_settings()')).toMatch(/notification_identity_refused/);
    expect(await refusal('clinical_core_api', as.owner, 'clinical_core.record_my_text_consent($1,$2,$3)', [AVA_PHONE, 'text-consent/1', sha(WORDING)])).toMatch(/notification_identity_refused/);
  });
});

describe('text consent', () => {
  it('needs an approved wording, recorded with its exact SHA-256; none exists until one is recorded', async () => {
    expect(await api(as.ava, 'clinical_core.current_text_consent_wording()')).toBeNull();
    expect(await refusal('clinical_core_api', as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', [AVA_PHONE, 'text-consent/1', sha(WORDING)])).toMatch(/text_consent_wording_unknown/);
    await db.query(`insert into clinical_core.patient_text_consent_wordings(version,body,sha256,approved_by,approved_at) values('text-consent/1',$1,$2,'FICTIONAL COUNSEL FIXTURE',now())`, [WORDING, sha(WORDING)]);
    expect(await db.query(`insert into clinical_core.patient_text_consent_wordings(version,body,sha256,approved_by,approved_at) values('text-consent/2',$1,$2,'x',now())`, [WORDING, sha('other')]).then(() => 'none', e => (e as Error).message)).toMatch(/check/);
    expect(await api(as.ava, 'clinical_core.current_text_consent_wording()')).toEqual({ version: 'text-consent/1', body: WORDING, sha256: sha(WORDING) });
    expect(await refusal('clinical_core_api', as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', [AVA_PHONE, 'text-consent/1', sha('a different wording')])).toMatch(/text_consent_wording_unknown/);
    expect(await refusal('clinical_core_api', as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', ['5555550101', 'text-consent/1', sha(WORDING)])).toMatch(/text_phone_invalid/);
  });
  it('records one number; turning texts on then works; a new number withdraws the old consent; rows cannot be rewritten', async () => {
    const view = await api<{ textConsent: { phone: string; wordingVersion: string; wordingSha256: string; source: string } }>(as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', [AVA_PHONE, 'text-consent/1', sha(WORDING)]);
    expect(view.textConsent).toMatchObject({ phone: AVA_PHONE, wordingVersion: 'text-consent/1', wordingSha256: sha(WORDING), source: 'patient_app' });
    await api(as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', [NEW_PHONE, 'text-consent/1', sha(WORDING)]);
    expect((await db.query(`select phone,withdrawn_by from clinical_core.patient_text_consents where person_id=$1 order by agreed_at,withdrawn_at nulls last`, [ava])).rows)
      .toEqual([{ phone: AVA_PHONE, withdrawn_by: 'number_changed' }, { phone: NEW_PHONE, withdrawn_by: null }]);
    expect(await db.query(`update clinical_core.patient_text_consents set phone=$1 where person_id=$2 and withdrawn_at is null`, [AVA_PHONE, ava]).then(() => 'none', e => (e as Error).message)).toMatch(/append_only_record/);
    expect(await db.query(`delete from clinical_core.patient_text_consents`).then(() => 'none', e => (e as Error).message)).toMatch(/append_only_record/);
    await api(as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', [AVA_PHONE, 'text-consent/1', sha(WORDING)]);
    const saved = await save(as.ava, textsOn(), 'America/Los_Angeles', 2) as { preferences: { notices: { message: { sms: boolean } } } };
    expect(saved.preferences.notices.message.sms).toBe(true);
  });
  it('withdrawing consent turns every text preference off', async () => {
    await api(as.ben, 'clinical_core.record_my_text_consent($1,$2,$3)', [BEN_PHONE, 'text-consent/1', sha(WORDING)]);
    await save(as.ben, textsOn(), 'America/New_York', 0);
    const after = await api<{ textConsent: unknown; preferences: ReturnType<typeof defaultNotificationPreferences> }>(as.ben, 'clinical_core.withdraw_my_text_consent()');
    expect(after.textConsent).toBeNull();
    expect(after.preferences).toEqual(defaultNotificationPreferences());
  });
});

describe('an item became visible', () => {
  it('while notices are disabled, every check still runs and nothing is stored', async () => {
    const msg = await message(avaConn, clinician, 'workforce');
    expect(await enqueue(as.clinician, 'message', { connectionId: avaConn, messageId: msg })).toEqual({ queued: false, reason: 'notices_disabled' });
    expect(await refusal('clinical_core_api', as.clinician, 'clinical_core.enqueue_patient_notice($1,$2::jsonb)', ['message', JSON.stringify({ connectionId: benConn, messageId: msg })])).toMatch(/notice_item_not_visible/);
    expect((await db.query('select count(*)::int n from clinical_core.patient_notice_events')).rows).toEqual([{ n: 0 }]);
  });
  it('is refused for anything the patient cannot see: their own message, a cancelled form, a result under review, a withdrawn program, an unreleased phase, a protocol', async () => {
    await activate(true, false);
    const own = await message(avaConn, ava, 'consumer');
    const cancelled = await packet(avaConn, avaRecord, 'cancelled');
    const pending = await observation(avaConn, avaRecord, 'review_pending');
    const withdrawn = await assignment(avaConn, ava, 'withdrawn');
    const active = await assignment(avaConn, ava, 'active');
    const cases: [string, Record<string, string>, RegExp][] = [
      ['message', { connectionId: avaConn, messageId: own }, /notice_item_not_visible/],
      ['form', { connectionId: avaConn, packetId: cancelled }, /notice_item_not_visible/],
      ['lab_result', { observationId: pending }, /notice_item_not_visible/],
      ['program_lesson', { enrollmentId: withdrawn }, /notice_item_not_visible/],
      ['program_lesson', { enrollmentId: active, phaseId: 'phase-2' }, /notice_item_not_visible/],
      ['protocol', { connectionId: avaConn, protocolId: id(999) }, /notice_source_unverifiable/],
      ['message', { connectionId: avaConn, messageId: 'not-a-uuid' }, /notice_request_invalid/],
      ['message', { connectionId: avaConn, messageId: own, title: 'x' }, /notice_request_invalid/],
      ['marketing', { connectionId: avaConn }, /notice_request_invalid/],
    ];
    for (const [kind, subject, expected] of cases) expect(await refusal('clinical_core_api', as.clinician, 'clinical_core.enqueue_patient_notice($1,$2::jsonb)', [kind, JSON.stringify(subject)]), kind + JSON.stringify(subject)).toMatch(expected);
    expect((await db.query('select count(*)::int n from clinical_core.patient_notice_events')).rows).toEqual([{ n: 0 }]);
  });
  it('is refused for another clinic\'s member, a consumer and anyone outside the clinic; a paused connection is skipped', async () => {
    const msg = await message(avaConn, clinician, 'workforce');
    expect(await refusal('clinical_core_api', as.outsider, 'clinical_core.enqueue_patient_notice($1,$2::jsonb)', ['message', JSON.stringify({ connectionId: avaConn, messageId: msg })])).toMatch(/notice_item_not_visible/);
    expect(await refusal('clinical_core_api', as.ava, 'clinical_core.enqueue_patient_notice($1,$2::jsonb)', ['message', JSON.stringify({ connectionId: avaConn, messageId: msg })])).toMatch(/notice_identity_refused/);
    const calMsg = await message(calConn, clinician, 'workforce');
    expect(await enqueue(as.clinician, 'message', { connectionId: calConn, messageId: calMsg })).toEqual({ queued: false, reason: 'connection_not_verified' });
  });
  it('queues each visible item once, for the right patient, keeping only a hash of the item', async () => {
    const msg = await message(avaConn, staff, 'workforce');
    expect(await enqueue(as.staff, 'message', { connectionId: avaConn, messageId: msg })).toEqual({ queued: true, duplicate: false });
    expect(await enqueue(as.staff, 'message', { connectionId: avaConn, messageId: msg })).toEqual({ queued: true, duplicate: true });
    expect(await enqueue(as.clinician, 'lab_result', { observationId: await observation(avaConn, avaRecord, 'accepted') })).toMatchObject({ queued: true });
    expect(await enqueue(as.clinician, 'message', { connectionId: avaConn, messageId: await message(avaConn, clinician, 'workforce') })).toMatchObject({ queued: true });
    expect(await enqueue(as.clinician, 'form', { connectionId: benConn, packetId: await packet(benConn, benRecord, 'open') })).toMatchObject({ queued: true });
    const program = await assignment(benConn, ben, 'active', 'phase-2');
    expect(await enqueue(as.clinician, 'program_lesson', { enrollmentId: program })).toMatchObject({ queued: true });
    expect(await enqueue(as.clinician, 'program_lesson', { enrollmentId: program, phaseId: 'phase-2' })).toMatchObject({ queued: true });
    const rows = (await db.query<{ person_id: string; kind: string; item_ref_sha256: string }>('select person_id,kind,item_ref_sha256 from clinical_core.patient_notice_events order by visible_at')).rows;
    expect(rows.map(r => [r.person_id, r.kind])).toEqual([[ava, 'message'], [ava, 'lab_result'], [ava, 'message'], [ben, 'form'], [ben, 'program_lesson'], [ben, 'program_lesson']]);
    expect(rows[0]!.item_ref_sha256).toBe(sha('message:' + msg));
    expect(rows[5]!.item_ref_sha256).toBe(sha(`program_lesson:${program}:phase-2`));
  });
});

describe('batching and delivery', () => {
  it('items close together make one notice per patient, each kind once, only after the window closes', async () => {
    expect(await worker('clinical_core.form_patient_notices(600,100)')).toEqual({ formed: 0 });
    await backdate(11);
    expect(await worker('clinical_core.form_patient_notices(600,100)')).toEqual({ formed: 2 });
    const notices = (await db.query<{ person_id: string; kinds: string[] }>('select person_id,kinds from clinical_core.patient_notices order by person_id')).rows;
    expect(notices).toEqual([{ person_id: ava, kinds: ['lab_result', 'message'] }, { person_id: ben, kinds: ['form', 'program_lesson'] }]);
    expect((await db.query('select count(*)::int n from clinical_core.patient_notice_events where notice_id is null')).rows).toEqual([{ n: 0 }]);
    // Texts are disabled, so only email deliveries exist, each naming the kinds its preference allows.
    expect((await db.query<{ channel: string; kinds: string[] }>('select d.channel,d.kinds from clinical_core.patient_notice_deliveries d join clinical_core.patient_notices n on n.id=d.notice_id order by n.person_id')).rows)
      .toEqual([{ channel: 'email', kinds: ['lab_result', 'message'] }, { channel: 'email', kinds: ['form', 'program_lesson'] }]);
    expect(await db.query('update clinical_core.patient_notices set kinds=$1', [['message']]).then(() => 'none', e => (e as Error).message)).toMatch(/append_only_record/);
  });
  it('nothing goes out for a clinic that has not recorded its name and help line; only an owner or admin may record them', async () => {
    expect(await worker<unknown[]>('clinical_core.due_patient_notice_deliveries(50)')).toEqual([]);
    expect((await db.query<{ reason: string }>(`select distinct reason from clinical_core.patient_notice_deliveries`)).rows).toEqual([{ reason: 'clinic_contact_missing' }]);
    expect(await refusal('clinical_core_api', as.staff, 'clinical_core.set_clinic_notification_contact($1,$2,$3)', ['Fictional Clinic', '+15555550100', 0])).toMatch(/clinic_contact_refused/);
    expect(await refusal('clinical_core_api', as.clinician, 'clinical_core.set_clinic_notification_contact($1,$2,$3)', ['Fictional Clinic', '+15555550100', 0])).toMatch(/clinic_contact_refused/);
    expect(await refusal('clinical_core_api', as.owner, 'clinical_core.set_clinic_notification_contact($1,$2,$3)', ['Fictional <b>Clinic</b>', '+15555550100', 0])).toMatch(/check/);
    expect(await api(as.owner, 'clinical_core.set_clinic_notification_contact($1,$2,$3)', ['Fictional Clinic', '+15555550100', 0])).toEqual({ displayName: 'Fictional Clinic', helpLine: '+15555550100', version: 1 });
  });
  it('hands out email after re-checking preferences; records sent, deferred and retry; three hand-outs without an outcome fail', async () => {
    const msg = await message(benConn, clinician, 'workforce');
    await enqueue(as.clinician, 'message', { connectionId: benConn, messageId: msg });
    await backdate(11);
    await worker('clinical_core.form_patient_notices(600,100)');
    // Ben turns message notices off after the notice formed: the delivery names only what he still wants.
    const prefs = defaultNotificationPreferences();
    await save(as.ben, { ...prefs, notices: { ...prefs.notices, message: { email: false, sms: false, push: false } } }, 'America/New_York', 2);
    const due = await worker<{ deliveryId: string; channel: string; kinds: string[]; clinicName: string; consumerSubject: string; phone: string | null }[]>('clinical_core.due_patient_notice_deliveries(50)');
    expect(due).toHaveLength(0);
    expect((await db.query(`select d.state,d.reason from clinical_core.patient_notice_deliveries d join clinical_core.patient_notices n on n.id=d.notice_id where n.kinds=array['message']`)).rows).toEqual([{ state: 'skipped', reason: 'preference_off' }]);

    await save(as.ben, prefs, 'America/New_York', 3);
    await enqueue(as.clinician, 'message', { connectionId: benConn, messageId: await message(benConn, clinician, 'workforce') });
    await backdate(11);
    await worker('clinical_core.form_patient_notices(600,100)');
    const [one] = await worker<{ deliveryId: string; channel: string; kinds: string[]; clinicName: string; consumerSubject: string; phone: string | null; attempt: number }[]>('clinical_core.due_patient_notice_deliveries(50)');
    expect(one).toMatchObject({ channel: 'email', kinds: ['message'], clinicName: 'Fictional Clinic', consumerSubject: as.ben.subject, phone: null, attempt: 1 });
    expect(await worker<unknown[]>('clinical_core.due_patient_notice_deliveries(50)')).toEqual([]); // leased
    expect(await refusal('patient_notification_worker', null, 'clinical_core.record_patient_notice_delivery($1,$2,$3,$4,$5)', [one!.deliveryId, 'sent', null, null, null])).toMatch(/notice_delivery_outcome_invalid/);
    expect(await worker('clinical_core.record_patient_notice_delivery($1,$2,$3,$4,$5)', [one!.deliveryId, 'sent', null, null, 'ses-message-fictional-0001'])).toEqual({ deliveryId: one!.deliveryId, state: 'sent', reason: null });
    expect(await refusal('patient_notification_worker', null, 'clinical_core.record_patient_notice_delivery($1,$2,$3,$4,$5)', [one!.deliveryId, 'sent', null, null, 'again'])).toMatch(/notice_delivery_not_sending/);

    await enqueue(as.clinician, 'message', { connectionId: benConn, messageId: await message(benConn, clinician, 'workforce') });
    await backdate(11);
    await worker('clinical_core.form_patient_notices(600,100)');
    let [two] = await worker<{ deliveryId: string }[]>('clinical_core.due_patient_notice_deliveries(50)');
    await worker('clinical_core.record_patient_notice_delivery($1,$2,$3,$4,$5)', [two!.deliveryId, 'retry', 'provider_unavailable', null, null]);
    expect((await db.query('select state,reason from clinical_core.patient_notice_deliveries where id=$1', [two!.deliveryId])).rows).toEqual([{ state: 'queued', reason: 'provider_unavailable' }]);
    for (let n = 0; n < 2; n++) {
      await fixture(`update clinical_core.patient_notice_deliveries set not_before=now()-interval '1 minute',lease_until=now()-interval '1 minute' where id=$1`, [two!.deliveryId]);
      [two] = await worker<{ deliveryId: string }[]>('clinical_core.due_patient_notice_deliveries(50)');
      expect(two, 'handout ' + (n + 2)).toBeDefined();
    }
    await fixture(`update clinical_core.patient_notice_deliveries set lease_until=now()-interval '1 minute' where id=$1`, [two!.deliveryId]);
    expect(await worker<unknown[]>('clinical_core.due_patient_notice_deliveries(50)')).toEqual([]);
    expect((await db.query('select state,reason,attempts from clinical_core.patient_notice_deliveries where id=$1', [two!.deliveryId])).rows).toEqual([{ state: 'failed', reason: 'attempts_exhausted', attempts: 3 }]);
  });
});

describe('texts: consent, quiet hours and STOP', () => {
  const textNotice = async () => {
    await enqueue(as.clinician, 'message', { connectionId: avaConn, messageId: await message(avaConn, clinician, 'workforce') });
    await backdate(11);
    await worker('clinical_core.form_patient_notices(600,100)');
  };
  const dueTexts = async () => (await worker<{ deliveryId: string; channel: string; phone: string | null; timeZone: string }[]>('clinical_core.due_patient_notice_deliveries(50)')).filter(d => d.channel === 'sms');

  it('with texts disabled no text delivery is even formed', async () => {
    await textNotice();
    expect((await db.query(`select count(*)::int n from clinical_core.patient_notice_deliveries where channel='sms'`)).rows).toEqual([{ n: 0 }]);
  });
  it('a text is handed out only inside 08:00 to 21:00 in the patient\'s own time zone, and carries the consented number', async () => {
    await activate(true, true);
    const night = zoneAtLocalHour(3), day = zoneAtLocalHour(12);
    const view = await settings(as.ava);
    await save(as.ava, textsOn(), night, view.version);
    await textNotice();
    expect(await dueTexts()).toEqual([]);
    expect((await db.query(`select state from clinical_core.patient_notice_deliveries where channel='sms'`)).rows).toEqual([{ state: 'queued' }]);
    await save(as.ava, textsOn(), day, view.version + 1);
    const [text] = await dueTexts();
    expect(text).toMatchObject({ phone: AVA_PHONE, timeZone: day });
    await worker('clinical_core.record_patient_notice_delivery($1,$2,$3,$4,$5)', [text!.deliveryId, 'sent', null, null, 'sms-message-fictional-0001']);
  });
  it('STOP suppresses the number at once, skips what was queued, and is idempotent on the inbound message', async () => {
    await textNotice();
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'stop', 'inbound-fictional-0001'])).toEqual({ outcome: 'stopped', duplicate: false, clinic: null });
    expect((await db.query(`select state,reason from clinical_core.patient_notice_deliveries where channel='sms' and state<>'sent'`)).rows).toEqual([{ state: 'skipped', reason: 'text_stopped' }]);
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'stop', 'inbound-fictional-0001'])).toEqual({ outcome: 'stopped', duplicate: true, clinic: null });
    expect(await refusal('patient_notification_worker', null, 'clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'start', 'inbound-fictional-0001'])).toMatch(/inbound_text_reused/);
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'stop', 'inbound-fictional-0002'])).toMatchObject({ outcome: 'already_stopped' });
    expect((await settings(as.ava)).textStopped).toBe(true);
    await textNotice();
    expect((await db.query(`select count(*)::int n from clinical_core.patient_notice_deliveries where channel='sms' and state in('queued','sending')`)).rows).toEqual([{ n: 0 }]);
    expect(await worker('clinical_core.patient_reminder_channels($1,$2)', [org, ava])).toEqual({ email: true, text: null, textReason: 'text_stopped' });
    expect((await db.query<{ n: number }>(`select count(*)::int n from clinical_core.patient_text_stops where phone_sha256=$1 and lifted_at is null`, [sha(AVA_PHONE)])).rows).toEqual([{ n: 1 }]);
  });
  it('HELP answers with the clinic of the number\'s consent, or the platform line for an unknown number; other words change nothing', async () => {
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'help', 'inbound-fictional-0003'])).toEqual({ outcome: 'help_clinic', duplicate: false, clinic: { displayName: 'Fictional Clinic', helpLine: '+15555550100' } });
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', ['+15555550177', 'help', 'inbound-fictional-0004'])).toEqual({ outcome: 'help_platform', duplicate: false, clinic: null });
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'other', 'inbound-fictional-0005'])).toMatchObject({ outcome: 'ignored' });
    expect((await settings(as.ava)).textStopped).toBe(true);
  });
  it('START lifts a STOP only where consent is on record at that number', async () => {
    await worker('clinical_core.record_inbound_text($1,$2,$3)', [BEN_PHONE, 'stop', 'inbound-fictional-0006']);
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [BEN_PHONE, 'start', 'inbound-fictional-0007'])).toMatchObject({ outcome: 'consent_required' });
    expect((await db.query<{ n: number }>(`select count(*)::int n from clinical_core.patient_text_stops where phone_sha256=$1 and lifted_at is null`, [sha(BEN_PHONE)])).rows).toEqual([{ n: 1 }]);
    expect(await worker('clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'start', 'inbound-fictional-0008'])).toMatchObject({ outcome: 'resumed' });
    expect((await settings(as.ava)).textStopped).toBe(false);
    expect(await db.query(`update clinical_core.patient_text_stops set lifted_at=null`).then(() => 'none', e => (e as Error).message)).toMatch(/append_only_record/);
  });
});

describe('text appointment reminders', () => {
  it('says which channels a reminder may use, and claims each reminder text once', async () => {
    const day = zoneAtLocalHour(12);
    expect(await worker('clinical_core.patient_reminder_channels($1,$2)', [org, ava])).toEqual({ email: true, text: { phone: AVA_PHONE, timeZone: (await settings(as.ava)).timeZone, clinicName: 'Fictional Clinic' }, textReason: null });
    expect(await worker('clinical_core.patient_reminder_channels($1,$2)', [org, ben])).toMatchObject({ email: true, text: null, textReason: 'preference_off' });
    expect(await worker('clinical_core.patient_reminder_channels($1,$2)', [otherOrg, ava])).toMatchObject({ text: null, textReason: 'connection_not_verified' });
    const ref = `appointment-reminder/2:${id(500)}:${id(501)}:24h`;
    expect(await worker('clinical_core.claim_patient_reminder_text($1,$2,$3,$4)', [ref, org, ava, AVA_PHONE])).toEqual({ claimed: true });
    expect(await worker('clinical_core.claim_patient_reminder_text($1,$2,$3,$4)', [ref, org, ava, AVA_PHONE])).toEqual({ claimed: false });
    expect(await worker('clinical_core.settle_patient_reminder_text($1,$2,$3,$4)', [ref, 'sent', null, 'sms-message-fictional-0002'])).toEqual({ state: 'sent' });
    expect(await refusal('patient_notification_worker', null, 'clinical_core.settle_patient_reminder_text($1,$2,$3,$4)', [ref, 'failed', 'x', null])).toMatch(/reminder_text_not_sending/);
    expect(await refusal('patient_notification_worker', null, 'clinical_core.claim_patient_reminder_text($1,$2,$3,$4)', ['free text', org, ava, AVA_PHONE])).toMatch(/reminder_request_invalid/);
    // Reminders by email are the patient's choice too.
    const view = await settings(as.ava);
    await save(as.ava, { ...textsOn(), appointmentReminders: { email: false, sms: true } }, day, view.version);
    expect(await worker('clinical_core.patient_reminder_channels($1,$2)', [org, ava])).toMatchObject({ email: false, textReason: null });
  });
});

describe('end to end through the SQL adapters: a committed action, one notice, STOP', () => {
  /** A ClinicalCoreDatabase whose every transaction runs as `role`, with database errors classified as the Data API adapter does. */
  const roleDatabase = (role: string): ClinicalCoreDatabase => ({ transaction: work => db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    return work({ query: async <Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
      try { return await tx.query<Row>(text, parameters.map(p => p && typeof p === 'object' && 'kind' in p && 'value' in p ? (p as { value: unknown }).value : p)); }
      catch (cause) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: (cause as Error).message }) ?? new ClinicalCoreDatabaseRejection('operation_refused'); }
    } });
  }) });
  const context = (who: Who) => ({ actorPersonId: who.person, organizationId: who.org, identityPool: who.pool, identitySubject: who.subject, purpose: 'clinical_data',
    environment: 'synthetic-staging', dataClassification: 'synthetic_only' }) as unknown as ClinicalRequestContext;
  const ledger = () => createSqlPatientNotificationLedger(roleDatabase('patient_notification_worker'));
  const addresses = new Map([[as.ava.subject, 'ava@fictional.example'], [as.ben.subject, 'ben@fictional.example']]);
  const directory = { emailFor: async (subject: string) => addresses.has(subject) ? { kind: 'address' as const, address: addresses.get(subject)!, suppressed: false } : { kind: 'unavailable' as const, reason: 'no_contact' as const } };
  const topic = 'arn:aws:sns:us-east-2:111122223333:fictional-inbound-texts';
  const inbound = (body: string, ref: string) => ({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: topic, Message: JSON.stringify({ originationNumber: AVA_PHONE, destinationNumber: '+15555550100', messageBody: body, inboundMessageId: ref }) } }] });

  it('the patient\'s own settings round-trip through the adapter; a workforce identity is refused before the database', async () => {
    const settingsApi = createSqlPatientNotificationSettings(roleDatabase('clinical_core_api'));
    const view = await settingsApi.read(context(as.ava));
    expect(view.textConsent?.phone).toBe(AVA_PHONE);
    await expect(settingsApi.read(context(as.clinician))).rejects.toThrow('identity_refused');
    await expect(settingsApi.save(context(as.ava), defaultNotificationPreferences(), 'Not/AZone', view.version)).rejects.toThrow('request_invalid');
    await settingsApi.save(context(as.ava), textsOn(), zoneAtLocalHour(12), view.version);
  });
  it('a message a clinician sends becomes one email and one text with fixed wording; a reply of STOP ends the texts', async () => {
    await db.query(`update clinical_core.patient_notice_deliveries set state='skipped',reason='fixture_reset' where state in('queued','sending')`);
    const reported: { kind: string; outcome: string }[] = [];
    const emit = createNoticeEmitter(createSqlNoticeEnqueuer(roleDatabase('clinical_core_api')), event => reported.push(event));
    const first = await message(avaConn, clinician, 'workforce');
    await emit(context(as.clinician), 'care_messages', { action: 'send', connectionId: avaConn }, { action: 'send', threadId: id(1), messageId: first, duplicate: false });
    // A consumer's own message and an item that is not visible produce nothing, and never throw.
    await emit(context(as.ava), 'care_messages', { action: 'send', connectionId: avaConn }, { action: 'send', threadId: id(1), messageId: first, duplicate: false });
    await emit(context(as.clinician), 'care_messages', { action: 'send', connectionId: benConn }, { action: 'send', threadId: id(1), messageId: first, duplicate: false });
    expect(reported).toEqual([{ kind: 'message', outcome: 'queued' }, { kind: 'message', outcome: 'identity_refused' }]);
    await backdate(11);
    const senders = createFictionalSenders();
    const dispatcher = createNoticeDispatcher({ ledger: ledger(), directory, email: senders.email, text: senders.text, origin: 'https://app.fictional.example' });
    const pass = await dispatcher.run();
    expect(pass).toMatchObject({ ok: true, formed: 1 });
    expect(senders.outbox.map(m => [m.channel, m.to])).toEqual([['email', 'ava@fictional.example'], ['sms', AVA_PHONE]]);
    expect(senders.outbox[1]!.body).toBe('Fictional Clinic: you have a new message waiting in AI Longevity Pro. Sign in to see it: https://app.fictional.example/sign-in Reply STOP to stop texts, HELP for help.');
    expect(JSON.stringify(senders.outbox)).not.toMatch(/Fictional body|Fictional thread/);

    const replies = createFictionalSenders();
    const handle = createInboundTextHandler({ ledger: ledger(), text: replies.text, topicArn: topic, sendingNumbers: ['+15555550100'], platformHelpLine: '+15555550199' });
    expect(await handle(inbound('Stop', 'inbound-fictional-e2e-01'))).toEqual({ results: [{ outcome: 'stopped', replied: true }] });
    expect(await handle(inbound('Stop', 'inbound-fictional-e2e-01'))).toEqual({ results: [{ outcome: 'stopped', replied: false }] });
    expect(replies.outbox).toHaveLength(1);

    await emit(context(as.clinician), 'care_messages', { action: 'send', connectionId: avaConn }, { action: 'send', threadId: id(1), messageId: await message(avaConn, clinician, 'workforce'), duplicate: false });
    await backdate(11);
    const after = createFictionalSenders();
    await createNoticeDispatcher({ ledger: ledger(), directory, email: after.email, text: after.text, origin: 'https://app.fictional.example' }).run();
    expect(after.outbox.map(m => m.channel)).toEqual(['email']);
    const reminders = createAppointmentTextReminders({ ledger: ledger(), text: after.text, origin: 'https://app.fictional.example' });
    expect(await reminders.channels(org, ava)).toEqual({ email: true, text: null, textReason: 'text_stopped' });
  });
});
