import { describe, expect, it, vi } from 'vitest';
import { createInventoryQualificationEnvelope } from './inventory-qualification-envelope';
import { INVENTORY_QUALIFICATION_PROFILE, type InventoryQualificationBuild } from './adopted-plan-inventory-qualification-profile';
import { ADOPTED_INVENTORY_UPGRADE } from './adopted-plan-inventory-schema-upgrade';
const build = (): InventoryQualificationBuild => ({ sourceCommit: '1'.repeat(40), sourceClean: true, migrationCount: 107,
  migrationReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to, qualificationProfile: INVENTORY_QUALIFICATION_PROFILE });
const env = (): Record<string, string | undefined> => ({ SOURCE_COMMIT: '1'.repeat(40), MIGRATION_RELEASE_SHA256: ADOPTED_INVENTORY_UPGRADE.to,
  INVENTORY_QUALIFICATION_PROFILE, AWS_REGION: 'us-east-2', PHI_ALLOWED: 'false', DEPLOYMENT_ACCOUNT_ID: '588966314750',
  TEST_ACTIVATION: 'blocked', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12',
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_REVIEW_SHA256: '2'.repeat(64),
  QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001,fictional-workforce-00001' });
// Fictional loader/env only. No secret, provider access or review is created.
describe('107 synthetic parent-handler envelope', () => {
  it.each(['api', 'worker'] as const)('delegates %s arguments/results unchanged, with one lazy load', async kind => {
    const e = env(), original = { consentDenied: true }, invoke = vi.fn(async () => original), load = vi.fn(async () => invoke);
    const handle = createInventoryQualificationEnvelope(() => e, build(), 'TEST_ACTIVATION', kind, load);
    const event = { fictional: true }, context = { fictionalRequestId: 'fixture' };
    expect(await handle(event, context)).toBe(original); expect(await handle(event)).toBe(original);
    expect(load).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenNthCalledWith(1, event, context);
  });
  it.each([
    ['PHI_ALLOWED', 'true'], ['TEST_ACTIVATION', 'approved'], ['TEST_ACTIVATION', 'draining'], ['SOURCE_COMMIT', '3'.repeat(40)],
    ['MIGRATION_RELEASE_SHA256', ADOPTED_INVENTORY_UPGRADE.from], ['INVENTORY_QUALIFICATION_PROFILE', ''],
    ['QUALIFICATION_EXECUTION', 'disabled'], ['QUALIFICATION_REVIEW_SHA256', ''], ['QUALIFICATION_IDENTITY_SUBJECTS', ''],
    ['DEPLOYMENT_ACCOUNT_ID', '173535830222'], ['CLINICAL_DATABASE_NAME', 'clinical_core'], ['AWS_REGION', 'us-west-2'],
  ])('refuses changed %s without importing a parent or making a qualification claim', async (key, value) => {
    const e = { ...env(), [key]: value }, load = vi.fn();
    const reply = await createInventoryQualificationEnvelope(() => e, build(), 'TEST_ACTIVATION', 'api', load)({});
    expect(reply).toMatchObject({ statusCode: 503 }); expect(reply).not.toHaveProperty('headers.x-clinical-execution'); expect(load).not.toHaveBeenCalled();
  });
  it('refuses dirty or falsely relabeled historical builds before importing a parent', async () => {
    for (const b of [{ ...build(), sourceClean: false }, { ...build(), migrationCount: 106 }, { ...build(), qualificationProfile: 'legacy' }]) {
      const load = vi.fn(); expect(await createInventoryQualificationEnvelope(env, b as InventoryQualificationBuild, 'TEST_ACTIVATION', 'api', load)({})).toMatchObject({ statusCode: 503 });
      expect(load).not.toHaveBeenCalled();
    }
  });
  it('worker refusal throws, never certifies a job/cleanup as successful', async () => {
    const e = { ...env(), QUALIFICATION_EXECUTION: 'disabled' }, load = vi.fn();
    await expect(createInventoryQualificationEnvelope(() => e, build(), 'TEST_ACTIVATION', 'worker', load)({})).rejects.toThrow('inventory_qualification_unavailable');
    expect(load).not.toHaveBeenCalled();
  });
  it('refuses changed configuration even after caching a parent', async () => {
    const e = env(), invoke = vi.fn(async () => 'original'), load = vi.fn(async () => invoke);
    const handle = createInventoryQualificationEnvelope(() => e, build(), 'TEST_ACTIVATION', 'api', load);
    expect(await handle({})).toBe('original'); e.CLINICAL_DATABASE_NAME = 'clinical_core';
    expect(await handle({})).toMatchObject({ statusCode: 503 }); expect(invoke).toHaveBeenCalledOnce();
  });
  it('captures build metadata and refuses review/environment changes during async import', async () => {
    const e = env(), b = build(), invoke = vi.fn(), load = vi.fn(async () => { e.EXTRA_REVIEW = 'changed'; return invoke; });
    const handle = createInventoryQualificationEnvelope(() => e, b, 'TEST_ACTIVATION', 'api', load);
    b.sourceCommit = '3'.repeat(40); // supplied object cannot retarget the captured build
    expect(await handle({})).toMatchObject({ statusCode: 503 }); expect(load).toHaveBeenCalledOnce(); expect(invoke).not.toHaveBeenCalled();
  });
  it('does not expose raw parent errors or manufacture a qualified response', async () => {
    const invoke = vi.fn(async () => { throw Error('fictional-private-payload-secret'); });
    const response = await createInventoryQualificationEnvelope(env, build(), 'TEST_ACTIVATION', 'api', async () => invoke)({});
    expect(JSON.stringify(response)).not.toContain('private'); expect(response).toMatchObject({ body: '{"error":"service_unavailable"}' });
    expect(response).not.toHaveProperty('headers.x-clinical-execution');
  });
});
