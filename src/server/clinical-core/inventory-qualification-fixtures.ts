if (typeof window !== 'undefined') throw Error('qualification fixture provisioning is server-only');
import { randomBytes, randomUUID } from 'node:crypto';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { isInventoryCognitoSubject } from './inventory-cognito-subject';

// These are the newly created, private fixture pools, NOT shared staging or
// production. No caller/environment supplied resource can replace them.
export const fixtureIdentity = Object.freeze({
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_G2Hvf9wzJ',
  consumerAudience: '18q2q70rlsv8ti37knolpq7qsu',
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_zGOVBoeGT',
  workforceAudience: '1ffcdpnh0k45b3gc2hm9938ebl',
});
export const fixtureBindingHash = inventorySha(inventoryCanonical(fixtureIdentity));
export const fixtureSecretName = `alp/qualification/inventory-identities/${fixtureBindingHash}`;
const roles = ['consumer', 'foreignConsumer', 'workforce'] as const;
export type FixtureRole = typeof roles[number];
type Role = FixtureRole;
type Fixture = { email: string; password: string; personId: string };
export type FixtureIntent = { contract: 'inventory-qualification-fixtures/1'; bindingSha256: string;
  organizationId: string; fixtures: Record<Role, Fixture> };
export type FixtureTransport = {
  verifyPrivateConfiguration(): Promise<void>;
  loadIntent(): Promise<unknown | null>;
  createIntent(intent: FixtureIntent): Promise<void>;
  readUser(pool: string, email: string): Promise<unknown | null>;
  createUser(pool: string, fixture: Fixture, organizationId: string): Promise<void>;
  confirmNewUser(pool: string, email: string, password: string): Promise<void>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const refuse = () => inventoryRefuse('fictional_fixture_authority_refused');
const obj = (v: unknown) => inventoryRecord(v) ? v : refuse();
function keys(v: Record<string, unknown>, expected: string[]) {
  if (Object.keys(v).sort().join(',') !== [...expected].sort().join(',')) refuse();
}
export function validateFixtureIntent(raw: unknown): FixtureIntent {
  const i = obj(raw); keys(i, ['contract', 'bindingSha256', 'organizationId', 'fixtures']);
  if (i.contract !== 'inventory-qualification-fixtures/1' || i.bindingSha256 !== fixtureBindingHash
    || typeof i.organizationId !== 'string' || !uuid.test(i.organizationId)) return refuse();
  const fs = obj(i.fixtures); keys(fs, [...roles]);
  const emails = new Set<string>(), people = new Set<string>();
  for (const role of roles) {
    const f = obj(fs[role]); keys(f, ['email', 'password', 'personId']);
    if (typeof f.personId !== 'string' || !uuid.test(f.personId)
      || f.email !== `alp-${role.toLowerCase()}-${f.personId}@fixtures.invalid`
      || typeof f.password !== 'string' || !/^Aa9![A-Za-z0-9_-]{43}$/.test(f.password)) return refuse();
    emails.add(f.email as string); people.add(f.personId);
  }
  if (emails.size !== 3 || people.size !== 3 || people.has(i.organizationId)) return refuse();
  return structuredClone(i) as FixtureIntent;
}
export function generateFixtureIntent(): FixtureIntent {
  const fixtures = {} as Record<Role, Fixture>;
  for (const role of roles) {
    const personId = randomUUID();
    fixtures[role] = { personId, email: `alp-${role.toLowerCase()}-${personId}@fixtures.invalid`,
      password: `Aa9!${randomBytes(32).toString('base64url')}` };
  }
  return validateFixtureIntent({ contract: 'inventory-qualification-fixtures/1', bindingSha256: fixtureBindingHash,
    organizationId: randomUUID(), fixtures });
}
export function inspectFixtureUser(raw: unknown, f: Fixture, organization: string) {
  const u = obj(raw);
  if (u.Enabled !== true || !['FORCE_CHANGE_PASSWORD', 'CONFIRMED'].includes(String(u.UserStatus))
    || !isInventoryCognitoSubject(u.Username) || !Array.isArray(u.UserAttributes)
    || u.UserAttributes.length !== 6) return refuse();
  const attrs: Record<string, string> = {};
  for (const rawAttr of u.UserAttributes) {
    const a = obj(rawAttr); keys(a, ['Name', 'Value']);
    if (typeof a.Name !== 'string' || typeof a.Value !== 'string' || Object.hasOwn(attrs, a.Name)) return refuse();
    attrs[a.Name] = a.Value;
  }
  if (inventoryCanonical(attrs) !== inventoryCanonical({ sub: u.Username, email: f.email, email_verified: 'true',
    'custom:person_id': f.personId, 'custom:organization_id': organization, 'custom:synthetic_attested': 'true' })) return refuse();
  return { subject: u.Username, confirmed: u.UserStatus === 'CONFIRMED' };
}

/** Persist credentials BEFORE Cognito writes. Reconciliation only addresses
 * intent-owned identities; a confirmed identity is never password-reset. An
 * uncertain write stops the run, and a later run independently reads it. */
export async function provisionFictionalInventoryFixtures(t: FixtureTransport) {
  await t.verifyPrivateConfiguration();
  let raw = await t.loadIntent();
  if (raw === null) {
    await t.verifyPrivateConfiguration();
    await t.createIntent(generateFixtureIntent());
    raw = await t.loadIntent(); // use the persisted winner, not local guesses
  }
  const i = validateFixtureIntent(raw), subjects = {} as Record<Role, string>;
  let created = 0, confirmedNow = 0;
  for (const role of roles) {
    const pool = (role === 'workforce' ? fixtureIdentity.workforceIssuer : fixtureIdentity.consumerIssuer).split('/').at(-1)!;
    const f = i.fixtures[role];
    let user = await t.readUser(pool, f.email);
    if (user === null) {
      await t.verifyPrivateConfiguration();
      await t.createUser(pool, f, i.organizationId);
      created++;
      user = await t.readUser(pool, f.email);
    }
    let observed = inspectFixtureUser(user, f, i.organizationId);
    if (!observed.confirmed) {
      await t.verifyPrivateConfiguration();
      await t.confirmNewUser(pool, f.email, f.password);
      confirmedNow++;
      observed = inspectFixtureUser(await t.readUser(pool, f.email), f, i.organizationId);
      if (!observed.confirmed) return refuse();
    }
    subjects[role] = observed.subject;
  }
  if (new Set(Object.values(subjects)).size !== 3) return refuse();
  await t.verifyPrivateConfiguration();
  const reread = validateFixtureIntent(await t.loadIntent());
  if (inventoryCanonical(i) !== inventoryCanonical(reread)) return refuse();
  for (const role of roles) {
    const pool = (role === 'workforce' ? fixtureIdentity.workforceIssuer : fixtureIdentity.consumerIssuer).split('/').at(-1)!;
    const u = inspectFixtureUser(await t.readUser(pool, i.fixtures[role].email), i.fixtures[role], i.organizationId);
    if (!u.confirmed || u.subject !== subjects[role]) return refuse();
  }
  return { contract: 'inventory-qualification-fixture-provisioning/1', bindingSha256: fixtureBindingHash,
    organizationId: i.organizationId, subjects, createAttempts: created, passwordWritesCompleted: confirmedNow,
    fixtureAccountsObserved: true, workforceMfaEnrollmentVerified: false, credentialsLoginVerified: false,
    databaseIdentityAuthorityVerified: false, retentionServiceIdentityVerified: false, physicalLoginVerified: false,
    liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false };
}
