import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authenticateFictionalFixtures, type FixtureAuthTransport } from './inventory-fixture-authentication';
import { fixtureTokenAuthority, fictionalTotp, verifyFixtureToken } from './inventory-fixture-token';
import { generateFixtureIntent, type FixtureRole } from './inventory-qualification-fixtures';

const now = 1791570000000, session = 'Fictional_session_only_1234567890';
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'fictional-key', alg: 'RS256', use: 'sig' };
const jwks = { keys: [key] };
const intent = generateFixtureIntent();
const subjects = { consumer: 'Opaque_Consumer_Sub_01', foreignConsumer: 'Opaque_Consumer_Sub_02', workforce: 'Opaque_Workforce_Sub_03' };
function jwt(role: FixtureRole, kind: 'id' | 'access', patch: Record<string, unknown> = {}, headerPatch: Record<string, unknown> = {}) {
  const a = fixtureTokenAuthority(role), sec = Math.floor(now / 1000);
  const claims = { iss: a.issuer, sub: subjects[role], token_use: kind, iat: sec, auth_time: sec, exp: sec + 900,
    ...(kind === 'id' ? { aud: a.audience, email: intent.fixtures[role].email, email_verified: true,
      'custom:person_id': intent.fixtures[role].personId, 'custom:organization_id': intent.organizationId, 'custom:synthetic_attested': 'true' }
      : { client_id: a.audience, username: subjects[role], scope: 'aws.cognito.signin.user.admin' }), ...patch };
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, ...headerPatch })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), rsa.privateKey).toString('base64url')}`;
}
function result(role: FixtureRole) { return { AuthenticationResult: { IdToken: jwt(role, 'id'), AccessToken: jwt(role, 'access'),
  RefreshToken: 'Fictional_refresh_not_returned', TokenType: 'Bearer', ExpiresIn: 900 } }; }
function rig() {
  let clock = now, enrolled = false, preferred = false, metadataVisible = true;
  const store = new Map<string, unknown>(), calls: string[] = [];
  const users = new Map<string, Record<string, unknown>>();
  for (const role of ['consumer', 'foreignConsumer', 'workforce'] as const) {
    const f = intent.fixtures[role]; users.set(subjects[role], { Enabled: true, UserStatus: 'CONFIRMED', Username: subjects[role],
      UserAttributes: Object.entries({ sub: subjects[role], email: f.email, email_verified: 'true',
        'custom:person_id': f.personId, 'custom:organization_id': intent.organizationId, 'custom:synthetic_attested': 'true' }).map(([Name, Value]) => ({ Name, Value })) });
  }
  const roleFor = (name: string) => (Object.keys(subjects) as FixtureRole[]).find(r => subjects[r] === name || intent.fixtures[r].email === name)!;
  const challenge = (name: string) => ({ ChallengeName: name, Session: session, ChallengeParameters: {
    USER_ID_FOR_SRP: subjects.workforce, ...(name === 'MFA_SETUP' ? { MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA"]' } : {}) } });
  const t: FixtureAuthTransport = {
    now: () => clock, verifyPrivateConfiguration: async () => { calls.push('configuration'); },
    loadIntent: async () => structuredClone(intent),
    readUser: async (_pool, name) => { const role = roleFor(name), u = structuredClone(users.get(subjects[role]))!;
      if (role === 'workforce') { u.UserMFASettingList = enrolled && metadataVisible ? ['SOFTWARE_TOKEN_MFA'] : [];
        if (preferred) u.PreferredMfaSetting = 'SOFTWARE_TOKEN_MFA'; }
      return u; },
    initiate: async (_pool, _client, name) => { const role = roleFor(name); calls.push(`login:${role}`);
      return role === 'workforce' ? challenge(enrolled ? 'SOFTWARE_TOKEN_MFA' : 'MFA_SETUP') : result(role); },
    respond: async (_pool, _client, sub, name, _session, code) => {
      expect(sub).toBe(subjects.workforce); calls.push(`respond:${name}`);
      if (name === 'SOFTWARE_TOKEN_MFA') expect(code).toBe(fictionalTotp(seed, clock));
      return result('workforce'); },
    associate: async () => { calls.push('associate'); return { SecretCode: seed, Session: session }; },
    verifySoftware: async (_session, code) => { expect(code).toBe(fictionalTotp(seed, clock)); calls.push('verify'); enrolled = true;
      return { Status: 'SUCCESS', Session: session }; },
    preferSoftware: async () => { calls.push('prefer'); preferred = true; metadataVisible = true; },
    loadMfa: async (_binding, phase) => structuredClone(store.get(phase) ?? null),
    createMfa: async (_binding, phase, value) => { calls.push(`save:${phase}`); if (store.has(phase)) return false;
      store.set(phase, structuredClone(value)); return true; },
    jwks: async () => structuredClone(jwks),
  };
  return { t, calls, store, users, enroll: () => { enrolled = true; }, hideMfaMetadata: () => { metadataVisible = false; }, setClock: (n: number) => { clock = n; } };
}

describe('fixed fictional Cognito authority', () => {
  it('accepts separately signed ID/access tokens for all three exact fictional subjects', () => {
    for (const role of ['consumer', 'foreignConsumer', 'workforce'] as const)
      for (const kind of ['id', 'access'] as const) expect(() => verifyFixtureToken(jwt(role, kind), jwks, role, kind, subjects[role], intent, now)).not.toThrow();
  });
  it.each([
    { iss: 'https://foreign.invalid' }, { aud: 'other-client' }, { sub: subjects.foreignConsumer }, { token_use: 'access' },
    { exp: now / 1000 }, { exp: now / 1000 + 901 }, { iat: now / 1000 + 31 }, { iat: now / 1000 - 121 },
    { auth_time: now / 1000 - 121 }, { auth_time: now / 1000 + 31 }, { email_verified: false },
    { 'custom:person_id': intent.fixtures.foreignConsumer.personId }, { 'custom:organization_id': 'different' },
    { 'custom:synthetic_attested': 'false' }, { 'custom:production_bound': 'false' }, { email: 'real@example.com' },
  ])('refuses wrong, stale or production-bound ID claims %j', patch => {
    expect(() => verifyFixtureToken(jwt('consumer', 'id', patch), jwks, 'consumer', 'id', subjects.consumer, intent, now)).toThrow();
  });
  it.each([{ client_id: 'wrong' }, { username: subjects.foreignConsumer }, { scope: '' }, { token_use: 'id' }])('refuses wrong access authority %j', patch => {
    expect(() => verifyFixtureToken(jwt('consumer', 'access', patch), jwks, 'consumer', 'access', subjects.consumer, intent, now)).toThrow();
  });
  it('refuses algorithm/header confusion, unknown or duplicate keys, private key material, signature changes and unbounded tokens', () => {
    for (const patch of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }, { jku: 'https://attacker.invalid' }, { crit: ['x'] }])
      expect(() => verifyFixtureToken(jwt('consumer', 'id', {}, patch), jwks, 'consumer', 'id', subjects.consumer, intent, now)).toThrow();
    for (const bad of [{ keys: [key, key] }, { keys: [{ ...key, d: 'private' }] }, { keys: [{ ...key, use: 'enc' }] }, { keys: [] }])
      expect(() => verifyFixtureToken(jwt('consumer', 'id'), bad, 'consumer', 'id', subjects.consumer, intent, now)).toThrow();
    const token = jwt('consumer', 'id').split('.'); token[2] = Buffer.alloc(256).toString('base64url');
    expect(() => verifyFixtureToken(token.join('.'), jwks, 'consumer', 'id', subjects.consumer, intent, now)).toThrow();
    expect(() => verifyFixtureToken('x'.repeat(17000), jwks, 'consumer', 'id', subjects.consumer, intent, now)).toThrow();
  });
  it('matches RFC6238 SHA1 vectors with six digits and refuses malformed seed/time', () => {
    for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']] as const)
      expect(fictionalTotp(seed, seconds * 1000)).toBe(expected);
    for (const bad of ['short', 'x'.repeat(32), seed + '=', 'A'.repeat(130), 'AAAAAAAAAAAAAAAAAB']) expect(() => fictionalTotp(bad, now)).toThrow();
    expect(() => fictionalTotp(seed, -1)).toThrow();
  });
});

describe('credential-safe fictional enrollment and actual MFA proof', () => {
  it('persists admission before association, seed before verification, then proves a fresh MFA challenge and redacts output', async () => {
    const r = rig(), report = await authenticateFictionalFixtures(r.t);
    expect(r.calls.indexOf('save:admission')).toBeLessThan(r.calls.indexOf('associate'));
    expect(r.calls.indexOf('save:custody')).toBeLessThan(r.calls.indexOf('verify'));
    expect(r.calls).toContain('respond:SOFTWARE_TOKEN_MFA');
    expect(report).toMatchObject({ credentialsLoginVerified: true, workforceMfaEnrollmentVerified: true,
      freshWorkforceMfaChallengeVerified: true, associateAttemptsCompleted: 1, preferenceWritesCompleted: 1,
      physicalLoginVerified: false, databaseIdentityAuthorityVerified: false, acceptance: false, phiAllowed: false });
    const output = JSON.stringify(report);
    for (const forbidden of [seed, session, 'Fictional_refresh', ...Object.values(intent.fixtures).flatMap(f => [f.email, f.password])]) expect(output).not.toContain(forbidden);
    r.calls.length = 0;
    expect(await authenticateFictionalFixtures(r.t)).toMatchObject({ associateAttemptsCompleted: 0, preferenceWritesCompleted: 0 });
    expect(r.calls).not.toContain('associate'); expect(r.calls).not.toContain('verify'); expect(r.calls).not.toContain('save:admission');
  });
  it('does not replace an enrolled authenticator with missing custody', async () => {
    const r = rig(); r.enroll(); await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('fictional_mfa_custody_recovery_required');
    expect(r.calls).not.toContain('associate'); expect(r.calls).not.toContain('prefer');
  });
  it('stops an uncertain association and refuses a second association on replay', async () => {
    const r = rig(); r.t.associate = async () => { r.calls.push('associate'); throw Error('lost reply'); };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('lost reply');
    expect(r.store.has('admission')).toBe(true); expect(r.store.has('custody')).toBe(false);
    r.calls.length = 0; await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('fictional_mfa_custody_recovery_required');
    expect(r.calls).not.toContain('associate');
  });
  it('recovers a persisted seed after lost save receipt without re-association', async () => {
    const r = rig(), create = r.t.createMfa;
    r.t.createMfa = async (...args) => { const saved = await create(...args); if (args[1] === 'custody') throw Error('lost seed receipt'); return saved; };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('lost seed receipt');
    r.t.createMfa = create; r.calls.length = 0;
    expect(await authenticateFictionalFixtures(r.t)).toMatchObject({ associateAttemptsCompleted: 0, workforceMfaEnrollmentVerified: true });
    expect(r.calls).not.toContain('associate');
  });
  it('recovers a successful verification whose reply was lost through fresh code proof, not another verify/reset', async () => {
    const r = rig(), verify = r.t.verifySoftware;
    r.t.verifySoftware = async (...args) => { await verify(...args); throw Error('lost verified receipt'); };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('lost verified receipt');
    r.calls.length = 0;
    expect(await authenticateFictionalFixtures(r.t)).toMatchObject({ associateAttemptsCompleted: 0, freshWorkforceMfaChallengeVerified: true });
    expect(r.calls).not.toContain('verify'); expect(r.calls).not.toContain('associate');
  });
  it('recovers verified-but-unpreferred AWS metadata after setup expiry using exact fresh MFA proof and the same seed', async () => {
    const r = rig(), verify = r.t.verifySoftware;
    r.t.verifySoftware = async (...args) => { await verify(...args); r.hideMfaMetadata(); throw Error('setup continuation interrupted'); };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('setup continuation interrupted');
    r.setClock(now + 91000); r.calls.length = 0;
    expect(await authenticateFictionalFixtures(r.t)).toMatchObject({ associateAttemptsCompleted: 0, preferenceWritesCompleted: 1,
      workforceMfaEnrollmentVerified: true, freshWorkforceMfaChallengeVerified: true });
    expect(r.calls).not.toContain('associate'); expect(r.calls).not.toContain('verify');
  });
  it('refuses an expired unverified session rather than replacing the stored authenticator', async () => {
    const r = rig(); r.t.verifySoftware = async () => { throw Error('interrupted'); };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('interrupted');
    r.setClock(now + 91000); r.calls.length = 0;
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('fictional_mfa_setup_session_expired');
    expect(r.calls).not.toContain('associate'); expect(r.calls).not.toContain('verify');
  });
  it('losing the admission race cannot associate a second seed', async () => {
    const r = rig(); r.t.createMfa = async () => false;
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('fictional_mfa_enrollment_already_admitted');
    expect(r.calls).not.toContain('associate');
  });
  it('refuses displaced owner attributes before any password login', async () => {
    const r = rig(), u = r.users.get(subjects.consumer)!;
    (u.UserAttributes as Array<{Name: string; Value: string}>).find(a => a.Name === 'custom:person_id')!.Value = intent.fixtures.workforce.personId;
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow(); expect(r.calls).not.toContain('login:consumer');
  });
  it('refuses wrong challenge subjects and success tokens instead of a fresh MFA challenge', async () => {
    const r = rig(), initiate = r.t.initiate;
    r.t.initiate = async (...args) => { if (args[2] === intent.fixtures.workforce.email) return {
      ChallengeName: 'MFA_SETUP', Session: session, ChallengeParameters: { USER_ID_FOR_SRP: subjects.consumer, MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA"]' } }; return initiate(...args); };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow(); expect(r.calls).not.toContain('associate');
    const s = rig(); await authenticateFictionalFixtures(s.t); const initial = s.t.initiate;
    s.t.initiate = async (...args) => args[2] === intent.fixtures.workforce.email ? result('workforce') : initial(...args);
    await expect(authenticateFictionalFixtures(s.t)).rejects.toThrow();
  });
  it('refuses a custody binding changed after enrollment without provider mutation', async () => {
    const r = rig(); await authenticateFictionalFixtures(r.t);
    const saved = r.store.get('custody') as { admission: { binding: { subject: string } } }; saved.admission.binding.subject = subjects.consumer;
    r.calls.length = 0; await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow();
    expect(r.calls).not.toContain('associate'); expect(r.calls).not.toContain('prefer');
  });
  it('stops if private pool configuration changes before association', async () => {
    const r = rig(); let reads = 0;
    r.t.verifyPrivateConfiguration = async () => { if (++reads === 3) throw Error('pool drift'); };
    await expect(authenticateFictionalFixtures(r.t)).rejects.toThrow('pool drift'); expect(r.calls).not.toContain('associate');
  });
  it('pins SDK endpoints, one attempt, bounded JWKS and encrypted create-only custody without secret logs or reset APIs', () => {
    const source = readFileSync(new URL('./inventory-fixture-authentication-cli.ts', import.meta.url), 'utf8');
    for (const text of ["profile: 'ai-synthetic-member'", 'maxAttempts: 1', 'AbortSignal.timeout(30000)', "redirect: 'error'",
      'count > 65536', 'controller.abort()', "phase === 'admission'", "endpoint: 'https://cognito-idp.us-east-2.amazonaws.com'",
      "endpoint: 'https://secretsmanager.us-east-2.amazonaws.com'"]) expect(source).toContain(text);
    for (const bad of ['process.env', 'AdminSetUserPassword', 'PutSecretValueCommand', 'UpdateSecretCommand', 'console.log(intent',
      'console.error(error', 'writeFile', 'execFile']) expect(source).not.toContain(bad);
  });
});
