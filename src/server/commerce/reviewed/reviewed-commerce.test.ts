import { LEARNER_MEDIA_ROUTE_SEAM } from '../../programs/learner-media';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '../program-commerce-activation';
import { EDUCATION_ACCESS_ROUTE_SEAM } from '../education-access-service';
import { EDUCATION_PROGRESS_ROUTE_SEAM } from '../education-progress-service';
import { REVIEWED_COMMERCE_CANDIDATES, commerceFlagsOn, commerceReadiness, programCommerceHostTarget, sealingKeyFromEnvironment } from './commerce-host-target';
import { CommerceTargetRefused, commerceHostTargetFromEnvironment, readCommerceHostTargetFile, verifyCommerceTargetBytes } from './commerce-host-target-source';
import { PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256 } from './commerce-role-sessions';
import { createKeyedClaimSealer, createSesClaimDeliveryProvider, createStripePurchaserContactAuthority } from './commerce-connectors';
import { createReviewedEducationApiHandler, REVIEWED_EDUCATION_API_ROUTES } from './education-api';
import { createReviewedCommerceWorkerHandler } from './commerce-worker-entry';
import { signInCallback, signInStart, signOut, CALLBACK_PATH } from '../../learner/consumer-signin';
import { CONSUMER_ACCESS_COOKIE, CONSUMER_ID_COOKIE, CONSUMER_SIGNIN_COOKIE, createReviewedLearnerHost, type ReviewedLearnerRuntime } from '../../learner/reviewed-learner-host';

