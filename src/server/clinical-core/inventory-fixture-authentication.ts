if (typeof window !== 'undefined') throw Error('fictional authentication is server-only');
import { randomUUID } from 'node:crypto';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { fixtureBindingHash, inspectFixtureUser, validateFixtureIntent, type FixtureIntent, type FixtureRole } from './inventory-qualification-fixtures';
import { fictionalTotp, fixtureTokenAuthority, verifyFixtureToken } from './inventory-fixture-token';

type Row = Record<string, unknown>;
const refuse = (category = 'fictional_authentication_authority_refused'): never => inventoryRefuse(category);
const row = (v: unknown): Row => inventoryRecord(v) ? v : refuse();
const roles = ['consumer', 'foreignConsumer', 'workforce'] as const;
export type AuthBinding = { subject: string; personId: string; organizationId: string; issuer: string; audience: string; bindingSha256: string };
export type MfaAdmission = { contract: 'fictional-mfa-admission/1'; binding: AuthBinding; nonce: string };
export type MfaCustody = { contract: 'fictional-mfa-custody/1'; admission: MfaAdmission; secretCode: string; session: string; associatedAt: number };
export const mfaSecretRoot = `alp/qualification/inventory-mfa/${fixtureBindingHash}`;
export const mfaBindingHash = (b: AuthBinding) => inventorySha(inventoryCanonical(b));
export type FixtureAuthTransport = {
  now(): number;
  verifyPrivateConfiguration(): Promise<void>;
  loadIntent(): Promise<unknown>;
  readUser(pool: string, subjectOrEmail: string): Promise<unknown>;
  initiate(pool: string, client: string, email: string, password: string): Promise<unknown>;
  respond(pool: string, client: string, subject: string, challenge: 'MFA_SETUP' | 'SOFTWARE_TOKEN_MFA', session: string, code?: string): Promise<unknown>;
  associate(session: string): Promise<unknown>;
  verifySoftware(session: string, code: string): Promise<unknown>;
  preferSoftware(pool: string, subject: string): Promise<void>;
  loadMfa(binding: AuthBinding, phase: 'admission' | 'custody'): Promise<unknown | null>;
  createMfa(binding: AuthBinding, phase: 'admission' | 'custody', value: MfaAdmission | MfaCustody): Promise<boolean>;
  jwks(issuer: string): Promise<unknown>;
};
function exact(v: Row, expected: string[]) {
  if (Object.keys(v).sort().join(',') !== [...expected].sort().join(',')) refuse();
}
function session(v: unknown): string {
  if (typeof v !== 'string' || v.length < 20 || v.length > 4096 || !/^[A-Za-z0-9_=.-]+$/.test(v)) return refuse();
  return v;
}
function admission(raw: unknown, binding: AuthBinding): MfaAdmission {
  const a = row(raw); exact(a, ['contract', 'binding', 'nonce']);
  if (a.contract !== 'fictional-mfa-admission/1' || inventoryCanonical(a.binding) !== inventoryCanonical(binding)
    || typeof a.nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.nonce)) return refuse();
  return structuredClone(a) as MfaAdmission;
}
function custody(raw: unknown, admitted: MfaAdmission): MfaCustody {
  const c = row(raw); exact(c, ['contract', 'admission', 'secretCode', 'session', 'associatedAt']);
  if (c.contract !== 'fictional-mfa-custody/1' || inventoryCanonical(c.admission) !== inventoryCanonical(admitted)
    || typeof c.secretCode !== 'string' || !Number.isSafeInteger(c.associatedAt) || Number(c.associatedAt) < 0) return refuse();
  session(c.session); fictionalTotp(c.secretCode, Number(c.associatedAt));
  return structuredClone(c) as MfaCustody;
}
function mfaStatus(raw: unknown): boolean {
  const u = row(raw), list = u.UserMFASettingList ?? [];
  if (!Array.isArray(list) || list.length > 1 || list.some(v => v !== 'SOFTWARE_TOKEN_MFA')
    || u.PreferredMfaSetting != null && u.PreferredMfaSetting !== 'SOFTWARE_TOKEN_MFA'
    || !list.length && u.PreferredMfaSetting != null) return refuse();
  return list.length === 1;
}
function challenge(raw: unknown, name: string, subject: string): string {
  const r = row(raw), p = row(r.ChallengeParameters);
  if (r.ChallengeName !== name || r.AuthenticationResult != null || p.USER_ID_FOR_SRP !== subject
    || p.USERNAME !== undefined && p.USERNAME !== subject) return refuse();
  if (name === 'MFA_SETUP' && p.MFAS_CAN_SETUP !== '["SOFTWARE_TOKEN_MFA"]') return refuse();
  return session(r.Session);
}
async function tokens(t: FixtureAuthTransport, raw: unknown, role: FixtureRole, sub: string, intent: FixtureIntent) {
  const r = row(raw), result = row(r.AuthenticationResult);
  if (r.ChallengeName != null || r.Session != null || result.TokenType !== 'Bearer'
    || result.ExpiresIn !== 900) return refuse();
  const keys = await t.jwks(fixtureTokenAuthority(role).issuer);
  verifyFixtureToken(result.IdToken, keys, role, 'id', sub, intent, t.now());
  verifyFixtureToken(result.AccessToken, keys, role, 'access', sub, intent, t.now());
}

