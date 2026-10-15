import { describe, expect, it, vi } from 'vitest';
import { defaultNotificationPreferences } from '@/contracts/patientNotifications';
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from '../clinical-core/aws-identity-api';
import type { AwsSyntheticIdentityConsentAdapter } from '../clinical-core/aws-identity-consent';
import { createNotificationSettingsService, type PatientSettingsPort } from './notification-settings-service';
import { PatientNotificationError } from './patient-notification-ledger';

/**
 * The two notification-settings routes on the identity API (synthetic boundary): unavailable is a 503, never
 * an empty set of choices; the patient's route takes only a patient, the clinic's only a clinic member, who
 * can read and never change; every refusal keeps its own status. Fictional people only.
 */
const PERSON = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222', CONNECTION = '44444444-4444-4444-8444-444444444444';
const WORKFORCE_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', CONSUMER_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer';
const WORKFORCE_AUD = 'workforceclient000000000000', CONSUMER_AUD = 'consumerclient0000000000000';
const PATIENT_ROUTE = 'POST /clinical-core/consumer/notifications/settings', CLINIC_ROUTE = 'POST /clinical-core/workforce/notifications/settings';
const event = (routeKey: string, pool: 'workforce' | 'consumer', body: Record<string, unknown>, claims: Record<string, unknown> = {}, query?: Record<string, string>): ApiGatewayV2Event => ({
  routeKey, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(query ? { queryStringParameters: query } : {}),
  requestContext: { authorizer: { jwt: { claims: { iss: pool === 'workforce' ? WORKFORCE_ISSUER : CONSUMER_ISSUER, aud: pool === 'workforce' ? WORKFORCE_AUD : CONSUMER_AUD,
    token_use: 'id', sub: 'synthetic-subject-001', 'custom:person_id': PERSON, 'custom:organization_id': ORG, 'custom:synthetic_attested': 'true', exp: Date.now() / 1000 + 60, ...claims } } } },
}) as ApiGatewayV2Event;
const view = { contract: 'patient-notifications/1' as const, preferences: defaultNotificationPreferences(), timeZone: 'America/Los_Angeles', version: 1, textConsent: null, textStopped: false, pushAvailable: false as const };
const clinicView = { contract: 'patient-notifications/1' as const, connectionId: CONNECTION, preferences: defaultNotificationPreferences(), timeZone: null, textConsent: null, textStopped: false, pushAvailable: false as const };
function setup(patient: Partial<PatientSettingsPort> = {}, withService = true) {
  const ports = { read: vi.fn(async () => view), wording: vi.fn(async () => null), save: vi.fn(async () => view), consent: vi.fn(async () => view), withdraw: vi.fn(async () => view), ...patient };
  const clinic = vi.fn(async () => clinicView);
  const run = createAwsIdentityApiHandler({ adapter: {} as AwsSyntheticIdentityConsentAdapter,
    configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD, consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD },
    ...(withService ? { notificationSettings: createNotificationSettingsService({ patient: ports as PatientSettingsPort, clinic }) } : {}) });
  return { run, ports, clinic };
}
const body = async (result: { body?: string }) => JSON.parse(result.body ?? '{}');

describe('the notification settings routes', () => {
  it('answer 503 when no settings service is installed: unavailable, never an empty set of choices', async () => {
    const t = setup({}, false);
    for (const [route, pool, request] of [[PATIENT_ROUTE, 'consumer', { action: 'read' }], [CLINIC_ROUTE, 'workforce', { action: 'read', connectionId: CONNECTION }]] as const) {
      const result = await t.run(event(route, pool, request));
      expect(result.statusCode, route).toBe(503);
      expect(await body(result)).toEqual({ error: 'service_unavailable' });
    }
  });
  it('serve the patient their own settings and each change they may make', async () => {
    const t = setup();
    expect(await body(await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'read' })))).toEqual({ data: { action: 'read', settings: view } });
    expect(await body(await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'wording' })))).toEqual({ data: { action: 'wording', wording: null } });
    await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'save', preferences: defaultNotificationPreferences(), timeZone: 'America/New_York', expectedVersion: 1 }));
    expect(t.ports.save).toHaveBeenCalledWith(expect.anything(), defaultNotificationPreferences(), 'America/New_York', 1);
    await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'consent', phone: '+15555550101', wordingVersion: 'text-consent/1', wordingSha256: 'a'.repeat(64) }));
    expect(t.ports.consent).toHaveBeenCalledWith(expect.anything(), '+15555550101', 'text-consent/1', 'a'.repeat(64));
    expect((await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'withdraw' }))).statusCode).toBe(200);
  });
  it('give a clinic member a read and nothing else', async () => {
    const t = setup();
    expect(await body(await t.run(event(CLINIC_ROUTE, 'workforce', { action: 'read', connectionId: CONNECTION })))).toEqual({ data: clinicView });
    for (const request of [{ action: 'save', connectionId: CONNECTION, preferences: defaultNotificationPreferences() }, { action: 'consent', connectionId: CONNECTION },
      { action: 'read', connectionId: 'not-a-uuid' }, { action: 'read' }]) {
      const result = await t.run(event(CLINIC_ROUTE, 'workforce', request));
      expect(result.statusCode, JSON.stringify(request)).toBe(400);
    }
    expect(t.clinic).toHaveBeenCalledTimes(1);
  });
  it('refuse the wrong pool, an expired token, a query string and a malformed request before any read', async () => {
    const t = setup();
    expect((await t.run(event(PATIENT_ROUTE, 'workforce', { action: 'read' }))).statusCode).toBe(403);
    expect((await t.run(event(CLINIC_ROUTE, 'consumer', { action: 'read', connectionId: CONNECTION }))).statusCode).toBe(403);
    expect((await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'read' }, { exp: 1 }))).statusCode).toBe(403);
    expect((await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'read' }, {}, { person: PERSON }))).statusCode).toBe(400);
    expect((await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'save', preferences: { ...defaultNotificationPreferences(), notices: {} }, timeZone: null, expectedVersion: 0 }))).statusCode).toBe(400);
    expect((await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'read', personId: PERSON }))).statusCode).toBe(400);
    expect(t.ports.read).not.toHaveBeenCalled();
  });
  it('keep each refusal\'s own status: consent required and stale versions are conflicts, an outage is an outage', async () => {
    for (const [category, status] of [['consent_required', 409], ['conflict', 409], ['request_invalid', 400], ['identity_refused', 403], ['service_unavailable', 503]] as const) {
      const t = setup({ save: vi.fn(async () => { throw new PatientNotificationError(category); }) });
      const result = await t.run(event(PATIENT_ROUTE, 'consumer', { action: 'save', preferences: defaultNotificationPreferences(), timeZone: null, expectedVersion: 0 }));
      expect([result.statusCode, await body(result)], category).toEqual([status, { error: category }]);
    }
  });
});
