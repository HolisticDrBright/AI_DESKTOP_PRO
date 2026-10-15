import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase } from '../clinical-core/database';
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from '../clinical-core/aws-identity-api';
import type { AwsSyntheticIdentityConsentAdapter } from '../clinical-core/aws-identity-consent';
import { createFictionalSenders } from './notification-providers';
import { identityNotificationPortsFrom, noticeDispatcherFrom, reminderTextPortFrom } from './notification-runtime';
import { PATIENT_NOTIFICATION_SWITCH_NAMES, patientNotificationSwitches } from './notification-switches';
import type { DeliveryOutcome, DueDelivery, PatientNotificationWorkerLedger } from './patient-notification-ledger';

/**
 * The four named switches. With every one off, nothing is built: the identity API gets exactly the inputs
 * it had before this work, the telehealth reminder handler gets no text port, and no dispatcher exists.
 * Fictional patients, addresses and numbers only.
 */
const ORIGIN = 'https://app.fictional.example';
const OFF = {} as const;
const NOON = new Date('2026-10-13T19:00:00Z');
const unusedDatabase = new Proxy({}, { get: () => { throw new Error('the database was touched'); } }) as ClinicalCoreDatabase;
const id = (n: number) => '7e000000-0000-4000-8000-' + String(n).padStart(12, '0');
const due: DueDelivery[] = [
  { deliveryId: id(1), channel: 'email', kinds: ['lab_result'], attempt: 1, clinicName: 'Fictional Clinic', consumerSubject: 'cn_fictional_ava_0001', timeZone: null, phone: null },
  { deliveryId: id(2), channel: 'sms', kinds: ['form'], attempt: 1, clinicName: 'Fictional Clinic', consumerSubject: 'cn_fictional_ava_0001', timeZone: 'America/Los_Angeles', phone: '+15555550101' },
];
function ledger() {
  const recorded: [string, DeliveryOutcome][] = [];
  const value: PatientNotificationWorkerLedger = {
    formNotices: vi.fn(async () => ({ formed: 1 })), dueDeliveries: vi.fn(async () => due),
    recordDelivery: vi.fn(async (deliveryId: string, outcome: DeliveryOutcome) => { recorded.push([deliveryId, outcome]); }),
    recordInbound: vi.fn(), reminderChannels: vi.fn(), claimReminderText: vi.fn(), settleReminderText: vi.fn(),
  };
  return { value, recorded };
}
const PERSON = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222', CONNECTION = '44444444-4444-4444-8444-444444444444';
const WORKFORCE_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', CONSUMER_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer';
const WORKFORCE_AUD = 'workforceclient000000000000', CONSUMER_AUD = 'consumerclient0000000000000';
const event = (routeKey: string, pool: 'workforce' | 'consumer', body: Record<string, unknown>): ApiGatewayV2Event => ({
  routeKey, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: { iss: pool === 'workforce' ? WORKFORCE_ISSUER : CONSUMER_ISSUER, aud: pool === 'workforce' ? WORKFORCE_AUD : CONSUMER_AUD,
    token_use: 'id', sub: 'synthetic-subject-001', 'custom:person_id': PERSON, 'custom:organization_id': ORG, 'custom:synthetic_attested': 'true', exp: Date.now() / 1000 + 60 } } } },
}) as ApiGatewayV2Event;
const directory = { emailFor: vi.fn(async () => ({ kind: 'address' as const, address: 'ava@fictional.example', suppressed: false })) };

describe('the switches', () => {
  it('are the four named settings, each on only for exactly "true"', () => {
    expect(PATIENT_NOTIFICATION_SWITCH_NAMES).toEqual(['PATIENT_NOTICES_ENABLED', 'SMS_NOTICES_ENABLED', 'SMS_REMINDERS_ENABLED', 'NOTIFICATION_PREFERENCES_ENABLED']);
    expect(Object.values(patientNotificationSwitches(OFF)).every(on => on === false)).toBe(true);
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'false', '', 'true-ish']) {
      expect(patientNotificationSwitches({ PATIENT_NOTICES_ENABLED: value }).PATIENT_NOTICES_ENABLED, value).toBe(false);
    }
    expect(patientNotificationSwitches({ PATIENT_NOTICES_ENABLED: ' true ' }).PATIENT_NOTICES_ENABLED).toBe(true);
  });
});