/** No returned or logged passwords, bearer tokens, sessions, codes or seeds.
 * Enrollment admission and seed custody are create-only. An interrupted
 * association with no persisted seed is deliberately not auto-reset. */
export async function authenticateFictionalFixtures(t: FixtureAuthTransport) {
  await t.verifyPrivateConfiguration(); const intent = validateFixtureIntent(await t.loadIntent());
  const subjects = {} as Record<FixtureRole, string>; let associations = 0, preferences = 0;
  for (const role of roles) {
    const a = fixtureTokenAuthority(role), pool = a.issuer.split('/').at(-1)!, f = intent.fixtures[role];
    let user = await t.readUser(pool, f.email); const observed = inspectFixtureUser(user, f, intent.organizationId);
    if (!observed.confirmed) return refuse(); subjects[role] = observed.subject;
    let enrolled = mfaStatus(user);
    if (role !== 'workforce' && enrolled) return refuse();
    let auth = await t.initiate(pool, a.audience, f.email, f.password);
    if (role !== 'workforce') { await tokens(t, auth, role, observed.subject, intent); continue; }
    // Cognito can issue a software-token challenge after verification while
    // AdminGetUser still omits the setting list until preference is enabled.
    // Treat the exact challenge as a path to proof, not proof by itself. Never
    // re-associate that verified token or let an expired setup session block
    // fresh password-plus-code recovery from the already-persisted seed.
    if (row(auth).ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      challenge(auth, 'SOFTWARE_TOKEN_MFA', observed.subject); enrolled = true;
    }
    const binding: AuthBinding = { ...a, subject: observed.subject, personId: f.personId,
      organizationId: intent.organizationId, bindingSha256: fixtureBindingHash };
    let storedAdmission = await t.loadMfa(binding, 'admission');
    let storedCustody = await t.loadMfa(binding, 'custody');
    if (storedCustody !== null && storedAdmission === null) return refuse();
    if (!enrolled && storedAdmission === null) {
      const initialSession = challenge(auth, 'MFA_SETUP', observed.subject);
      await t.verifyPrivateConfiguration();
      user = await t.readUser(pool, observed.subject);
      if (inspectFixtureUser(user, f, intent.organizationId).subject !== observed.subject || mfaStatus(user)) return refuse();
      const proposed: MfaAdmission = { contract: 'fictional-mfa-admission/1', binding, nonce: randomUUID() };
      if (!await t.createMfa(binding, 'admission', proposed)) return refuse('fictional_mfa_enrollment_already_admitted');
      storedAdmission = await t.loadMfa(binding, 'admission');
      const accepted = admission(storedAdmission, binding);
      if (inventoryCanonical(accepted) !== inventoryCanonical(proposed)) return refuse();
      await t.verifyPrivateConfiguration();
      user = await t.readUser(pool, observed.subject);
      if (inspectFixtureUser(user, f, intent.organizationId).subject !== observed.subject || mfaStatus(user)) return refuse();
      const associated = row(await t.associate(initialSession)); associations++;
      const proposedCustody: MfaCustody = { contract: 'fictional-mfa-custody/1', admission: accepted,
        secretCode: String(associated.SecretCode ?? ''), session: session(associated.Session), associatedAt: t.now() };
      custody(proposedCustody, accepted);
      await t.verifyPrivateConfiguration();
      await t.createMfa(binding, 'custody', proposedCustody);
      storedCustody = await t.loadMfa(binding, 'custody');
      if (inventoryCanonical(storedCustody) !== inventoryCanonical(proposedCustody)) return refuse();
    }
    if (storedAdmission === null || storedCustody === null) return refuse('fictional_mfa_custody_recovery_required');
    const saved = custody(storedCustody, admission(storedAdmission, binding));
    if (t.now() < saved.associatedAt - 30000) return refuse();
    if (!enrolled) {
      challenge(auth, 'MFA_SETUP', observed.subject);
      if (t.now() - saved.associatedAt > 90000) return refuse('fictional_mfa_setup_session_expired');
      await t.verifyPrivateConfiguration();
      user = await t.readUser(pool, observed.subject);
      if (inspectFixtureUser(user, f, intent.organizationId).subject !== observed.subject) return refuse();
      enrolled = mfaStatus(user);
      if (!enrolled) {
        const verified = row(await t.verifySoftware(saved.session, fictionalTotp(saved.secretCode, t.now())));
        if (verified.Status !== 'SUCCESS') return refuse();
        auth = await t.respond(pool, a.audience, observed.subject, 'MFA_SETUP', session(verified.Session));
        await tokens(t, auth, role, observed.subject, intent);
      }
    }
    // A fresh password + code challenge, not the initial MFA_SETUP token,
    // is the required positive proof on every run, including recovery.
    auth = await t.initiate(pool, a.audience, f.email, f.password);
    const codeSession = challenge(auth, 'SOFTWARE_TOKEN_MFA', observed.subject);
    auth = await t.respond(pool, a.audience, observed.subject, 'SOFTWARE_TOKEN_MFA', codeSession, fictionalTotp(saved.secretCode, t.now()));
    await tokens(t, auth, role, observed.subject, intent);
    await t.verifyPrivateConfiguration();
    user = await t.readUser(pool, observed.subject);
    if (inspectFixtureUser(user, f, intent.organizationId).subject !== observed.subject) return refuse();
    if (!mfaStatus(user) || row(user).PreferredMfaSetting !== 'SOFTWARE_TOKEN_MFA') {
      await t.preferSoftware(pool, observed.subject); preferences++;
    }
    user = await t.readUser(pool, observed.subject);
    if (inspectFixtureUser(user, f, intent.organizationId).subject !== observed.subject || !mfaStatus(user)
      || row(user).PreferredMfaSetting !== 'SOFTWARE_TOKEN_MFA') return refuse();
  }
  if (new Set(Object.values(subjects)).size !== 3) return refuse();
  await t.verifyPrivateConfiguration();
  if (inventoryCanonical(validateFixtureIntent(await t.loadIntent())) !== inventoryCanonical(intent)) return refuse();
  for (const role of roles) {
    const pool = fixtureTokenAuthority(role).issuer.split('/').at(-1)!, u = await t.readUser(pool, subjects[role]);
    const observed = inspectFixtureUser(u, intent.fixtures[role], intent.organizationId);
    if (!observed.confirmed || observed.subject !== subjects[role] || role === 'workforce' && (!mfaStatus(u)
      || row(u).PreferredMfaSetting !== 'SOFTWARE_TOKEN_MFA')) return refuse();
  }
  return { contract: 'fictional-fixture-authentication/1', bindingSha256: fixtureBindingHash, organizationId: intent.organizationId,
    subjects, credentialsLoginVerified: true, workforceMfaEnrollmentVerified: true, freshWorkforceMfaChallengeVerified: true,
    associateAttemptsCompleted: associations, preferenceWritesCompleted: preferences,
    physicalLoginVerified: false, databaseIdentityAuthorityVerified: false, retentionServiceIdentityVerified: false,
    liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false };
}