const decided = <T>(value: T) => ({ state: 'decided' as const, value, decidedBy: 'FICTIONAL REVIEW FIXTURE', decidedAt: '2026-10-12T00:00:00Z', evidenceSha256: 'd'.repeat(64) });
const secret = (name: string) => `arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional/${name}-AbCdEf`;
const target = (over: Record<string, unknown> = {}) => ({
  contract: 'program-commerce-host-target/1', execution: 'qualification', account: '588966314750', region: 'us-east-2', phiAllowed: false, productionActivation: 'blocked',
  sourceCommit: 'a'.repeat(40), hostReviewSha256: 'b'.repeat(64),
  database: { clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', databaseName: 'clinical_core_qualification', sessions: {
    api: { secretArn: secret('api'), login: 'program_commerce_api_runtime' }, worker: { secretArn: secret('worker'), login: 'program_commerce_worker_runtime' },
    delivery: { secretArn: secret('delivery'), login: 'program_commerce_delivery_runtime' }, operator: { secretArn: secret('operator'), login: 'program_commerce_operator_runtime' },
  } },
  consumer: { poolId: 'us-east-2_FictionalPool1', clientId: 'fictionalclient1', signInOrigin: 'https://fictional-learners.auth.us-east-2.amazoncognito.com', desktopOrigin: 'https://clinic.fictional.example' },
  activation: { contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-12T00:00:00Z' },
  candidates: { ...REVIEWED_COMMERCE_CANDIDATES },
  processor: { mode: 'test', accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil', priceRefs: ['price_FictionalAccept01'] },
  delivery: { provider: 'ses', region: 'us-east-2', fromAddress: 'courses@fictional.example', configurationSet: null, messageIdDomain: 'mail.fictional.example' },
  sealing: { keyRef: 'claim-sealer:fictional/v1' },
  decisions: { purchaserContactAuthority: decided('payment_processor_collected_email'), claimCodeLifetimeDays: decided(7), staffProgressVisibility: { state: 'held' }, storefrontClassification: { state: 'held' } },
  ...over,
});
const FLAGS = { PROGRAM_COMMERCE_QUALIFICATION_ENABLED: 'true', PHI_ALLOWED: 'false', PRODUCTION_ACTIVATION: 'blocked' };
const STRIPE = { STRIPE_TEST_MODE_ENABLED: '1', STRIPE_TEST_SECRET_KEY: 'sk_test_FictionalKey01', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_FictionalSecret01', STRIPE_TEST_ACCOUNT_ID: 'acct_FictionalAccount1', STRIPE_API_VERSION_PINNED: '2025-08-27.basil', PROGRAM_COMMERCE_CLAIM_SEALING_KEY: randomBytes(32).toString('base64') };
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

describe('the host target', () => {
  it('pins the runtime-sessions successor to its file, and every candidate to its own pin', () => {
    expect(sha(readFileSync('infra/aws-clinical-core/source-candidates/program-commerce-runtime-sessions.sql'))).toBe(PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256);
    expect(REVIEWED_COMMERCE_CANDIDATES.runtimeSessions).toBe(PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256);
    expect(programCommerceHostTarget.safeParse(target()).success).toBe(true);
  });
  it('the sessions successor is BLOCKED, outside the manifest, and grants membership only (no login, no password)', () => {
    const text = readFileSync('infra/aws-clinical-core/source-candidates/program-commerce-runtime-sessions.sql', 'utf8');
    expect(text).toMatch(/^-- BLOCKED source candidate/);
    expect(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')).not.toContain('program-commerce-runtime-sessions');
    const statements = text.replace(/--.*$/gm, '');
    expect(statements).not.toMatch(/\blogin\b(?!\s*noinherit)|password|grant\s+(select|insert|update|delete|execute|all)/i);
    expect(statements.match(/\bnologin\b/g)).toHaveLength(4);
  });
  it.each([
    ['a production account', { account: '111111111111' }],
    ['PHI', { phiAllowed: true }],
    ['an unblocked activation', { productionActivation: 'allowed' }],
    ['a production database', { database: { ...target().database, databaseName: 'clinical_core' } }],
    ['a shared secret', { database: { ...target().database, sessions: { ...target().database.sessions, worker: { secretArn: secret('api'), login: 'program_commerce_worker_runtime' } } } }],
    ['a swapped login', { database: { ...target().database, sessions: { ...target().database.sessions, worker: { secretArn: secret('worker'), login: 'program_commerce_api_runtime' } } } }],
    ['a candidate mismatch', { candidates: { ...REVIEWED_COMMERCE_CANDIDATES, education: 'f'.repeat(64) } }],
    ['live processor mode', { processor: { ...target().processor, mode: 'live' } }],
    ['duplicate price ids', { processor: { ...target().processor, priceRefs: ['price_FictionalAccept01', 'price_FictionalAccept01'] } }],
    ['a localhost desktop', { consumer: { ...target().consumer, desktopOrigin: 'https://localhost' } }],
    ['a non-Cognito sign-in host', { consumer: { ...target().consumer, signInOrigin: 'https://login.fictional.example' } }],
    ['a sealing key in the target', { sealing: { keyRef: 'claim-sealer:fictional/v1', key: 'AAAA' } }],
    ['a decision without evidence', { decisions: { ...target().decisions, claimCodeLifetimeDays: { state: 'decided', value: 7, decidedBy: 'x', decidedAt: '2026-10-12T00:00:00Z' } } }],
    ['a code lifetime past the bound', { decisions: { ...target().decisions, claimCodeLifetimeDays: decided(90) } }],
    ['an unknown field', { extra: true }],
  ])('refuses %s', (_name, over) => {
    expect(programCommerceHostTarget.safeParse(target(over)).success).toBe(false);
  });
  it('readiness: closed by default; each missing input is named; reading never needs the processor', () => {
    const parsed = programCommerceHostTarget.parse(target());
    expect(commerceReadiness(null, {})).toEqual({ learner: { enabled: false, holds: ['flags_off', 'target_unavailable'] }, purchasing: { enabled: false, holds: ['flags_off', 'target_unavailable'] }, worker: { enabled: false, holds: ['flags_off', 'target_unavailable'] } });
    expect(commerceReadiness(parsed, { ...FLAGS })).toMatchObject({ learner: { enabled: true, holds: [] }, purchasing: { enabled: false, holds: ['stripe_credentials_missing', 'stripe_account_mismatch', 'stripe_api_version_mismatch', 'sealing_key_missing'] } });
    expect(commerceReadiness(parsed, { ...FLAGS, ...STRIPE })).toMatchObject({ learner: { enabled: true }, purchasing: { enabled: true, holds: [] }, worker: { enabled: true } });
    for (const flags of [{}, { ...FLAGS, PHI_ALLOWED: 'true' }, { ...FLAGS, PRODUCTION_ACTIVATION: 'allowed' }, { ...FLAGS, PRODUCTION_WORKLOAD_MODE: 'readiness_only' }, { ...FLAGS, CLINICAL_CONTRACT_FIXTURE: '1' }]) {
      expect(commerceFlagsOn(flags)).toBe(false);
    }
    expect(sealingKeyFromEnvironment({ PROGRAM_COMMERCE_CLAIM_SEALING_KEY: randomBytes(16).toString('base64') })).toBeNull();
    expect(sealingKeyFromEnvironment({ PROGRAM_COMMERCE_CLAIM_SEALING_KEY: 'not base64!' })).toBeNull();
  });
});

describe('the target source: the pinned bytes, re-read and re-checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alp-commerce-target-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = JSON.stringify(target());
  const env = { PROGRAM_COMMERCE_HOST_TARGET_SHA256: sha(bytes), PROGRAM_COMMERCE_SOURCE_COMMIT: 'a'.repeat(40) };
  it('accepts exactly the pinned bytes for the pinned commit', async () => {
    writeFileSync(join(dir, 'target.json'), bytes);
    expect((await readCommerceHostTargetFile(env, new AbortController().signal, join(dir, 'target.json'))).contract).toBe('program-commerce-host-target/1');
    expect(commerceHostTargetFromEnvironment({ ...env, PROGRAM_COMMERCE_HOST_TARGET_JSON: bytes }).contract).toBe('program-commerce-host-target/1');
  });
  it('refuses another digest, another commit, no pin, a link, a missing file and an aborted read', async () => {
    writeFileSync(join(dir, 'target.json'), bytes);
    const reason = async (work: Promise<unknown>) => { try { await work; return 'accepted'; } catch (error) { return error instanceof CommerceTargetRefused ? error.reason : 'other'; } };
    expect(await reason(readCommerceHostTargetFile({ ...env, PROGRAM_COMMERCE_HOST_TARGET_SHA256: 'f'.repeat(64) }, new AbortController().signal, join(dir, 'target.json')))).toBe('target_digest_mismatch');
    expect(await reason(readCommerceHostTargetFile({ ...env, PROGRAM_COMMERCE_SOURCE_COMMIT: 'c'.repeat(40) }, new AbortController().signal, join(dir, 'target.json')))).toBe('source_commit_mismatch');
    expect(await reason(readCommerceHostTargetFile({ PROGRAM_COMMERCE_SOURCE_COMMIT: 'a'.repeat(40) }, new AbortController().signal, join(dir, 'target.json')))).toBe('target_pin_missing');
    symlinkSync(join(dir, 'target.json'), join(dir, 'link.json'));
    expect(await reason(readCommerceHostTargetFile(env, new AbortController().signal, join(dir, 'link.json')))).toBe('target_unreadable');
    expect(await reason(readCommerceHostTargetFile(env, new AbortController().signal, join(dir, 'absent.json')))).toBe('target_unreadable');
    const aborted = new AbortController(); aborted.abort();
    expect(await reason(readCommerceHostTargetFile(env, aborted.signal, join(dir, 'target.json')))).toBe('aborted');
    const tampered = JSON.stringify(target({ processor: { ...target().processor, priceRefs: ['price_SomethingElse01'] } }));
    expect(() => verifyCommerceTargetBytes(new TextEncoder().encode(tampered), env)).toThrow(CommerceTargetRefused);
    expect(() => commerceHostTargetFromEnvironment(env)).toThrow(CommerceTargetRefused);
  });
});

describe('connectors', () => {
  it('SES: one deterministic Message-ID per delivery key, a definite refusal is refused, anything else is an unknown outcome', async () => {
    const sent: SendEmailCommand[] = [];
    let fault: string | null = null;
    const provider = createSesClaimDeliveryProvider({ send: async command => { if (fault) throw Object.assign(new Error('x'), { name: fault }); sent.push(command); return { MessageId: 'ses-1' }; }, fromAddress: 'courses@fictional.example', configurationSet: 'fictional-set', messageIdDomain: 'mail.fictional.example' });
    const message = { idempotencyKey: 'claim-delivery:abc', to: 'purchaser@fictional.example', subject: 'Your access code', text: 'code\nline' };
    expect(await provider.send(message)).toEqual({ outcome: 'accepted', providerRef: 'ses-1' });
    expect(await provider.send(message)).toEqual({ outcome: 'accepted', providerRef: 'ses-1' });
    const ids = sent.map(command => /^Message-ID: (.+)$/m.exec(new TextDecoder().decode(command.input.Content!.Raw!.Data!))![1]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(`<${sha('claim-delivery:abc').slice(0, 40)}@mail.fictional.example>`);
    expect(sent[0]!.input.ConfigurationSetName).toBe('fictional-set');
    fault = 'MessageRejected';
    expect(await provider.send(message)).toEqual({ outcome: 'refused', detail: 'MessageRejected' });
    fault = 'TimeoutError';
    await expect(provider.send(message)).rejects.toThrow();
    fault = null;
    expect(await provider.send({ ...message, to: 'a@b\r\nBcc: x@y.example' })).toEqual({ outcome: 'refused', detail: 'message_refused' });
    expect(await provider.send({ ...message, subject: 'Your access code\r\nBcc: x@y.example' })).toEqual({ outcome: 'refused', detail: 'message_refused' });
  });
  it('purchaser contact: only the processor-held email of the order\'s OWN test-mode session', async () => {
    const order = { orderId: '11111111-1111-4111-8111-111111111111', processor: { sessionRef: 'cs_test_fictional12345' } };
    let object: Record<string, unknown> = { id: 'cs_test_fictional12345', livemode: false, client_reference_id: order.orderId, metadata: { order_id: order.orderId }, customer_details: { email: 'purchaser@fictional.example' } };
    let status = 200;
    const contacts = createStripePurchaserContactAuthority({ secretKey: 'sk_test_FictionalKey01', apiVersion: '2025-08-27.basil', orders: { readOrder: async id => (id === order.orderId ? order as never : null) }, fetch: async () => new Response(JSON.stringify(object), { status, headers: { 'content-type': 'application/json' } }) });
    expect(await contacts.contactFor(order.orderId)).toEqual({ kind: 'address', address: 'purchaser@fictional.example', authority: 'payment_processor' });
    object = { ...object, client_reference_id: '22222222-2222-4222-8222-222222222222' };
    expect(await contacts.contactFor(order.orderId)).toEqual({ kind: 'unavailable', reason: 'no_contact' });
    object = { ...object, client_reference_id: order.orderId, livemode: true };
    expect(await contacts.contactFor(order.orderId)).toEqual({ kind: 'unavailable', reason: 'no_contact' });
    object = { ...object, livemode: false, customer_details: { email: 'not an address' } };
    expect(await contacts.contactFor(order.orderId)).toEqual({ kind: 'unavailable', reason: 'no_contact' });
    status = 503;
    expect(await contacts.contactFor(order.orderId)).toEqual({ kind: 'unavailable', reason: 'service_unavailable' });
    expect(await contacts.contactFor('33333333-3333-4333-8333-333333333333')).toEqual({ kind: 'unavailable', reason: 'no_contact' });
    expect(() => createStripePurchaserContactAuthority({ secretKey: 'sk_live_FictionalKey01', apiVersion: 'x', orders: { readOrder: async () => null }, fetch: async () => new Response() })).toThrow();
  });
  it('the keyed sealer opens only what it sealed under its own reference', async () => {
    const key = randomBytes(32);
    const sealer = createKeyedClaimSealer(key, 'claim-sealer:fictional/v1');
    const sealed = await sealer.seal('fictional-code', 'claim-1');
    expect(await sealer.unseal(sealed, 'claim-1')).toBe('fictional-code');
    await expect(sealer.unseal(sealed, 'claim-2')).rejects.toThrow();
    await expect(createKeyedClaimSealer(key, 'claim-sealer:fictional/v2').unseal(sealed, 'claim-1')).rejects.toThrow();
    expect(() => createKeyedClaimSealer(key, 'fictional-sealer:x')).toThrow();
  });
});

describe('the consumer education API and the worker are closed by default', () => {
  it('the route seams are served by the reviewed education API, never by the identity API', () => {
    // The learner media seam (program-learner-media/1) is the third route of the same function, named here so the table stays exact.
    expect(REVIEWED_EDUCATION_API_ROUTES).toEqual([EDUCATION_ACCESS_ROUTE_SEAM.route, EDUCATION_PROGRESS_ROUTE_SEAM.route, LEARNER_MEDIA_ROUTE_SEAM.route]);
    for (const path of ['src/server/clinical-core/aws-identity-api.ts', 'scripts/check-aws-authenticated-api.mjs', 'infra/aws-clinical-core/identity-api-extension.json']) {
      expect(readFileSync(path, 'utf8'), path).not.toContain('consumer/education');
    }
  });
  it('without flags or a verified target nothing is read, verified or composed', async () => {
    const event = { routeKey: EDUCATION_ACCESS_ROUTE_SEAM.route, headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' }, body: '{"action":"access"}' };
    expect((await createReviewedEducationApiHandler({ env: {} })(event)).statusCode).toBe(503);
    expect((await createReviewedEducationApiHandler({ env: { ...FLAGS } })(event)).statusCode).toBe(503);
    expect((await createReviewedEducationApiHandler({ env: { ...FLAGS, PROGRAM_COMMERCE_HOST_TARGET_JSON: JSON.stringify(target()) } })(event)).statusCode).toBe(503);
    expect(await createReviewedCommerceWorkerHandler({ env: {} })()).toEqual({ ran: false, reason: 'flags_off' });
    expect(await createReviewedCommerceWorkerHandler({ env: { ...FLAGS } })()).toEqual({ ran: false, reason: 'target_unavailable' });
    const held = programCommerceHostTarget.parse(target());
    expect(await createReviewedCommerceWorkerHandler({ env: { ...FLAGS }, target: () => held })()).toMatchObject({ ran: false, reason: 'worker_held', holds: expect.arrayContaining(['stripe_credentials_missing', 'sealing_key_missing']) });
  });
});

describe('the Desktop consumer sign-in', () => {
  const learner = (verify: ReviewedLearnerRuntime['verify']): ReviewedLearnerRuntime => ({ verify, services: () => { throw new Error('unused'); }, consumer: target().consumer });
  const verified = async () => ({ state: 'verified' as const, context: {} as never });
  it('without the reviewed runtime every step answers that no host exists', async () => {
    expect(signInStart(null).status).toBe(503);
    expect((await signInCallback(new Request('https://clinic.fictional.example' + CALLBACK_PATH), null)).status).toBe(503);
  });
  it('start: PKCE S256 with a fresh state bound to this browser; nothing from the request', () => {
    const response = signInStart(learner(verified));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(target().consumer.signInOrigin);
    expect(location.pathname).toBe('/oauth2/authorize');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ response_type: 'code', client_id: 'fictionalclient1', redirect_uri: 'https://clinic.fictional.example' + CALLBACK_PATH, code_challenge_method: 'S256' });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(new RegExp(`^${CONSUMER_SIGNIN_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{64}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$`));
    const [state, verifier] = cookie.split(';')[0]!.split('=')[1]!.split('.');
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier!).digest('base64url'));
  });
  const callback = (query: string, cookie: string | null) => new Request(`https://clinic.fictional.example${CALLBACK_PATH}?${query}`, { headers: cookie ? { cookie } : {} });
  const bound = () => { const start = signInStart(learner(verified)); return { cookie: start.headers.get('set-cookie')!.split(';')[0]!, state: new URL(start.headers.get('location')!).searchParams.get('state')! }; };
  const tokenReply = () => new Response(JSON.stringify({ id_token: 'id.token.sig', access_token: 'acc.token.sig', refresh_token: 'never.kept.here', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  it('callback: a matched state, the code exchanged with the verifier, and cookies set only for a VERIFIED session (no refresh token kept)', async () => {
    const { cookie, state } = bound();
    let exchanged: URLSearchParams | null = null;
    const response = await signInCallback(callback(`code=fictional-code&state=${state}`, cookie), learner(verified), async (url, init) => { expect(url).toBe(target().consumer.signInOrigin + '/oauth2/token'); exchanged = new URLSearchParams(String(init.body)); return tokenReply(); });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://clinic.fictional.example/courses');
    expect(exchanged!.get('code_verifier')).toBe(cookie.split('=')[1]!.split('.')[1]);
    expect(exchanged!.get('client_secret')).toBeNull();
    const cookies = response.headers.getSetCookie();
    expect(cookies).toContain(`${CONSUMER_ID_COOKIE}=id.token.sig; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
    expect(cookies).toContain(`${CONSUMER_ACCESS_COOKIE}=acc.token.sig; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
    expect(cookies.join(' ')).not.toContain('never.kept.here');
    expect(cookies.some(value => value.startsWith(`${CONSUMER_SIGNIN_COOKIE}=;`))).toBe(true);
  });
  it('callback refuses a mismatched or missing state, an unverified token and an unreachable token endpoint, and stores nothing', async () => {
    const { cookie, state } = bound();
    const never = async () => { throw new Error('must not exchange'); };
    for (const [query, jar] of [[`code=c&state=${'x'.repeat(43)}`, cookie], [`code=c&state=${state}`, null], [`code=c`, cookie]] as const) {
      const response = await signInCallback(callback(query, jar), learner(verified), never);
      expect(response.headers.get('location')).toBe('https://clinic.fictional.example/courses?signin=refused');
      expect(response.headers.getSetCookie().join(' ')).not.toContain(CONSUMER_ID_COOKIE + '=i');
    }
    const refused = await signInCallback(callback(`code=c&state=${state}`, cookie), learner(async () => ({ state: 'refused', reason: 'claims_refused' })), async () => tokenReply());
    expect(refused.headers.get('location')).toBe('https://clinic.fictional.example/courses?signin=refused');
    expect(refused.headers.getSetCookie().some(value => value.startsWith(CONSUMER_ID_COOKIE + '=id'))).toBe(false);
    const down = await signInCallback(callback(`code=c&state=${state}`, cookie), learner(verified), async () => new Response('no', { status: 500 }));
    expect(down.headers.get('location')).toBe('https://clinic.fictional.example/courses?signin=unavailable');
  });
  it('sign-out revokes everywhere and clears the cookies even when the identity service cannot confirm it', async () => {
    const request = new Request('https://clinic.fictional.example/api/my-courses/session/signout', { method: 'POST', headers: { cookie: `${CONSUMER_ID_COOKIE}=i.d.t; ${CONSUMER_ACCESS_COOKIE}=a.c.t` } });
    const revoked: string[] = [];
    const ok = await signOut(request, async token => { revoked.push(token); });
    expect(revoked).toEqual(['a.c.t']);
    expect(await ok.json()).toEqual({ data: { signedOut: true, revocationConfirmed: true } });
    expect(ok.headers.getSetCookie().filter(value => /Max-Age=0$/.test(value))).toHaveLength(3);
    const failed = await signOut(request, async () => { throw new Error('down'); });
    expect(await failed.json()).toEqual({ data: { signedOut: true, revocationConfirmed: false } });
    expect(failed.headers.getSetCookie().filter(value => /Max-Age=0$/.test(value))).toHaveLength(3);
  });
  it('the reviewed learner host: no runtime is no identity and an error, a refused session is null, an unreachable one is an error', async () => {
    const request = new Request('https://clinic.fictional.example/api/my-courses', { headers: { cookie: `${CONSUMER_ID_COOKIE}=i.d.t; ${CONSUMER_ACCESS_COOKIE}=a.c.t` } });
    await expect(createReviewedLearnerHost(async () => null).identify(request)).rejects.toThrow('learner_identity_unavailable');
    expect(await createReviewedLearnerHost(async () => learner(async () => ({ state: 'refused', reason: 'session_revoked' }))).identify(request)).toBeNull();
    await expect(createReviewedLearnerHost(async () => learner(async () => ({ state: 'unavailable' }))).identify(request)).rejects.toThrow('learner_identity_unavailable');
    let seen: unknown = 'unset';
    await createReviewedLearnerHost(async () => learner(async tokens => { seen = tokens; return { state: 'refused', reason: 'token_invalid' }; })).identify(new Request('https://clinic.fictional.example/api/my-courses'));
    expect(seen).toBeNull();
  });
});
