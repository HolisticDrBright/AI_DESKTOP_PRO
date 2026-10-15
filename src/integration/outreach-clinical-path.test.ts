import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * The clinical side, end to end, with every external service faked at its SDK boundary: DynamoDB (the fictional
 * conditional appointment store), SES, EventBridge Scheduler, and End User Messaging (the notification providers'
 * fictional senders). Everything between is the real code: the telehealth handler's schedule, reschedule and cancel,
 * its reminder event with the patient's own channels, the BLOCKED patient-notifications candidate on the installed
 * migration chain (an embedded Postgres, called as the reduced roles), the inbound STOP handler, the identity API's
 * lab-review hook point, and the notice dispatcher. Fictional clinics, patients, addresses and numbers only.
 */
const { dynamoSend, sesSend, schedulerSend } = vi.hoisted(() => ({ dynamoSend: vi.fn(), sesSend: vi.fn(), schedulerSend: vi.fn() }));
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class DynamoDBClient {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: dynamoSend }) },
  GetCommand: class GetCommand { constructor(readonly input: unknown) {} },
  PutCommand: class PutCommand { constructor(readonly input: unknown) {} },
  QueryCommand: class QueryCommand { constructor(readonly input: unknown) {} },
  TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: unknown) {} },
  UpdateCommand: class UpdateCommand { constructor(readonly input: unknown) {} },
  DeleteCommand: class DeleteCommand { constructor(readonly input: unknown) {} },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class SecretsManagerClient { send = vi.fn(); },
  GetSecretValueCommand: class GetSecretValueCommand { constructor(readonly input: unknown) {} },
}));
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class SESv2Client { send = sesSend; },
  SendEmailCommand: class SendEmailCommand { constructor(readonly input: unknown) {} },
}));
vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class SchedulerClient { send = schedulerSend; },
  CreateScheduleCommand: class CreateScheduleCommand { constructor(readonly input: unknown) {} },
  DeleteScheduleCommand: class DeleteScheduleCommand { constructor(readonly input: unknown) {} },
  GetScheduleCommand: class GetScheduleCommand { constructor(readonly input: unknown) {} },
}));

import { createTelehealthHandler, type TelehealthConfiguration } from '@/server/clinical-core/aws-telehealth-requests';
import { FictionalAppointmentStore } from '@/server/clinical-core/appointment-operation-store.test-support';
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from '@/server/clinical-core/aws-identity-api';
import type { AwsSyntheticIdentityConsentAdapter } from '@/server/clinical-core/aws-identity-consent';
import { classifyDatabaseRejection } from '@/server/clinical-core/rds-data-database';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { defaultNotificationPreferences } from '@/contracts/patientNotifications';
import { PATIENT_NOTIFICATIONS_PARENTS, PATIENT_NOTIFICATIONS_SCHEMA_CANDIDATE_SHA256, createSqlNoticeEnqueuer, createSqlPatientNotificationLedger } from '@/server/notifications/patient-notification-ledger';
import { createAppointmentTextReminders, createInboundTextHandler, createNoticeDispatcher, createNoticeEmitter } from '@/server/notifications/notification-dispatcher';
import { createFictionalSenders } from '@/server/notifications/notification-providers';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (n: number) => '7e000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), owner = id(3), clinician = id(4), ava = id(10), avaRecord = id(20), avaConn = id(30), REQUEST = id(40);
const WORDING = 'FICTIONAL TEST WORDING: I agree to receive texts about my care from my clinic at this number. Reply STOP to stop, HELP for help.';
const AVA_PHONE = '+15555550101', AVA_EMAIL = 'ava@fictional.example', SENDING_NUMBER = '+15555550100';
const ORIGIN = 'https://app.fictional.example';
type Who = { person: string; org: string | null; pool: 'workforce' | 'consumer'; subject: string };
const as = {
  owner: { person: owner, org, pool: 'workforce', subject: 'wf_fictional_owner_01' },
  clinician: { person: clinician, org, pool: 'workforce', subject: 'wf_fictional_clinician_01' },
  ava: { person: ava, org: null, pool: 'consumer', subject: 'cn_fictional_ava_0001' },
} satisfies Record<string, Who>;

