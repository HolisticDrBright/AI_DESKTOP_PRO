import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ConsumerSessionVerifier } from '../learner/consumer-session';
import { CONSUMER_ACCESS_COOKIE, CONSUMER_ID_COOKIE, __resetReviewedLearner } from '../learner/reviewed-learner-host';
import { __resetLearnerHost } from '../learner/learner-host';
import { __resetReviewedPurchasing } from '../commerce/program-commerce-runtime';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '../commerce/program-commerce-activation';
import { REVIEWED_COMMERCE_CANDIDATES, programCommerceHostTarget, type ProgramCommerceHostTarget } from '../commerce/reviewed/commerce-host-target';
import { bootstrapReviewedCommerce } from '../commerce/reviewed/reviewed-bootstrap';
import { createReviewedEducationApiHandler, CONSUMER_ACCESS_TOKEN_HEADER } from '../commerce/reviewed/education-api';
import { createPgliteRdsDataClient } from '../commerce/reviewed/pglite-rds-data.test-support';
import { POST as myCoursesRoute } from '../../app/api/my-courses/route';
import { learnerMediaReply, PROGRAM_LEARNER_MEDIA_CONTRACT } from '@/contracts/programLearnerMedia';
import type { ProgramLessonMediaReference } from '@/contracts/programLessonMedia';
import { PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256 } from './learner-media';
import { createFictionalLearnerMediaStorage } from './learner-media-fictional';
import { openLearnerMediaWorld, type Bought, type LearnerMediaWorld } from '@/test-support/learnerMediaWorld';

/**
 * The learner media read through the REVIEWED runtime as a deployment would compose it: the pinned
 * host target (with and without its learner-media section), the consumer education API function and
 * the Desktop My courses route behind the reviewed learner host the bootstrap installs, the SQL
 * adapter over the fake Data API under the API login only, and the fictional storage reader.
 * Identity is a stand-in verifier (signature verification is covered by the purchase-to-course
 * test); it supports revocation, which is what this test needs. Source evidence only.
 */