describe('every switch off builds nothing', () => {
  it('the identity API gets no emitter and no settings service, and the database is not touched', () => {
    expect(identityNotificationPortsFrom(OFF, unusedDatabase)).toEqual({});
  });
  it('so both settings routes answer 503 exactly as an identity API without this work would', async () => {
    const run = createAwsIdentityApiHandler({ adapter: {} as AwsSyntheticIdentityConsentAdapter, ...identityNotificationPortsFrom(OFF, unusedDatabase),
      configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD, consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD } });
    for (const [routeKey, pool, request] of [['POST /clinical-core/consumer/notifications/settings', 'consumer', { action: 'read' }],
      ['POST /clinical-core/workforce/notifications/settings', 'workforce', { action: 'read', connectionId: CONNECTION }]] as const) {
      const result = await run(event(routeKey, pool, request));
      expect(result.statusCode, routeKey).toBe(503);
      expect(JSON.parse(result.body ?? '{}')).toEqual({ error: 'service_unavailable' });
    }
  });
  it('the telehealth reminder handler gets no text port, and no sender is needed', () => {
    expect(reminderTextPortFrom(OFF, { ledger: ledger().value, text: null, origin: ORIGIN })).toBeUndefined();
  });
  it('no notice dispatcher exists, so nothing is formed, handed out or sent', () => {
    const l = ledger();
    expect(noticeDispatcherFrom(OFF, { ledger: l.value, directory, email: null, text: null, origin: ORIGIN })).toBeNull();
    expect(l.value.formNotices).not.toHaveBeenCalled();
  });
  it('the identity Lambda entry passes the environment through these functions and nothing else', () => {
    const entry = readFileSync('src/server/clinical-core/aws-identity-lambda.ts', 'utf8');
    expect(entry).toContain('...identityNotificationPortsFrom(process.env, database)');
    expect(entry).not.toMatch(/patientNotices\s*:|notificationSettings\s*:/);
  });
});

describe('each switch turns on only its own piece', () => {
  it('a notice switch adds the emitter only; the preferences switch adds the settings service only', () => {
    expect(Object.keys(identityNotificationPortsFrom({ PATIENT_NOTICES_ENABLED: 'true' }, unusedDatabase))).toEqual(['patientNotices']);
    expect(Object.keys(identityNotificationPortsFrom({ SMS_NOTICES_ENABLED: 'true' }, unusedDatabase))).toEqual(['patientNotices']);
    expect(Object.keys(identityNotificationPortsFrom({ NOTIFICATION_PREFERENCES_ENABLED: 'true' }, unusedDatabase))).toEqual(['notificationSettings']);
    expect(Object.keys(identityNotificationPortsFrom({ SMS_REMINDERS_ENABLED: 'true' }, unusedDatabase))).toEqual([]);
  });
  it('reminder texts on without a configured sender refuse loudly instead of running a path that cannot text', () => {
    expect(() => reminderTextPortFrom({ SMS_REMINDERS_ENABLED: 'true' }, { ledger: ledger().value, text: null, origin: ORIGIN })).toThrow('sms_reminders_configuration_invalid');
    const port = reminderTextPortFrom({ SMS_REMINDERS_ENABLED: 'true' }, { ledger: ledger().value, text: createFictionalSenders().text, origin: ORIGIN });
    expect(port && typeof port.sendText).toBe('function');
  });
  it('notice emails on and notice texts off: the email goes, the text is skipped and its sender never called', async () => {
    const senders = createFictionalSenders(); const text = vi.spyOn(senders.text, 'send'); const l = ledger();
    const dispatcher = noticeDispatcherFrom({ PATIENT_NOTICES_ENABLED: 'true' }, { ledger: l.value, directory, email: senders.email, text: senders.text, origin: ORIGIN, now: () => NOON });
    await dispatcher!.run();
    expect(senders.outbox.map(m => m.channel)).toEqual(['email']);
    expect(text).not.toHaveBeenCalled();
    expect(l.recorded.map(([, o]) => o)).toEqual([expect.objectContaining({ outcome: 'sent' }), { outcome: 'skipped', reason: 'channel_switched_off' }]);
  });
  it('notice texts on and notice emails off: the reverse, and the directory is never asked for an address', async () => {
    const senders = createFictionalSenders(); const email = vi.spyOn(senders.email, 'send'); const l = ledger();
    const lookups = { emailFor: vi.fn() };
    await noticeDispatcherFrom({ SMS_NOTICES_ENABLED: 'true' }, { ledger: l.value, directory: lookups, email: null, text: senders.text, origin: ORIGIN, now: () => NOON })!.run();
    expect(senders.outbox.map(m => m.channel)).toEqual(['sms']);
    expect(email).not.toHaveBeenCalled(); expect(lookups.emailFor).not.toHaveBeenCalled();
    expect(l.recorded[0]![1]).toEqual({ outcome: 'skipped', reason: 'channel_switched_off' });
  });
  it('a notice switch on without its sender refuses to build a dispatcher', () => {
    expect(() => noticeDispatcherFrom({ PATIENT_NOTICES_ENABLED: 'true' }, { ledger: ledger().value, directory, email: null, text: null, origin: ORIGIN })).toThrow('patient_notices_configuration_invalid');
    expect(() => noticeDispatcherFrom({ SMS_NOTICES_ENABLED: 'true' }, { ledger: ledger().value, directory, email: null, text: null, origin: ORIGIN })).toThrow('patient_notices_configuration_invalid');
  });
});
