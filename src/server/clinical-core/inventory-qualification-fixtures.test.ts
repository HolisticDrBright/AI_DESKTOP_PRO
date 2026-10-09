import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixtureIdentity, fixtureSecretName, generateFixtureIntent, validateFixtureIntent,
  provisionFictionalInventoryFixtures, type FixtureTransport } from './inventory-qualification-fixtures';
const subjects = ['7bf7ab09-6796-4a17-8301-1526fa890456', '239ea68f-bf33-4d27-80cc-08e5d544b38c', '917aa05a-1bca-40e5-8142-e8ef3ae0e39c'];
function rig() {
  let intent: unknown | null = null;
  const calls: string[] = [], users = new Map<string, Record<string, unknown>>();
  const t: FixtureTransport = {
    verifyPrivateConfiguration: async () => { calls.push('verify'); },
    loadIntent: async () => { calls.push('load'); return structuredClone(intent); },
    createIntent: async i => { calls.push('save'); intent = structuredClone(i); },
    readUser: async (pool, email) => { calls.push('read'); return structuredClone(users.get(`${pool}/${email}`) ?? null); },
    createUser: async (pool, f, organization) => {
      calls.push('create');
      const sub = subjects[users.size];
      users.set(`${pool}/${f.email}`, { Enabled: true, Username: sub, UserStatus: 'FORCE_CHANGE_PASSWORD',
        UserAttributes: Object.entries({ sub, email: f.email, email_verified: 'true', 'custom:person_id': f.personId,
          'custom:organization_id': organization, 'custom:synthetic_attested': 'true' }).map(([Name, Value]) => ({ Name, Value })) });
    },
    confirmNewUser: async (pool, email) => { calls.push('confirm'); users.get(`${pool}/${email}`)!.UserStatus = 'CONFIRMED'; },
  };
  return { t, calls, users, getIntent: () => structuredClone(intent), setIntent: (i: unknown) => { intent = structuredClone(i); } };
}
describe('private fictional fixtures', () => {
  it('persists before creation, confirms three owned users, redacts credentials and refuses to claim login/MFA/DB/acceptance', async () => {
    const r = rig(), result = await provisionFictionalInventoryFixtures(r.t);
    expect(result).toMatchObject({ createAttempts: 3, passwordWritesCompleted: 3, fixtureAccountsObserved: true,
      workforceMfaEnrollmentVerified: false, credentialsLoginVerified: false, databaseIdentityAuthorityVerified: false,
      retentionServiceIdentityVerified: false, physicalLoginVerified: false, liveFleetVerified: false, acceptance: false,
      humanReviewsVerified: false, phiAllowed: false });
    expect(Object.values(result.subjects)).toEqual(subjects);
    expect(r.calls.indexOf('save')).toBeLessThan(r.calls.indexOf('create'));
    const intent = validateFixtureIntent(r.getIntent());
    const text = JSON.stringify(result);
    for (const f of Object.values(intent.fixtures)) { expect(text).not.toContain(f.password); expect(text).not.toContain(f.email); }
    expect(r.calls.at(-1)).toBe('read');
  });
  it('replay performs no secret overwrite, account recreation or password reset', async () => {
    const r = rig(); await provisionFictionalInventoryFixtures(r.t); r.calls.length = 0;
    expect(await provisionFictionalInventoryFixtures(r.t)).toMatchObject({ createAttempts: 0, passwordWritesCompleted: 0 });
    expect(r.calls).not.toContain('save'); expect(r.calls).not.toContain('create'); expect(r.calls).not.toContain('confirm');
  });
  it('refuses missing, foreign, malformed, duplicate or non-fictional persisted intent before account access', async () => {
    const valid = generateFixtureIntent();
    const variants: unknown[] = [null, {}, { ...valid, bindingSha256: 'a'.repeat(64) }, { ...valid, approval: true },
      { ...valid, organizationId: 'not-a-uuid' }, { ...valid, fixtures: { ...valid.fixtures,
        foreignConsumer: valid.fixtures.consumer } }, { ...valid, fixtures: { ...valid.fixtures,
          consumer: { ...valid.fixtures.consumer, email: 'real@example.com' } } }];
    for (const bad of variants) expect(() => validateFixtureIntent(bad)).toThrow();
    const r = rig(); r.setIntent({ ...valid, phiAllowed: true });
    await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
    expect(r.calls).toEqual(['verify', 'load']);
  });
  it('never creates after an unreadable secret or failed configuration observation', async () => {
    for (const phase of ['verify', 'load'] as const) {
      const r = rig();
      if (phase === 'verify') r.t.verifyPrivateConfiguration = async () => { throw Error('denied'); };
      else r.t.loadIntent = async () => { throw Error('denied'); };
      await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
      expect(r.calls).not.toContain('save'); expect(r.calls).not.toContain('create');
    }
  });
  it('reconciles a saved secret whose creation response was lost without replacing its credentials', async () => {
    const r = rig(), original = r.t.createIntent;
    r.t.createIntent = async i => { await original(i); throw Error('response lost'); };
    await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
    const persisted = r.getIntent(); r.t.createIntent = original;
    await provisionFictionalInventoryFixtures(r.t);
    expect(r.getIntent()).toEqual(persisted); expect(r.calls.filter(c => c === 'save')).toHaveLength(1);
  });
  it('reconciles a created user whose response was lost without issuing another create', async () => {
    const r = rig(), original = r.t.createUser;
    r.t.createUser = async (...args) => { await original(...args); throw Error('response lost'); };
    await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
    expect(r.users.size).toBe(1); r.t.createUser = original;
    await provisionFictionalInventoryFixtures(r.t);
    expect(r.calls.filter(c => c === 'create')).toHaveLength(3);
  });
  it('reconciles a confirmed user whose response was lost without another password write', async () => {
    const r = rig(), original = r.t.confirmNewUser;
    r.t.confirmNewUser = async (...args) => { await original(...args); throw Error('response lost'); };
    await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
    r.t.confirmNewUser = original;
    await provisionFictionalInventoryFixtures(r.t);
    expect(r.calls.filter(c => c === 'confirm')).toHaveLength(3);
  });
  it('refuses unrelated, disabled, malformed, production-bound or displaced users before changing their password', async () => {
    for (const mutation of [
      (u: Record<string, unknown>) => { u.Enabled = false; },
      (u: Record<string, unknown>) => { u.UserStatus = 'RESET_REQUIRED'; },
      (u: Record<string, unknown>) => { u.Username = 'wrong'; },
      (u: Record<string, unknown>) => { (u.UserAttributes as Array<{ Name: string; Value: string }>)[4].Value = subjects[2]; },
      (u: Record<string, unknown>) => { (u.UserAttributes as unknown[]).push({ Name: 'custom:production_bound', Value: 'true' }); },
    ]) {
      const r = rig(), create = r.t.createUser;
      r.t.createUser = async (...args) => { await create(...args); mutation([...r.users.values()][0]); };
      await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
      expect(r.calls).not.toContain('confirm');
    }
  });
  it('checks configuration immediately before each write and stops if private authority is lost', async () => {
    const r = rig(); let checks = 0;
    r.t.verifyPrivateConfiguration = async () => { if (++checks === 3) throw Error('public signup drift'); };
    await expect(provisionFictionalInventoryFixtures(r.t)).rejects.toThrow();
    expect(r.calls).toContain('save'); expect(r.calls).not.toContain('create');
  });
  it('refuses changed intent, missing confirmation, or changed user at final read', async () => {
    const noConfirm = rig(); noConfirm.t.confirmNewUser = async () => {};
    await expect(provisionFictionalInventoryFixtures(noConfirm.t)).rejects.toThrow();
    const drift = rig(), load = drift.t.loadIntent; let loads = 0;
    drift.t.loadIntent = async () => { if (++loads === 3) return generateFixtureIntent(); return load(); };
    await expect(provisionFictionalInventoryFixtures(drift.t)).rejects.toThrow();
    const userDrift = rig(), read = userDrift.t.readUser; let reads = 0;
    userDrift.t.readUser = async (...args) => { const v = await read(...args); if (++reads === 10) return null; return v; };
    await expect(provisionFictionalInventoryFixtures(userDrift.t)).rejects.toThrow();
  });
  it('uses the stored winner when two secret creators race', async () => {
    const r = rig(), winner = generateFixtureIntent(); r.t.createIntent = async () => r.setIntent(winner);
    const result = await provisionFictionalInventoryFixtures(r.t);
    expect(result.organizationId).toBe(winner.organizationId);
    expect(r.getIntent()).toEqual(winner);
  });
  it('pins the SDK transport and suppresses invitations without secret/user overwrite APIs or password CLI arguments', () => {
    const cli = readFileSync(new URL('./inventory-qualification-fixtures-cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain("profile: 'ai-synthetic-member'"); expect(cli).toContain('maxAttempts: 1');
    expect(cli).toContain("MessageAction: 'SUPPRESS', ForceAliasCreation: false");
    expect(cli).toContain("endpoint: 'https://cognito-idp.us-east-2.amazonaws.com'");
    expect(cli).toContain("endpoint: 'https://secretsmanager.us-east-2.amazonaws.com'");
    expect(cli).toContain('AbortSignal.timeout(30000)');
    for (const forbidden of ['PutSecretValueCommand', 'UpdateSecretCommand', 'AdminUpdateUserAttributesCommand',
      'AdminDeleteUserCommand', 'console.log(intent', 'console.error(error', 'process.env']) expect(cli).not.toContain(forbidden);
    expect(Object.values(fixtureIdentity).join(' ')).not.toContain('173535830222');
    expect(fixtureSecretName).toMatch(/^alp\/qualification\/inventory-identities\/[a-f0-9]{64}$/);
  });
});