/* ---------------------------------------------------------------- the notification ledger on an embedded engine */
let db!: PGlite;
const fixture = async (sql: string, args: unknown[] = []) => db.transaction(async tx => { await tx.exec("set local session_replication_role = 'replica'"); await tx.query(sql, args); });
async function api<T = Record<string, unknown>>(who: Who, sql: string, args: unknown[] = []): Promise<T> {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [who.person, who.org, who.pool, who.subject, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
    return (await tx.query<{ r: T }>(`select (${sql}) as r`, args)).rows[0]!.r;
  });
}
/** A ClinicalCoreDatabase whose every transaction runs as `role`, with errors classified as the Data API adapter does. */
const roleDatabase = (role: string): ClinicalCoreDatabase => ({ transaction: work => db.transaction(async tx => {
  await tx.exec(`set local role ${role}`);
  return work({ query: async <Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
    try { return await tx.query<Row>(text, parameters.map(p => p && typeof p === 'object' && 'kind' in p && 'value' in p ? (p as { value: unknown }).value : p)); }
    catch (cause) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: (cause as Error).message }) ?? new ClinicalCoreDatabaseRejection('operation_refused'); }
  } });
}) });
const ledger = () => createSqlPatientNotificationLedger(roleDatabase('patient_notification_worker'));
/** A zone whose local hour is `hour` right now (Etc/GMT zones have whole-hour offsets, sign inverted). */
function zoneAtLocalHour(hour: number) {
  const utc = new Date().getUTCHours();
  for (let offset = -12; offset <= 14; offset++) if (((utc + offset) % 24 + 24) % 24 === hour) return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
  throw new Error('no zone');
}
const backdate = (minutes: number) => fixture('update clinical_core.patient_notice_events set visible_at=clock_timestamp()-make_interval(mins=>$1) where notice_id is null', [minutes]);
let seq = 100;
async function acceptedObservation() {
  const event = id(seq++), obs = id(seq++), provider = id(seq++);
  await fixture(`insert into clinical_core.sync_providers(id,organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state) values($1,$2,$3,'patient-sync/1','lab-result/1','1','pending_review')`, [provider, org, 'fictional_' + seq]);
  await fixture(`insert into clinical_core.lab_import_events(id,organization_id,patient_record_id,connection_id,provider_id,provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,marker_name,value_numeric,collected_at,occurred_at,payload_sha256,state,reviewed_at,reviewed_by_person_id)
    values($1,$2,$3,$4,$5,$6,'panel','marker','1','Fictional panel','Fictional marker',1,now(),now(),$7,'accepted',now(),$8)`, [event, org, avaRecord, avaConn, provider, 'evt_fictional_' + seq, 'a'.repeat(64), clinician]);
  await fixture(`insert into clinical_core.lab_observations(id,organization_id,patient_record_id,import_event_id,panel_name,marker_name,value_numeric,observed_at,provenance) values($1,$2,$3,$4,'Fictional panel','Fictional marker',1,now(),'{}')`, [obs, org, avaRecord, event]);
  return { event, obs };
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const dir = 'infra/aws-clinical-core/';
  for (const [file, digest] of Object.entries(PATIENT_NOTIFICATIONS_PARENTS)) expect(sha(readFileSync(dir + file, 'utf8')), file).toBe(digest);
  for (const { file } of (JSON.parse(readFileSync(dir + 'migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] }).migrations) await db.exec(readFileSync(dir + 'migrations/' + file, 'utf8'));
  const candidate = readFileSync(dir + 'source-candidates/patient-notifications.sql', 'utf8');
  expect(sha(candidate)).toBe(PATIENT_NOTIFICATIONS_SCHEMA_CANDIDATE_SHA256);
  await db.exec(candidate);
  await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [org, 'FICTIONAL outreach clinic']);
  for (const who of Object.values(as)) {
    await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [who.person, 'syn_' + who.subject]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)', [who.person, who.pool, who.subject]);
  }
  for (const [p, role] of [[owner, 'owner'], [clinician, 'practitioner']]) await db.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [org, p, role]);
  await db.query('insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)', [avaRecord, org, 'patient_syn_fictional_outreach_ava_01']);
  await db.query(`insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())`, [avaConn, org, avaRecord, ava]);
  // Approved wording (a fixture), Ava's consent at her number, texts on for reminders and notices, her day time zone.
  await db.query(`insert into clinical_core.patient_text_consent_wordings(version,body,sha256,approved_by,approved_at) values('text-consent/1',$1,$2,'FICTIONAL COUNSEL FIXTURE',now())`, [WORDING, sha(WORDING)]);
  await api(as.ava, 'clinical_core.record_my_text_consent($1,$2,$3)', [AVA_PHONE, 'text-consent/1', sha(WORDING)]);
  const base = defaultNotificationPreferences();
  const textsOn = { ...base, appointmentReminders: { email: true, sms: true }, notices: Object.fromEntries(Object.entries(base.notices).map(([k, v]) => [k, { ...v, sms: true }])) };
  const view = await api<{ version: number }>(as.ava, 'clinical_core.my_patient_notification_settings()');
  await api(as.ava, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(textsOn), zoneAtLocalHour(12), view.version]);
  await api(as.owner, 'clinical_core.set_clinic_notification_contact($1,$2,$3)', ['Fictional Clinic', SENDING_NUMBER, 0]);
  await db.query(`update clinical_core.patient_notification_activation set notices_enabled=true,texts_enabled=true,evidence_sha256=$1,reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`, ['e'.repeat(64)]);
}, 180_000);
afterAll(async () => { await db?.close(); });

