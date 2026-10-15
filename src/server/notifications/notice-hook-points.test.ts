import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from '../clinical-core/aws-identity-api';
import type { AwsSyntheticIdentityConsentAdapter } from '../clinical-core/aws-identity-consent';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from '../clinical-core/database';
import { NOTICE_KINDS } from '@/contracts/patientNotifications';

/**
 * The hook points: the one place each kind of item becomes visible to the patient, where the identity API emits a
 * single internal "item released" event AFTER the action has committed and its reply is decided. Driven through the
 * real handler over a scripted database; fictional people only.
 *
 *   message         POST /clinical-core/workforce/messages          send (not a duplicate)
 *   form            POST /clinical-core/workforce/intake-packets    assign (packet open)
 *   program_lesson  POST /clinical-core/workforce/programs          assign, and release of a phase
 *   lab_result      POST /clinical-core/workforce/lab-imports/review accept (not a duplicate)
 *   protocol        none: refused by design until a source can prove approval for this patient
 */
const PERSON = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '44444444-4444-4444-8444-444444444444', ID = (n: number) => '5a000000-0000-4000-8000-' + String(n).padStart(12, '0');
const WORKFORCE_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', CONSUMER_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer';
const WORKFORCE_AUD = 'workforceclient000000000000', CONSUMER_AUD = 'consumerclient0000000000000';
const NOW = new Date().toISOString();
const event = (routeKey: string, body: Record<string, unknown>): ApiGatewayV2Event => ({
  routeKey, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: { iss: WORKFORCE_ISSUER, aud: WORKFORCE_AUD, token_use: 'id', sub: 'synthetic-subject-001',
    'custom:person_id': PERSON, 'custom:organization_id': ORG, 'custom:synthetic_attested': 'true', exp: Date.now() / 1000 + 60 } } } },
}) as ApiGatewayV2Event;

type Case = { kind: string; operation: string; route: string; body: Record<string, unknown>; reply: Record<string, unknown> };
const CASES: Case[] = [
  { kind: 'message', operation: 'care_messages', route: 'POST /clinical-core/workforce/messages',
    body: { action: 'send', requestId: ID(1), connectionId: CONNECTION, subject: 'Fictional subject', body: 'Fictional message body', acknowledgement: 'care-messages/1' },
    reply: { action: 'send', threadId: ID(2), messageId: ID(3), duplicate: false, status: 'stored', receivedAt: NOW } },
  { kind: 'form', operation: 'intake_packets_workforce', route: 'POST /clinical-core/workforce/intake-packets',
    body: { action: 'assign', connectionId: CONNECTION, label: 'Fictional intake', forms: [{ formVersionId: ID(4), required: true }] },
    reply: { action: 'assign', packetId: ID(5), status: 'open', revision: '1', items: [{ formVersionId: ID(4), formKey: 'fictional-intake', version: 1, kind: 'questionnaire', position: 1, contentSha256: 'a'.repeat(64) }] } },
  { kind: 'program_lesson', operation: 'program_assignments', route: 'POST /clinical-core/workforce/programs',
    body: { action: 'release', enrollmentId: ID(6), phaseId: 'phase-2' },
    reply: { action: 'release', enrollmentId: ID(6), phaseId: 'phase-2' } },
];
function handler(reply: unknown, patientNotices: ReturnType<typeof vi.fn>, order: string[]) {
  const query = vi.fn(async (sql: string) => { if (!/set_request_context/.test(sql)) order.push('commit'); return { rows: [{ data: reply }] }; });
  const database: ClinicalCoreDatabase = { transaction: work => work({ query: query as ClinicalCoreTransaction['query'] }) };
  return createAwsIdentityApiHandler({ database, adapter: {} as AwsSyntheticIdentityConsentAdapter, patientNotices: patientNotices as never,
    configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD, consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD } });
}

