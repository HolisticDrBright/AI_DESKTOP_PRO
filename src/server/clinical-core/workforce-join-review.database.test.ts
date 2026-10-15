import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import { createWorkforceJoinReview, JOIN_REVIEW_SQL_REFUSALS, WORKFORCE_JOIN_REVIEW_FUNCTIONS, WorkforceJoinReviewError } from './workforce-join-review';
import { createWorkforceJoinReviewApi, WORKFORCE_JOIN_REVIEW_API_RELEASE } from './workforce-join-review-api';
import { ClinicProposalReviewError, createClinicProposalReview, WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE } from './workforce-clinic-proposal-review';
import type { ApiGatewayV2Event } from './aws-identity-api';

/**
 * The clinic-admin and platform-operator interfaces over the assembled schema, the onboarding parents, the setter and the
 * BLOCKED approval-authority candidate. The PGlite client below classifies the candidate's refusal names the way the
 * source-interface request asks the production data client to (each name as a rejection whose reason is the name); a
 * second client passes them unclassified, as rds-data-database.ts does today. Fictional clinics, people and addresses.
 */
const FILES = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
];
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql';
const digest = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
type Actor = { person: string; subject: string; email: string };
const clinicA = randomUUID(), clinicB = randomUUID();
const make = (label: string): Actor => { const person = randomUUID(); return { person, subject: randomUUID(), email: `${label}.${person.slice(0, 8)}@clinic.fictional.example` }; };
const ownerA = make('owner.a'), adminA = make('admin.a'), practitionerA = make('practitioner.a'), ownerB = make('owner.b'), adminAB = make('admin.ab');
let db: PGlite;
const sent: unknown[][] = [];

async function exec(file: string) { for (const statement of splitPostgresStatements(readFileSync(file, 'utf8'))) await db.exec(statement); }
async function person(who: Actor, memberships: Array<[string, string]>) {
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.subject]);
  await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [who.person, who.subject, digest(who.email)]);
  for (const [org, role] of memberships) await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,$3,'active')", [org, who.person, role]);
}
const NAMES = new RegExp(`\\b(${Object.keys(JOIN_REVIEW_SQL_REFUSALS).join('|')}|workforce_operator_refused)\\b`);
/** A ClinicalCoreDatabase over PGlite as `role`; `classified` emulates the requested classification. */
function client(role: string, classified = true): ClinicalCoreDatabase {
  return {
    transaction: async work => {
      try {
        return await db.transaction(async (tx: Transaction) => {
          await tx.exec(`set local role ${role}`);
          return work({ query: (sql, parameters = []) => {
            const values = parameters.map(value => value && typeof value === 'object' && 'kind' in value && (value as { kind: string }).kind === 'uuid' ? (value as unknown as { value: string }).value : value);
            sent.push(values);
            return tx.query(sql, values);
          } });
        });
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/workforce_membership_refused/.test(message)) throw new ClinicalCoreDatabaseRejection('identity_refused');
        const name = message.match(NAMES)?.[1];
        if (classified && name) throw new ClinicalCoreDatabaseRejection('operation_refused', name);
        throw error;
      }
    },
  };
}
const submit = (subject: string, kind: 'join' | 'create_clinic', target: string, email = `${subject.slice(0, 8)}@applicant.fictional.example`) => {
  const request = randomUUID();
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_workforce_application');
    await tx.query('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6)', [request, subject, digest(email), kind, kind === 'join' ? target : null, kind === 'create_clinic' ? target : null]);
    return { request, subject, email };
  });
};
const refusal = async (work: Promise<unknown>) => {
  try { await work; } catch (error) { return error instanceof WorkforceJoinReviewError || error instanceof ClinicProposalReviewError ? error.code : String(error); }
  throw new Error('expected a refusal');
};
const at = (who: Actor, clinic: string) => ({ subject: who.subject, selectedOrganizationId: clinic });

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const file of FILES) await exec(file);
  for (const [id, label] of [[clinicA, 'FICTIONAL CLINIC A'], [clinicB, 'FICTIONAL CLINIC B']]) await db.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [id, label]);
  await person(ownerA, [[clinicA, 'owner']]); await person(adminA, [[clinicA, 'admin']]); await person(practitionerA, [[clinicA, 'practitioner']]);
  await person(ownerB, [[clinicB, 'owner']]); await person(adminAB, [[clinicA, 'admin'], [clinicB, 'practitioner']]);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('before the candidate exists', () => {
  it('every administrator request answers not_released, and no review function is called', async () => {
    const review = createWorkforceJoinReview({ database: client('clinical_core_api') });
    for (const request of [{ action: 'list' } as const, { action: 'reject', requestId: randomUUID(), reason: 'not_known_to_clinic' } as const]) {
      expect(await refusal(review(at(ownerA, clinicA), request))).toBe('not_released');
    }
  });
});