const ORIGIN = 'https://clinic.fictional.example';
const secretArn = (name: string) => `arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional/program-commerce/${name}-AbCdEf`;
const LOGINS = {
  [secretArn('api')]: 'program_commerce_api_runtime', [secretArn('worker')]: 'program_commerce_worker_runtime',
  [secretArn('delivery')]: 'program_commerce_delivery_runtime', [secretArn('operator')]: 'program_commerce_operator_runtime',
};
const ENV: Record<string, string> = { APP_EDITION: 'clinical', PROGRAM_COMMERCE_QUALIFICATION_ENABLED: 'true', PHI_ALLOWED: 'false', PRODUCTION_ACTIVATION: 'blocked', CLINICAL_CONTRACT_FIXTURE: '0' };
const learnerMedia = {
  candidate: PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256,
  storage: { bucket: 'alp-fictional-lessons', expectedBucketOwner: '588966314750', region: 'us-east-2', kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/7c000000-0000-4000-8000-000000000099',
    readerRoleArn: 'arn:aws:iam::588966314750:role/alp-fictional-lesson-reader', forbiddenBuckets: ['alp-fictional-recordings'], forbiddenKmsKeyArns: ['arn:aws:kms:us-east-2:588966314750:key/7c000000-0000-4000-8000-000000000098'] },
  evidenceSha256: 'c'.repeat(64),
};
const target = (withMedia: boolean): ProgramCommerceHostTarget => programCommerceHostTarget.parse({
  contract: 'program-commerce-host-target/1', execution: 'qualification', account: '588966314750', region: 'us-east-2', phiAllowed: false, productionActivation: 'blocked',
  sourceCommit: 'a'.repeat(40), hostReviewSha256: 'b'.repeat(64),
  database: { clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-qualification', databaseName: 'clinical_core_qualification', sessions: {
    api: { secretArn: secretArn('api'), login: 'program_commerce_api_runtime' }, worker: { secretArn: secretArn('worker'), login: 'program_commerce_worker_runtime' },
    delivery: { secretArn: secretArn('delivery'), login: 'program_commerce_delivery_runtime' }, operator: { secretArn: secretArn('operator'), login: 'program_commerce_operator_runtime' },
  } },
  consumer: { poolId: 'us-east-2_FictionalPool1', clientId: 'fictionalclient1', signInOrigin: 'https://fictional-learners.auth.us-east-2.amazoncognito.com', desktopOrigin: ORIGIN },
  activation: { contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-13T00:00:00Z' },
  candidates: { ...REVIEWED_COMMERCE_CANDIDATES },
  processor: { mode: 'test', accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil', priceRefs: [] },
  delivery: { provider: 'ses', region: 'us-east-2', fromAddress: 'courses@fictional.example', configurationSet: null, messageIdDomain: 'mail.fictional.example' },
  sealing: { keyRef: 'claim-sealer:fictional-qualification/v1' },
  decisions: { purchaserContactAuthority: { state: 'held' }, claimCodeLifetimeDays: { state: 'held' }, staffProgressVisibility: { state: 'held' }, storefrontClassification: { state: 'held' } },
  ...(withMedia ? { learnerMedia } : {}),
});

let w: LearnerMediaWorld;
let a: Bought, video: { reference: ProgramLessonMediaReference };
type Tokens = { idToken: string; accessToken: string };
const sessions = new Map<string, { person: string; subject: string; revoked: boolean }>();
const signIn = (person: string, subject: string): Tokens => { const t = { idToken: randomBytes(24).toString('base64url'), accessToken: randomBytes(24).toString('base64url') }; sessions.set(t.accessToken, { person, subject, revoked: false }); return t; };
const revoke = (subject: string) => { for (const [key, s] of sessions) if (s.subject === subject) sessions.set(key, { ...s, revoked: true }); };
const verifier: ConsumerSessionVerifier = async tokens => {
  const s = tokens ? sessions.get(tokens.accessToken) : undefined;
  if (!s || s.revoked) return { state: 'refused', reason: 'session_revoked' } as never;
  return { state: 'verified', context: { actorPersonId: s.person, organizationId: w.ids.org, identityPool: 'consumer', identitySubject: s.subject, purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false } };
};
let rds: ReturnType<typeof createPgliteRdsDataClient>;
const handler = (withMedia: boolean, storage = createFictionalLearnerMediaStorage()) =>
  createReviewedEducationApiHandler({ env: ENV, target: () => target(withMedia), runtimeInputs: { rdsClient: rds, consumerSessions: verifier, learnerMediaStorage: storage } });
const body = (itemId = 'lesson-a') => ({ contractVersion: PROGRAM_LEARNER_MEDIA_CONTRACT, entitlementId: a.entitlementId, curriculum: a.curriculum, lesson: { phaseId: 'phase-1', itemId }, slot: 0,
  expected: { artifactId: video.reference.artifactId, version: video.reference.version, sha256: video.reference.sha256 } });
async function v2(api: ReturnType<typeof handler>, tokens: Tokens | null, payload: unknown) {
  const response = await api({ routeKey: 'POST /clinical-core/consumer/education/media', headers: { 'content-type': 'application/json', ...(tokens ? { authorization: `Bearer ${tokens.idToken}`, [CONSUMER_ACCESS_TOKEN_HEADER]: tokens.accessToken } : {}) }, body: JSON.stringify(payload) });
  return { status: response.statusCode, json: JSON.parse(response.body) as { data?: unknown; error?: { code: string } } };
}
async function desktop(tokens: Tokens | null, payload: unknown) {
  const cookie = tokens ? `${CONSUMER_ID_COOKIE}=${tokens.idToken}; ${CONSUMER_ACCESS_COOKIE}=${tokens.accessToken}` : '';
  const response = await myCoursesRoute(new Request(`${ORIGIN}/api/my-courses`, { method: 'POST', headers: { host: 'clinic.fictional.example', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ service: 'media', body: payload }) }));
  return { status: response.status, json: await response.json() as { data?: unknown; host?: string; error?: { code: string } } };
}