describe('each kind emits one "item released" event at its hook point, after the commit', () => {
  for (const c of CASES) {
    it(`${c.kind}: ${c.route} ${String(c.body.action)}`, async () => {
      const order: string[] = [];
      const emit = vi.fn(async () => { order.push('emit'); });
      const result = await handler(c.reply, emit, order)(event(c.route, c.body));
      expect(result.statusCode, result.body).toBe(200);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0]!.slice(1)).toEqual([c.operation, c.body, c.reply]);
      expect(order.indexOf('emit')).toBeGreaterThan(order.lastIndexOf('commit'));
    });
    it(`${c.kind}: a failing emitter changes nothing about the reply`, async () => {
      const ok = await handler(c.reply, vi.fn(async () => {}), [])(event(c.route, c.body));
      const failing = await handler(c.reply, vi.fn(async () => { throw new Error('enqueue unavailable'); }), [])(event(c.route, c.body));
      expect(failing.statusCode).toBe(200);
      expect(failing.body).toBe(ok.body);
    });
  }
  it('lab_result: accepting a lab import, through the clinical state adapter', async () => {
    const order: string[] = [];
    const emit = vi.fn(async () => { order.push('emit'); });
    const reply = { eventId: ID(7), state: 'accepted', observationId: ID(8), duplicate: false };
    const state = { getConsumerConnection: vi.fn(), listLabImports: vi.fn(), listPatientLabObservations: vi.fn(), listDesktopPatients: vi.fn(),
      listDesktopLabDocuments: vi.fn(), importLabResult: vi.fn(), importLabResultV2: vi.fn(),
      reviewLabResult: vi.fn(async () => { order.push('commit'); return reply; }) };
    const run = createAwsIdentityApiHandler({ adapter: {} as AwsSyntheticIdentityConsentAdapter, clinicalStateAdapter: state as never, patientNotices: emit as never,
      configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD, consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD } });
    const body = { eventId: ID(7), decision: 'accept' };
    const result = await run(event('POST /clinical-core/workforce/lab-imports/review', body));
    expect(result.statusCode, result.body).toBe(200);
    expect(emit.mock.calls.map(call => call.slice(1))).toEqual([['review_lab', body, reply]]);
    expect(order).toEqual(['commit', 'emit']);
    const failing = createAwsIdentityApiHandler({ adapter: {} as AwsSyntheticIdentityConsentAdapter, clinicalStateAdapter: state as never,
      patientNotices: vi.fn(async () => { throw new Error('enqueue unavailable'); }) as never,
      configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD, consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD } });
    const after = await failing(event('POST /clinical-core/workforce/lab-imports/review', body));
    expect(after.statusCode).toBe(200);
    expect(after.body).toBe(result.body);
  });
  it('without an emitter (every switch off) the same actions answer exactly the same', async () => {
    for (const c of CASES) {
      const withEmitter = await handler(c.reply, vi.fn(async () => {}), [])(event(c.route, c.body));
      const query = vi.fn(async () => ({ rows: [{ data: c.reply }] }));
      const without = await createAwsIdentityApiHandler({ database: { transaction: work => work({ query: query as ClinicalCoreTransaction['query'] }) },
        adapter: {} as AwsSyntheticIdentityConsentAdapter,
        configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD, consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD } })(event(c.route, c.body));
      expect(without.statusCode, c.kind).toBe(withEmitter.statusCode);
      expect(without.body, c.kind).toBe(withEmitter.body);
    }
  });
  it('protocol has no hook point: the only activation is on the production path, and the candidate refuses protocol notices', () => {
    expect(NOTICE_KINDS).toContain('protocol');
    const api = readFileSync('src/server/clinical-core/aws-identity-api.ts', 'utf8');
    expect(api.match(/await notify\(/g)?.length).toBe(4);
    const sql = readFileSync('infra/aws-clinical-core/source-candidates/patient-notifications.sql', 'utf8');
    expect(sql).toContain('notice_source_unverifiable');
  });
});