describe('the clinic administrator interface', () => {
  const review = () => createWorkforceJoinReview({ database: client('clinical_core_api') });
  beforeAll(async () => { await exec(SUCCESSOR); }, 60_000);

  it('pins the reviewed function bodies to the candidate', async () => {
    for (const entry of Object.values(WORKFORCE_JOIN_REVIEW_FUNCTIONS)) {
      const { rows } = await db.query<{ h: string }>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as h from pg_proc where oid=to_regprocedure($1)", [entry.signature]);
      expect([entry.signature, rows[0]?.h]).toEqual([entry.signature, entry.prosrcSha256]);
    }
  });

  it('lists, approves by the applicant\'s address, and sends only its digest', async () => {
    const app = await submit(randomUUID(), 'join', clinicA);
    const queue = await review()(at(adminA, clinicA), { action: 'list' });
    expect(queue.action === 'list' && queue.requests.find(entry => entry.id === app.request)).toMatchObject({ status: 'pending', membershipId: null });
    sent.length = 0;
    const approved = await review()(at(adminA, clinicA), { action: 'approve', requestId: app.request, applicantEmail: app.email.toUpperCase() });
    expect(approved).toMatchObject({ action: 'approve', requestId: app.request, status: 'approved', duplicate: false });
    expect(JSON.stringify(sent)).not.toContain('@');
    expect(JSON.stringify(sent)).toContain(digest(app.email));
    expect(await review()(at(ownerA, clinicA), { action: 'approve', requestId: app.request, applicantEmail: app.email })).toMatchObject({ duplicate: true });
    expect(await refusal(review()(at(ownerA, clinicA), { action: 'reject', requestId: app.request, reason: 'not_known_to_clinic' }))).toBe('conflict');
  });

  it('refuses a practitioner, a clinic the session did not select, an unknown or foreign request, and a mismatched address', async () => {
    const app = await submit(randomUUID(), 'join', clinicA);
    sent.length = 0;
    expect(await refusal(review()(at(practitionerA, clinicA), { action: 'list' }))).toBe('identity_refused');
    // The setter ran and refused the role before any review function: only its own call was sent.
    expect(sent.some(values => values.includes(app.request))).toBe(false);
    expect(await refusal(review()(at(adminAB, clinicB), { action: 'approve', requestId: app.request, applicantEmail: app.email }))).toBe('identity_refused');
    expect(await refusal(review()(at(ownerB, clinicB), { action: 'approve', requestId: app.request, applicantEmail: app.email }))).toBe('not_found');
    expect(await refusal(review()(at(adminA, clinicA), { action: 'reject', requestId: randomUUID(), reason: 'duplicate_request' }))).toBe('not_found');
    expect(await refusal(review()(at(adminA, clinicA), { action: 'approve', requestId: app.request, applicantEmail: 'someone.else@applicant.fictional.example' }))).toBe('applicant_mismatch');
    expect(await refusal(review()(at(ownerB, clinicA), { action: 'list' }))).toBe('identity_refused');
  });

  it('one login with two approved clinics: each request acts in its own selection, and nothing carries over', async () => {
    const forA = await submit(randomUUID(), 'join', clinicA), forB = await submit(randomUUID(), 'join', clinicB);
    const asA = await review()(at(adminAB, clinicA), { action: 'list' });
    expect(await refusal(review()(at(adminAB, clinicB), { action: 'list' }))).toBe('identity_refused');
    const asAAgain = await review()(at(adminAB, clinicA), { action: 'list' });
    for (const answer of [asA, asAAgain]) {
      const ids = answer.action === 'list' ? answer.requests.map(entry => entry.id) : [];
      expect(ids).toContain(forA.request);
      expect(ids).not.toContain(forB.request);
    }
  });

  it('revokes with a reason; the practitioner\'s still-valid token then reaches nothing', async () => {
    const app = await submit(randomUUID(), 'join', clinicA);
    const approved = await review()(at(adminA, clinicA), { action: 'approve', requestId: app.request, applicantEmail: app.email });
    const membershipId = approved.action === 'approve' ? approved.membershipId : '';
    expect(await review()(at({ ...make('x'), subject: app.subject }, clinicA), { action: 'list' }).catch(error => error.code)).toBe('identity_refused');
    expect(await review()(at(adminA, clinicA), { action: 'revoke', membershipId, reason: 'credentials_lapsed' })).toEqual({ action: 'revoke', membershipId, status: 'suspended', reason: 'credentials_lapsed', duplicate: false });
    expect(await review()(at(ownerA, clinicA), { action: 'revoke', membershipId, reason: 'left_clinic' })).toMatchObject({ duplicate: true });
    const own = (await db.query<{ id: string }>('select id from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinicA, adminA.person])).rows[0]!.id;
    expect(await refusal(review()(at(adminA, clinicA), { action: 'revoke', membershipId: own, reason: 'left_clinic' }))).toBe('self_approval_refused');
    const setter = await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      return tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [app.subject, clinicA]).then(() => 'admitted', error => String(error));
    });
    expect(setter).toMatch(/workforce_membership_refused/);
  });

  it('through today\'s unclassified data client a refusal reads as unavailable, never as success or as another clinic\'s answer', async () => {
    const app = await submit(randomUUID(), 'join', clinicA);
    const unclassified = createWorkforceJoinReview({ database: client('clinical_core_api', false) });
    expect(await refusal(unclassified(at(adminA, clinicA), { action: 'approve', requestId: app.request, applicantEmail: 'wrong@applicant.fictional.example' }))).toBe('service_unavailable');
    const down = createWorkforceJoinReview({ database: { transaction: async () => { throw new Error('connection refused'); } } });
    expect(await refusal(down(at(adminA, clinicA), { action: 'list' }))).toBe('service_unavailable');
  });

  describe('the route a host would mount', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const configuration = { workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FICTIONAL1', workforceAudience: 'fictionalaudience0000001', organizationId: clinicA };
    const event = (who: Actor, routeKey: string, body?: unknown, extra: Partial<ApiGatewayV2Event> = {}): ApiGatewayV2Event => ({
      routeKey, headers: { 'content-type': 'application/json', 'x-alp-selected-organization-id': clinicA },
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: { authorizer: { jwt: { claims: { iss: configuration.workforceIssuer, aud: configuration.workforceAudience, token_use: 'id', email_verified: 'true',
        sub: who.subject, exp: now / 1000 + 600, iat: now / 1000 - 60, auth_time: now / 1000 - 120 } } } },
      ...extra,
    } as ApiGatewayV2Event);
    it('is blocked in source: 503 before the token or the database is touched', async () => {
      expect(WORKFORCE_JOIN_REVIEW_API_RELEASE).toBe('blocked');
      const factory = vi.fn(() => review());
      const api = createWorkforceJoinReviewApi({ configuration, review: factory, now: () => now });
      const answer = await api(event(adminA, 'GET /clinical-core/workforce/join-requests'));
      expect(answer).toMatchObject({ statusCode: 503, body: JSON.stringify({ error: 'not_released' }) });
      expect(factory).not.toHaveBeenCalled();
    });
    it('under a qualification release: no-store answers that name the clinic, and bounded, exact bodies', async () => {
      const api = createWorkforceJoinReviewApi({ configuration, review, release: 'qualification', now: () => now });
      const listed = await api(event(adminA, 'GET /clinical-core/workforce/join-requests'));
      expect(listed.statusCode).toBe(200);
      expect(listed.headers).toMatchObject({ 'cache-control': 'no-store', 'x-alp-selected-organization-id': clinicA });
      const app = await submit(randomUUID(), 'join', clinicA);
      expect((await api(event(adminA, 'POST /clinical-core/workforce/join-requests/decisions', { action: 'reject', requestId: app.request, reason: 'clinic_not_accepting' }))).statusCode).toBe(200);
      for (const bad of [
        event(adminA, 'POST /clinical-core/workforce/join-requests/decisions', { action: 'reject', requestId: app.request, reason: 'clinic_not_accepting', note: 'x' }),
        event(adminA, 'POST /clinical-core/workforce/join-requests/decisions', { action: 'revoke', membershipId: randomUUID(), reason: 'left_clinic' }),
        event(adminA, 'POST /clinical-core/workforce/join-requests/decisions', { action: 'reject', requestId: app.request, reason: 'x'.repeat(3000) }),
        event(adminA, 'GET /clinical-core/workforce/join-requests', undefined, { queryStringParameters: { organizationId: clinicB } }),
      ]) expect((await api(bad)).statusCode).toBe(400);
      expect((await api(event(adminA, 'POST /clinical-core/workforce/join-requests/decisions', { action: 'reject', requestId: app.request, reason: 'not_known_to_clinic' }))).statusCode).toBe(200);
      const other = await api({ ...event(adminA, 'GET /clinical-core/workforce/join-requests'), headers: { 'x-alp-selected-organization-id': clinicB } });
      expect(other.statusCode).toBe(403);
      expect((await api(event(practitionerA, 'GET /clinical-core/workforce/join-requests'))).statusCode).toBe(403);
      expect((await api(event(adminA, 'GET /clinical-core/workforce/unknown'))).statusCode).toBe(404);
    });
  });
});

