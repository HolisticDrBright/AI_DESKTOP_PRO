import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every switch off means no send of any kind: no campaign email, no confirmation, no consult email, no booked email,
 * no reminder schedule, no text and no notice, and nothing new for a visitor to see. Each piece is driven through its
 * real entry point with every external service faked at its SDK boundary, and the fakes must record nothing.
 * Fictional people only.
 */
const { sesSend, schedulerSend, dynamoSend } = vi.hoisted(() => ({ sesSend: vi.fn(), schedulerSend: vi.fn(), dynamoSend: vi.fn() }));
vi.mock('@aws-sdk/client-sesv2', async original => ({ ...await original<typeof import('@aws-sdk/client-sesv2')>(), SESv2Client: class SESv2Client { send = sesSend; } }));
vi.mock('@aws-sdk/client-scheduler', async original => ({ ...await original<typeof import('@aws-sdk/client-scheduler')>(), SchedulerClient: class SchedulerClient { send = schedulerSend; } }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({ ...await original<typeof import('@aws-sdk/lib-dynamodb')>(), DynamoDBDocumentClient: { from: () => ({ send: dynamoSend }) } }));
vi.mock('@aws-sdk/client-secrets-manager', async original => ({ ...await original<typeof import('@aws-sdk/client-secrets-manager')>(), SecretsManagerClient: class SecretsManagerClient { send = vi.fn(); } }));
vi.mock('@/server/consult/consultContactKey', () => ({ ConsultKeyError: class ConsultKeyError extends Error {}, createConsultContactKeyResolver: () => async () => Buffer.alloc(32, 7) }));
vi.mock('@/app/api/live/route-helpers', async original => ({ ...await original<typeof import('@/app/api/live/route-helpers')>(), liveGuard: () => null }));
vi.mock('@/server/session', () => ({ getRequestSession: async () => ({ token: 'fictional-workforce-token' }) }));

import { fictionalEngine } from '@/campaigns/testing';
import { allFunnels } from '@/funnels';
import { marketingSignupDirectory } from '@/funnels/marketingSignup';
import { funnelUpdatesUrl } from '@/lib/marketingSignupLink';
import { POST as joinRoute } from '@/app/api/public/campaigns/join/route';
import { POST as confirmRoute } from '@/app/api/public/campaigns/confirm/route';
import { POST as unsubscribeRoute } from '@/app/api/public/campaigns/unsubscribe/route';
import { POST as staffRoute } from '@/app/api/live/campaigns/route';
import { POST as consultRoute } from '@/app/api/public/consult/route';
import { createTelehealthHandler, type TelehealthConfiguration } from '@/server/clinical-core/aws-telehealth-requests';
import { FictionalAppointmentStore } from '@/server/clinical-core/appointment-operation-store.test-support';
import { identityNotificationPortsFrom, noticeDispatcherFrom, reminderTextPortFrom } from '@/server/notifications/notification-runtime';
import { patientNotificationSwitches, PATIENT_NOTIFICATION_SWITCH_NAMES } from '@/server/notifications/notification-switches';
import { outreachRows, readEngineStatus, readSignupPages } from '@/server/outreach-status';

const SITE = 'https://clinic.fictional.example', HOST = 'clinic.fictional.example';
const CLINICAL_PUBLIC_API = 'https://klmnopqrst.execute-api.us-east-2.amazonaws.com';
/** Every outreach switch, off as shipped (unset); the companions a switch needs are set, so only the switch keeps them off. */
const SWITCHES = ['CAMPAIGN_ENGINE_ENABLED', 'CONSULT_ENQUIRER_EMAILS_ENABLED', 'REMINDERS_ENABLED', ...PATIENT_NOTIFICATION_SWITCH_NAMES] as const;
const COMPANIONS = { CAMPAIGN_API_ORIGIN: 'https://abcdefghij.execute-api.us-east-2.amazonaws.com', FUNNEL_PRACTICE_SLUG: 'fictional-clinic', NEXT_PUBLIC_SITE_ORIGIN: SITE,
  CLINICAL_AWS_PUBLIC_API_ORIGIN: CLINICAL_PUBLIC_API, CONSULT_ENQUIRER_SENDER: 'Fictional Clinic <hello@clinic.fictional.example>', CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional',
  CONSULT_ENQUIRER_CONTACT_LINE: 'call (555) 010-0000 during office hours' };
const upstream = vi.fn();
const browser = (url: string, body: string, contentType = 'application/x-www-form-urlencoded') => new Request(url, { method: 'POST', body,
  headers: { host: HOST, origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': contentType } });

beforeEach(() => {
  for (const name of SWITCHES) vi.stubEnv(name, '');
  for (const [name, value] of Object.entries(COMPANIONS)) vi.stubEnv(name, value);
  sesSend.mockReset(); schedulerSend.mockReset(); dynamoSend.mockReset(); upstream.mockReset();
  // Only the clinical API's public consult intake answers; any other request is a send this test refuses to fake.
  upstream.mockImplementation(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== CLINICAL_PUBLIC_API) throw new Error(`unexpected request to ${url.origin}`);
    const request = JSON.parse(String(init.body)) as { action: string; slug: string };
    const data = request.action === 'describe'
      ? { action: 'describe', slug: request.slug, label: 'Fictional link', clinic: 'Fictional Clinic', visitTypes: ['initial'], reasonCodes: ['program_question'], acceptingRequests: true }
      : { action: 'submit', outcome: 'received', reference: 'ABCDEFGHJK', receivedAt: new Date().toISOString(), status: 'received' };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('every switch off means no send of any kind', () => {
  it('reads every switch as off', () => {
    expect(Object.values(patientNotificationSwitches(process.env)).some(Boolean)).toBe(false);
    for (const name of SWITCHES) expect(process.env[name], name).toBe('');
  });

  it('campaigns: every route is absent, no program page links to a sign-up page, and the engine itself sends nothing', async () => {
    expect((await joinRoute(browser(`${SITE}/api/public/campaigns/join`, 'practice=fictional-clinic&program=longevity-program&email=a%40fictional.example&consent=yes&formToken=x&website='))).status).toBe(404);
    expect((await confirmRoute(browser(`${SITE}/api/public/campaigns/confirm`, `t=${'A'.repeat(60)}`))).status).toBe(404);
    expect((await unsubscribeRoute(new Request(`${SITE}/api/public/campaigns/unsubscribe?t=${'A'.repeat(60)}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' }))).status).toBe(404);
    expect((await staffRoute(browser('https://x/api/live/campaigns', '{"action":"overview"}', 'application/json'))).status).toBe(404);
    for (const funnel of allFunnels()) expect(await funnelUpdatesUrl(funnel, marketingSignupDirectory(process.env), process.env), funnel.slug).toBeNull();
    // The engine's own switch (the stack's CampaignEngineEnabled), off: a sending pass sends nothing, and the public side refuses.
    const engine = fictionalEngine({ config: { enabled: false } });
    await engine.pass();
    await expect(engine.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email: 'a@fictional.example', consent: 'yes', formToken: 'x' })).rejects.toMatchObject({ category: 'disabled' });
    expect(engine.ses.outbox).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('the public consult route records the request and sends no email', async () => {
    const response = await consultRoute(browser(`${SITE}/api/public/consult`, JSON.stringify({ action: 'submit', slug: 'longevity-program-email', name: 'Avery Fictional', email: 'avery@fictional.example',
      phone: null, visitType: 'initial', reasonCode: 'program_question', preferredWindows: [], timeZone: 'America/Los_Angeles' }), 'application/json'));
    expect((await response.json()).data).toMatchObject({ outcome: 'received' });
    expect(upstream.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).action)).toEqual(['submit']);
    expect(sesSend).not.toHaveBeenCalled();
  });

  it('scheduling a visit sends no booked email and creates no reminder; the patient-notification ports are never built', async () => {
    const org = '22222222-2222-4222-8222-222222222222', request = '33333333-3333-4333-8333-333333333333';
    const config: TelehealthConfiguration = {
      tableName: 'synthetic-appointments', consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer', consumerAudience: 'consumer-client',
      workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce', workforceAudience: 'workforce-client', runtimeMode: 'synthetic', phiAllowed: false,
      zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: '', remindersEnabled: false, reminderSender: '', reminderConfigurationSet: '', reminderScheduleGroup: '',
      reminderSchedulerRoleArn: '', reminderTargetArn: '', reminderEventsTopicArn: '', stripeTestEnabled: false, stripeSecretArn: '', stripeSuccessUrl: '', stripeCancelUrl: '',
      identityApiOrigin: 'https://abcdefghij.execute-api.us-east-2.amazonaws.com', chartAdmissionSecretArn: 'arn:aws:secretsmanager:us-east-2:000000000000:secret:fictional-chart-admission',
    };
    const store = new FictionalAppointmentStore().seed({
      pk: `ORG#${org}`, sk: `REQ#2026-10-01T00:00:00.000Z#${request}`, gsi1pk: 'PERSON#11111111-1111-4111-8111-111111111111', gsi1sk: `REQ#2026-10-01T00:00:00.000Z#${request}`,
      requestId: request, organizationId: org, consumerPersonId: '11111111-1111-4111-8111-111111111111', consumerEmail: 'avery@fictional.example', status: 'requested', visitType: 'follow_up',
      preferredSlots: [], timeZone: 'America/Los_Angeles', note: null, scheduledStart: null, scheduledEnd: null, joinUrl: null, providerMeetingId: null, version: 1,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastActionBy: 'consumer', slotId: '55555555-5555-4555-8555-555555555555', appointmentId: null,
      priceMinor: 15000, currency: 'USD', cancellationPolicy: 'Cancel at least 24 hours before the visit.', cancellationWindowHours: 24, cancellationFeeDueMinor: 0, reminderStatus: 'disabled',
      paymentPolicyVersion: 'telehealth-payments/1', paymentAuthorizationStatus: 'not_authorized', paymentStatus: 'not_due', paymentIntentId: null, paidMinor: 0, refundedMinor: 0,
    });
    dynamoSend.mockImplementation(store.send);
    const start = new Date(Date.now() + 3 * 86_400_000);
    const claims = { iss: config.workforceIssuer, aud: config.workforceAudience, token_use: 'id', sub: 'synthetic-workforce-1234', 'custom:person_id': '99999999-9999-4999-8999-999999999999',
      'custom:organization_id': org, 'custom:synthetic_attested': 'true', 'custom:production_bound': 'false' };
    const reply = await createTelehealthHandler(config)({ routeKey: 'POST /clinical-core/workforce/appointments/actions', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: request, action: 'schedule', expectedVersion: 1, scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 2_700_000).toISOString(), timeZone: 'America/Los_Angeles' }),
      requestContext: { authorizer: { jwt: { claims } } } } as never);
    expect(reply.statusCode, reply.body).toBe(200);
    expect(JSON.parse(reply.body ?? '{}').data).toMatchObject({ reminderStatus: 'disabled' });
    expect(sesSend).not.toHaveBeenCalled();
    expect(schedulerSend).not.toHaveBeenCalled();

    const database = { transaction: () => { throw new Error('no database call is made with every switch off'); } };
    expect(identityNotificationPortsFrom(process.env, database as never)).toEqual({});
    expect(reminderTextPortFrom(process.env, { ledger: {} as never, text: null, origin: SITE })).toBeUndefined();
    expect(noticeDispatcherFrom(process.env, { ledger: {} as never, directory: {} as never, email: null, text: null, origin: SITE })).toBeNull();
  });

  it('the Outreach status screen reads nothing as on', async () => {
    const [engine, signup] = await Promise.all([readEngineStatus('fictional-workforce-token'), readSignupPages()]);
    const rows = outreachRows({ env: process.env, funnels: allFunnels(), engine, signup });
    expect(rows.filter(r => r.state === 'on').map(r => r.id)).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
  });
});