beforeAll(async () => {
  w = await openLearnerMediaWorld();
  const { ids } = w;
  video = await w.publishVideo(ids.author, ids.org, ids.program, 'reviewed');
  const published = await w.publishVersion(ids.program, ids.org, w.phasesWith([w.lesson('lesson-a', { nativeMedia: [video.reference] })]));
  expect(published.refused).toBe('none');
  const me = { personId: ids.author, organizationId: ids.org };
  const created = await w.offers.execute(me, { action: 'create', programId: ids.program, terms: { mode: 'paid', name: 'Fictional reviewed media course', pricing: { currency: 'USD', amountMinor: 1234, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalMedia01', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
  if (created.action !== 'create') throw new Error('offer not created');
  await w.offers.execute(me, { action: 'approve_provider_mapping', offerId: created.offer.offerId, expectedRevision: 1 });
  await w.offers.execute(me, { action: 'publish', offerId: created.offer.offerId, expectedRevision: 2 });
  a = await w.purchase('reviewed-a', ids.alicePerson, ids.alice);
  await w.enableDelivery();
  const bootstrapUser = (await w.db.query<{ s: string }>('select session_user::text as s')).rows[0]!.s;
  rds = createPgliteRdsDataClient(w.db, LOGINS, bootstrapUser);
}, 240_000);
afterAll(async () => { __resetLearnerHost(); __resetReviewedLearner(); __resetReviewedPurchasing(); await w?.db.close(); });

describe('the consumer education API serves one media slot through the reviewed runtime', () => {
  it('answers held when the target names no learner media, and reads nothing', async () => {
    const storage = createFictionalLearnerMediaStorage();
    const reply = await v2(handler(false, storage), signIn(w.ids.alicePerson, w.ids.alice), body());
    expect(reply).toEqual({ status: 200, json: { data: { outcome: 'held' } } });
    expect(storage.issued).toHaveLength(0);
  });
  it('serves the owner the exact version, over the API login only, and the reply satisfies the mirrored contract', async () => {
    const before = rds.used.length;
    const reply = await v2(handler(true), signIn(w.ids.alicePerson, w.ids.alice), body());
    expect(reply.status).toBe(200);
    const parsed = learnerMediaReply.parse(reply.json.data);
    expect(parsed).toMatchObject({ outcome: 'available', entitlementId: a.entitlementId, media: { artifactId: video.reference.artifactId } });
    expect(new Set(rds.used.slice(before).map(u => u.secretArn))).toEqual(new Set([secretArn('api')]));
  });
  it('refuses another learner, an unsigned request and a revoked session; a reply finished after revocation is discarded', async () => {
    expect((await v2(handler(true), signIn(w.ids.bobPerson, w.ids.bob), body())).json).toEqual({ data: { outcome: 'not_available' } });
    expect((await v2(handler(true), null, body())).status).toBe(401);
    const tokens = signIn(w.ids.alicePerson, w.ids.alice);
    const midRead = createFictionalLearnerMediaStorage({ before: () => revoke(w.ids.alice) });
    expect(await v2(handler(true, midRead), tokens, body())).toEqual({ status: 401, json: { error: { code: 'consumer_signin_required', message: 'consumer_signin_required' } } });
    expect((await v2(handler(true), tokens, body())).status).toBe(401);
  });
});

describe('the Desktop My courses route serves the same slot through the reviewed learner host', () => {
  it('installs from the bootstrap and serves only the verified owner; a revoked session is told to sign in', async () => {
    __resetLearnerHost(); __resetReviewedLearner(); __resetReviewedPurchasing();
    const outcome = await bootstrapReviewedCommerce({ env: ENV, readTarget: async () => target(true), runtimeInputs: { rdsClient: rds, consumerSessions: verifier, learnerMediaStorage: createFictionalLearnerMediaStorage() } });
    expect(outcome).toMatchObject({ installed: true, learner: true });
    const tokens = signIn(w.ids.alicePerson, w.ids.alice);
    const served = await desktop(tokens, body());
    expect(served.status).toBe(200);
    expect(served.json.host).toBe('reviewed');
    expect(learnerMediaReply.parse(served.json.data)).toMatchObject({ outcome: 'available' });
    expect((await desktop(signIn(w.ids.bobPerson, w.ids.bob), body())).json.data).toEqual({ outcome: 'not_available' });
    revoke(w.ids.alice);
    expect((await desktop(tokens, body())).status).toBe(401);
  });
});