describe('the platform operator interface', () => {
  const operator = randomUUID();
  beforeAll(async () => { await db.query('insert into clinical_private.workforce_platform_operators(operator_subject) values($1)', [operator]); });
  const reviewFor = (subject: string | Error, release: 'blocked' | 'qualification' = 'qualification') => createClinicProposalReview({
    database: client('clinical_workforce_operator'), release,
    verifiedOperatorSubject: async () => { if (subject instanceof Error) throw subject; return subject; },
  });

  it('is blocked in source, and the authenticator is not even asked', async () => {
    expect(WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE).toBe('blocked');
    const authenticator = vi.fn(async () => operator);
    const review = createClinicProposalReview({ database: client('clinical_workforce_operator'), verifiedOperatorSubject: authenticator });
    expect(await refusal(review('Bearer fictional', { action: 'list' }))).toBe('not_released');
    expect(authenticator).not.toHaveBeenCalled();
  });

  it('a registered operator approves into a held clinic; nobody gains access by it', async () => {
    const applicant = randomUUID();
    const app = await submit(applicant, 'create_clinic', 'FICTIONAL OPERATOR CLINIC');
    const queue = await reviewFor(operator)('Bearer fictional', { action: 'list' });
    expect(queue.action === 'list' && queue.proposals.some(entry => entry.id === app.request && entry.proposedLabel === 'FICTIONAL OPERATOR CLINIC')).toBe(true);
    const approved = await reviewFor(operator)('Bearer fictional', { action: 'approve', requestId: app.request });
    expect(approved).toMatchObject({ action: 'approve', status: 'approved', activation: 'held', duplicate: false });
    const clinic = 'organizationId' in approved ? approved.organizationId! : '';
    const admitted = await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      return tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [applicant, clinic]).then(() => true, () => false);
    });
    expect(admitted).toBe(false);
    expect(await refusal(createWorkforceJoinReview({ database: client('clinical_core_api') })(at({ ...make('held'), subject: applicant }, clinic), { action: 'list' }))).toBe('identity_refused');
  });

  it('refuses an unregistered operator, a failed authenticator, and an answer that is not held', async () => {
    const app = await submit(randomUUID(), 'create_clinic', 'FICTIONAL OPERATOR CLINIC TWO');
    expect(await refusal(reviewFor(randomUUID())('Bearer fictional', { action: 'approve', requestId: app.request }))).toBe('operator_refused');
    expect(await refusal(reviewFor(new Error('expired'))('Bearer fictional', { action: 'list' }))).toBe('operator_refused');
    expect(await refusal(reviewFor('not-a-subject')('Bearer fictional', { action: 'list' }))).toBe('operator_refused');
    const notHeld = createClinicProposalReview({ release: 'qualification', verifiedOperatorSubject: async () => operator, database: { transaction: async work => work({
      query: async () => ({ rows: [{ data: { status: 'approved', organizationId: randomUUID(), membershipId: randomUUID(), decisionReason: 'clinic_proposal_verified', activation: null, duplicate: false } }] }) as never,
    }) } });
    expect(await refusal(notHeld('Bearer fictional', { action: 'approve', requestId: app.request }))).toBe('service_unavailable');
    expect((await db.query<{ status: string }>('select status from clinical_private.workforce_access_requests where id=$1', [app.request])).rows[0]!.status).toBe('pending');
  });
});