/* ---------------------------------------------------------------- the telehealth handler with the text port */
const telehealth: TelehealthConfiguration = {
  tableName: 'synthetic-appointments', consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer', consumerAudience: 'consumer-client',
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce', workforceAudience: 'workforce-client', runtimeMode: 'synthetic', phiAllowed: false,
  zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: '', stripeTestEnabled: false, stripeSecretArn: '', stripeSuccessUrl: '', stripeCancelUrl: '',
  remindersEnabled: true, reminderSender: 'AI Longevity Pro <no-reply@ailongevitypro.app>', reminderConfigurationSet: 'alp-transactional', reminderScheduleGroup: 'fictional-reminders',
  reminderSchedulerRoleArn: 'arn:aws:iam::111122223333:role/fictional-reminders', reminderTargetArn: 'arn:aws:lambda:us-east-2:111122223333:function:fictional-telehealth',
  reminderEventsTopicArn: 'arn:aws:sns:us-east-2:111122223333:fictional-reminder-events',
  identityApiOrigin: 'https://abcdefghij.execute-api.us-east-2.amazonaws.com', chartAdmissionSecretArn: 'arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-chart-admission',
  enquirerEmailsEnabled: true, clinicDisplayName: 'Fictional Clinic',
};
const staffClaims = { iss: telehealth.workforceIssuer, aud: telehealth.workforceAudience, token_use: 'id', sub: 'synthetic-workforce-1234', email: 'staff@example.test',
  'custom:person_id': clinician, 'custom:organization_id': org, 'custom:synthetic_attested': 'true', 'custom:production_bound': 'false' };
const staffEvent = (body: Record<string, unknown>) => ({ routeKey: 'POST /clinical-core/workforce/appointments/actions', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: staffClaims } } } }) as never;
const appointmentRequest = () => ({
  pk: `ORG#${org}`, sk: `REQ#2026-10-01T00:00:00.000Z#${REQUEST}`, gsi1pk: `PERSON#${ava}`, gsi1sk: `REQ#2026-10-01T00:00:00.000Z#${REQUEST}`,
  requestId: REQUEST, organizationId: org, consumerPersonId: ava, consumerEmail: AVA_EMAIL, status: 'requested', visitType: 'follow_up',
  preferredSlots: [new Date(Date.now() + 3 * 86_400_000).toISOString()], timeZone: 'America/Los_Angeles', note: null, scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null,
  version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastActionBy: 'consumer', slotId: '55555555-5555-4555-8555-555555555555',
  appointmentId: null, priceMinor: 15000, currency: 'USD', cancellationPolicy: 'Cancel at least 24 hours before the visit.', cancellationWindowHours: 24,
  cancellationFeeDueMinor: 0, reminderStatus: 'disabled', paymentPolicyVersion: 'telehealth-payments/1', paymentAuthorizationStatus: 'not_authorized', paymentStatus: 'not_due',
  paymentIntentId: null, paidMinor: 0, refundedMinor: 0,
});
/** The slot Ava booked, as the booking left it (cancelling releases it). */
const bookedSlot = () => {
  const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
  return { pk: `ORG#${org}`, sk: `SLOT#${start}#55555555-5555-4555-8555-555555555555`, slotId: '55555555-5555-4555-8555-555555555555', organizationId: org, start,
    end: new Date(Date.parse(start) + 45 * 60_000).toISOString(), timeZone: 'America/Los_Angeles', visitTypes: ['follow_up'], priceMinor: 15000, currency: 'USD',
    cancellationPolicy: 'Cancel at least 24 hours before the visit.', cancellationWindowHours: 24, status: 'booked', heldBy: ava, holdId: null, holdExpiresAt: null,
    createdAt: '2026-10-01T00:00:00.000Z', createdBy: clinician };
};
type Command = { constructor: { name: string }; input: Record<string, unknown> };
const commands = (mock: typeof sesSend) => mock.mock.calls.map(([c]) => c as Command);
const emails = () => commands(sesSend).map(c => c.input as { Destination: { ToAddresses: string[] }; ConfigurationSetName: string; Content: { Simple: { Subject: { Data: string } } } });
const schedules = () => commands(schedulerSend).map(c => ({ op: c.constructor.name, name: String(c.input.Name), at: c.input.ScheduleExpression as string | undefined, input: (c.input.Target as { Input?: string } | undefined)?.Input }));
const data = (r: { statusCode: number; body?: string }) => { expect(r.statusCode, r.body).toBe(200); return JSON.parse(r.body ?? '{}').data; };

describe('the clinical path: booked, reminders, texts, STOP, quiet hours, lab notices', () => {
  let store: FictionalAppointmentStore;
  beforeEach(() => {
    sesSend.mockReset(); sesSend.mockResolvedValue({ MessageId: 'fictional-ses' });
    schedulerSend.mockReset(); schedulerSend.mockResolvedValue({});
  });

  it('booked email, reminders at 24 h and 1 h that move and go, a text only to the opted-in number, quiet hours, and STOP', async () => {
    store = new FictionalAppointmentStore().seed(appointmentRequest(), bookedSlot());
    dynamoSend.mockReset(); dynamoSend.mockImplementation(store.send);
    const texts = createFictionalSenders();
    const port = (now?: () => Date) => createAppointmentTextReminders({ ledger: ledger(), text: texts.text, origin: ORIGIN, ...(now ? { now } : {}) });
    const run = (now?: () => Date) => createTelehealthHandler(telehealth, { textReminders: port(now) });

    // 1. Staff schedule the request: the "booked" email, through alp-transactional; reminders at 24 h and 1 h before.
    const first = new Date(Date.now() + 3 * 86_400_000), firstEnd = new Date(first.getTime() + 45 * 60_000);
    const scheduled = data(await run()(staffEvent({ requestId: REQUEST, action: 'schedule', expectedVersion: 1, scheduledStart: first.toISOString(), scheduledEnd: firstEnd.toISOString(), timeZone: 'America/Los_Angeles' })));
    expect(emails().map(m => [m.Content.Simple.Subject.Data, m.Destination.ToAddresses[0], m.ConfigurationSetName])).toEqual([['Your consultation is booked', AVA_EMAIL, 'alp-transactional']]);
    const created = schedules().filter(s => s.op === 'CreateScheduleCommand');
    expect(created.map(s => [s.name.slice(-3), s.at])).toEqual([
      ['24h', `at(${new Date(first.getTime() - 86_400_000).toISOString().slice(0, 19)})`], ['-1h', `at(${new Date(first.getTime() - 3_600_000).toISOString().slice(0, 19)})`]]);
    const firstEvents = created.map(s => JSON.parse(s.input!));

    // 2. Rescheduling moves them: the old two are deleted, two new ones carry a new generation; the old event is stale.
    sesSend.mockClear(); schedulerSend.mockClear();
    const second = new Date(Date.now() + 26 * 3_600_000), secondEnd = new Date(second.getTime() + 45 * 60_000);
    const moved = data(await run()(staffEvent({ requestId: REQUEST, action: 'reschedule', expectedVersion: scheduled.version, scheduledStart: second.toISOString(), scheduledEnd: secondEnd.toISOString(), timeZone: 'America/Los_Angeles' })));
    expect(schedules().filter(s => s.op === 'DeleteScheduleCommand').map(s => s.name)).toEqual(created.map(s => s.name));
    const recreated = schedules().filter(s => s.op === 'CreateScheduleCommand');
    expect(recreated).toHaveLength(2);
    const [day24, hour1] = recreated.map(s => JSON.parse(s.input!));
    expect(day24.reminderGeneration).not.toBe(firstEvents[0].reminderGeneration);
    expect(emails().map(m => m.Content.Simple.Subject.Data)).toEqual(['Your consultation is booked']);
    sesSend.mockClear();
    expect(data(await run()(firstEvents[0]))).toEqual({ sent: false, reason: 'stale' });
    expect(sesSend).not.toHaveBeenCalled();

    // 3. Quiet hours: fired at the patient's 03:00, the email goes and the text waits; nothing is claimed.
    const night = () => new Date(Date.now() + 15 * 3_600_000);
    expect(data(await run(night)(day24))).toEqual({ sent: true, email: { sent: true }, text: { sent: false, reason: 'quiet_hours' } });
    expect(texts.outbox).toHaveLength(0);

    // 4. In the day: the email and one text, to the number she agreed at, with the fixed wording.
    expect(data(await run()(day24))).toEqual({ sent: true, email: { sent: true }, text: { sent: true } });
    expect(texts.outbox.map(m => [m.channel, m.to])).toEqual([['sms', AVA_PHONE]]);
    expect(texts.outbox[0]!.body).toMatch(/^Fictional Clinic: .*Reply STOP to stop texts, HELP for help\.$/);
    expect(texts.outbox[0]!.body).not.toMatch(/follow|15000|Cancel at least/i);

    // 5. STOP from that number: the next reminder is email only, and says why.
    const replies = createFictionalSenders();
    const inbound = createInboundTextHandler({ ledger: ledger(), text: replies.text, topicArn: 'arn:aws:sns:us-east-2:111122223333:fictional-inbound', sendingNumbers: [SENDING_NUMBER], platformHelpLine: '+15555550199' });
    expect(await inbound({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: 'arn:aws:sns:us-east-2:111122223333:fictional-inbound',
      Message: JSON.stringify({ originationNumber: AVA_PHONE, destinationNumber: SENDING_NUMBER, messageBody: 'STOP', inboundMessageId: 'inbound-fictional-outreach-01' }) } }] }))
      .toEqual({ results: [{ outcome: 'stopped', replied: true }] });
    expect(data(await run()(hour1))).toEqual({ sent: true, email: { sent: true }, text: { sent: false, reason: 'text_stopped' } });
    expect(texts.outbox).toHaveLength(1);

    // 6. Cancelling removes them: both schedules deleted, and a late event sends nothing on either channel.
    schedulerSend.mockClear(); sesSend.mockClear();
    data(await run()(staffEvent({ requestId: REQUEST, action: 'cancel', expectedVersion: moved.version })));
    expect(schedules().filter(s => s.op === 'DeleteScheduleCommand').map(s => s.name)).toEqual(recreated.map(s => s.name));
    sesSend.mockClear();
    expect(data(await run()(hour1))).toEqual({ sent: false, reason: 'stale' });
    expect(sesSend).not.toHaveBeenCalled();
    expect(texts.outbox).toHaveLength(1);
  }, 120_000);

  it('releasing a lab result makes one notice; three released together make one; a failed notice does not roll back the release', async () => {
    const WF_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WF_AUD = 'workforceclient000000000000';
    const claims = { iss: WF_ISSUER, aud: WF_AUD, token_use: 'id', sub: as.clinician.subject, 'custom:person_id': clinician, 'custom:organization_id': org, 'custom:synthetic_attested': 'true', exp: Date.now() / 1000 + 600 };
    const review = (eventId: string) => ({ routeKey: 'POST /clinical-core/workforce/lab-imports/review', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, decision: 'accept' }),
      requestContext: { authorizer: { jwt: { claims } } } }) as ApiGatewayV2Event;
    const reviewed: string[] = [];
    const observations = new Map<string, string>();
    // The clinical state adapter stands in for the committed review: the observation already exists as the accept would leave it.
    const state = { getConsumerConnection: vi.fn(), listLabImports: vi.fn(), listPatientLabObservations: vi.fn(), listDesktopPatients: vi.fn(), listDesktopLabDocuments: vi.fn(),
      importLabResult: vi.fn(), importLabResultV2: vi.fn(),
      reviewLabResult: vi.fn(async (_ctx: unknown, input: { eventId: string }) => { reviewed.push(input.eventId); return { eventId: input.eventId, state: 'accepted', observationId: observations.get(input.eventId), duplicate: false }; }) };
    const reported: { kind: string; outcome: string }[] = [];
    const handler = (patientNotices: unknown) => createAwsIdentityApiHandler({ adapter: {} as AwsSyntheticIdentityConsentAdapter, clinicalStateAdapter: state as never, patientNotices: patientNotices as never,
      configuration: { workforceIssuer: WF_ISSUER, workforceAudience: WF_AUD, consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', consumerAudience: 'consumerclient0000000000000' } });
    const emitting = handler(createNoticeEmitter(createSqlNoticeEnqueuer(roleDatabase('clinical_core_api')), event => reported.push(event)));
    const directory = { emailFor: async (subject: string) => subject === as.ava.subject ? { kind: 'address' as const, address: AVA_EMAIL, suppressed: false } : { kind: 'unavailable' as const, reason: 'no_contact' as const } };
    const pass = async () => {
      const senders = createFictionalSenders();
      await backdate(11);
      await createNoticeDispatcher({ ledger: ledger(), directory, email: senders.email, text: senders.text, origin: ORIGIN }).run();
      return senders.outbox;
    };
    await db.query(`update clinical_core.patient_notice_deliveries set state='skipped',reason='fixture_reset' where state in('queued','sending')`);
    // Ava's number is stopped (the reminder path above sent STOP; recorded again here so this test stands alone), so notices are email only.
    await db.transaction(async tx => { await tx.exec('set local role patient_notification_worker'); await tx.query('select clinical_core.record_inbound_text($1,$2,$3)', [AVA_PHONE, 'stop', 'inbound-fictional-outreach-02']); });

    // One release: one notice.
    const one = await acceptedObservation(); observations.set(one.event, one.obs);
    expect((await emitting(review(one.event))).statusCode).toBe(200);
    expect(reported).toEqual([{ kind: 'lab_result', outcome: 'queued' }]);
    const firstPass = await pass();
    expect(firstPass.map(m => [m.channel, m.to])).toEqual([['email', AVA_EMAIL]]);
    expect(JSON.stringify(firstPass)).not.toMatch(/Fictional panel|Fictional marker/);

    // Three releases close together: one notice.
    for (let n = 0; n < 3; n++) { const o = await acceptedObservation(); observations.set(o.event, o.obs); expect((await emitting(review(o.event))).statusCode).toBe(200); }
    expect(reported.filter(r => r.outcome === 'queued')).toHaveLength(4);
    expect((await pass()).map(m => m.channel)).toEqual(['email']);

    // A failing notice: the release is committed and answered exactly as with a working one.
    const failing = handler(createNoticeEmitter(async () => { throw new Error('notice store unavailable'); }));
    const last = await acceptedObservation(); observations.set(last.event, last.obs);
    const answer = await failing(review(last.event));
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body ?? '{}').data).toEqual({ eventId: last.event, state: 'accepted', observationId: last.obs, duplicate: false });
    expect(reviewed.at(-1)).toBe(last.event);
  }, 120_000);
});
