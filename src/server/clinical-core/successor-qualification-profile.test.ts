import { expect, it, vi } from 'vitest';
import { SUCCESSOR_QUALIFICATION_RELEASE as release } from '../../../scripts/successor-qualification-release.mjs';
import { assertInventoryQualificationBinding } from './adopted-plan-inventory-qualification-profile';
import { assertSuccessorQualificationBinding, createSuccessorQualificationEnvelope, type SuccessorQualificationBuild } from './successor-qualification-profile';
const build: SuccessorQualificationBuild = { ...release, sourceCommit: '1'.repeat(40), sourceClean: true, sourceInputSha256: '2'.repeat(64) };
const env = (): Record<string, string | undefined> => ({ SOURCE_COMMIT: build.sourceCommit, SOURCE_INPUT_SHA256: build.sourceInputSha256,
  MIGRATION_RELEASE_SHA256: release.migrationReleaseSha256, MIGRATION_ASSEMBLY_SHA256: release.migrationAssemblySha256,
  SUCCESSOR_QUALIFICATION_PROFILE: release.qualificationProfile, PHI_ALLOWED: 'false', PERSONAL_STORAGE_ACTIVATION: 'blocked',
  AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional-AbCd12',
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_REVIEW_SHA256: '3'.repeat(64),
  QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001,fictional-workforce-00001',
});
it('admits exact compiled successor without widening the old 107 profile', () => {
  expect(() => assertSuccessorQualificationBinding(env(), build, 'PERSONAL_STORAGE_ACTIVATION')).not.toThrow();
  expect(() => assertInventoryQualificationBinding(env(), build as never, 'PERSONAL_STORAGE_ACTIVATION')).toThrow('inventory_qualification_binding_refused');
});
it.each([
  ['SUCCESSOR_QUALIFICATION_PROFILE', 'adopted-plan-inventory-qualification/1'], ['INVENTORY_QUALIFICATION_PROFILE', 'adopted-plan-inventory-qualification/1'],
  ['SOURCE_COMMIT', '4'.repeat(40)], ['SOURCE_INPUT_SHA256', '4'.repeat(64)], ['MIGRATION_RELEASE_SHA256', '4'.repeat(64)],
  ['MIGRATION_ASSEMBLY_SHA256', '4'.repeat(64)], ['PHI_ALLOWED', 'true'], ['PERSONAL_STORAGE_ACTIVATION', 'approved'],
  ['AWS_REGION', 'us-west-2'], ['DEPLOYMENT_ACCOUNT_ID', '173535830222'], ['CLINICAL_DATABASE_NAME', 'clinical_core'],
  ['CLINICAL_DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional'],
  ['CLINICAL_DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/fullscript-worker-fictional'],
  ['QUALIFICATION_EXECUTION', 'invalid'], ['QUALIFICATION_REVIEW_SHA256', ''], ['QUALIFICATION_IDENTITY_SUBJECTS', ''],
])('refuses changed %s before importing a parent', async (key, value) => {
  const load = vi.fn(async () => () => 'must not run');
  const handle = createSuccessorQualificationEnvelope(() => ({ ...env(), [key]: value }), build, 'PERSONAL_STORAGE_ACTIVATION', 'api', load);
  expect(await handle()).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' }); expect(load).not.toHaveBeenCalled();
});
it('refuses bad compiled identity, count, assembly, source and worker credential before imports', async () => {
  for (const changed of [{ ...build, migrationCount: 112 }, { ...build, migrationReleaseSha256: '4'.repeat(64) },
    { ...build, migrationAssemblySha256: '4'.repeat(64) }, { ...build, sourceInputSha256: '0'.repeat(64) },
    { ...build, sourceClean: false }, { ...build, sourceCommit: 'bad' }]) {
    const load = vi.fn(async () => () => 'must not run');
    const handle = createSuccessorQualificationEnvelope(env, changed as SuccessorQualificationBuild, 'PERSONAL_STORAGE_ACTIVATION', 'api', load);
    expect(await handle()).toMatchObject({ statusCode: 503 }); expect(load).not.toHaveBeenCalled();
  }
  expect(() => assertSuccessorQualificationBinding(env(), build, 'PERSONAL_STORAGE_ACTIVATION', 'fullscript-worker'))
    .toThrow('successor_qualification_binding_refused');
});
it('keeps disabled execution disabled and propagates a worker refusal as failure', async () => {
  const load = vi.fn(async () => () => 'must not run');
  const handle = createSuccessorQualificationEnvelope(() => ({ ...env(), QUALIFICATION_EXECUTION: 'disabled' }), build,
    'PERSONAL_STORAGE_ACTIVATION', 'worker', load);
  await expect(handle()).rejects.toThrow('successor_qualification_unavailable'); expect(load).not.toHaveBeenCalled();
});
it('loads only once but refuses environment changes across import and between requests', async () => {
  const e = env(), invoke = vi.fn(() => 'fictional-result'), load = vi.fn(async () => invoke);
  const handle = createSuccessorQualificationEnvelope(() => e, build, 'PERSONAL_STORAGE_ACTIVATION', 'api', load);
  expect(await handle('input')).toBe('fictional-result'); expect(await handle()).toBe('fictional-result'); expect(load).toHaveBeenCalledOnce();
  e.SOURCE_INPUT_SHA256 = '4'.repeat(64); expect(await handle()).toMatchObject({ statusCode: 503 }); expect(invoke).toHaveBeenCalledTimes(2);
  const changed = env(), parent = vi.fn(() => 'must not run');
  const delayed = createSuccessorQualificationEnvelope(() => changed, build, 'PERSONAL_STORAGE_ACTIVATION', 'api', async () => {
    changed.MIGRATION_ASSEMBLY_SHA256 = '4'.repeat(64); return parent;
  });
  expect(await delayed()).toMatchObject({ statusCode: 503 }); expect(parent).not.toHaveBeenCalled();
});
it.each(['api', 'worker'] as const)('allows per-invocation trace changes for %s without ignoring authority drift', async kind => {
  const e = env(), invoke = vi.fn(() => 'fictional-result');
  const handle = createSuccessorQualificationEnvelope(() => e, build, 'PERSONAL_STORAGE_ACTIVATION', kind, async () => {
    e._X_AMZN_TRACE_ID = 'fictional-trace-one'; return invoke;
  });
  expect(await handle()).toBe('fictional-result');
  e._X_AMZN_TRACE_ID = 'fictional-trace-two'; expect(await handle()).toBe('fictional-result');
  delete e._X_AMZN_TRACE_ID; expect(await handle()).toBe('fictional-result');
  e.EXTRA_REVIEW = 'changed';
  if (kind === 'worker') await expect(handle()).rejects.toThrow('successor_qualification_unavailable');
  else expect(await handle()).toMatchObject({ statusCode: 503 });
  expect(invoke).toHaveBeenCalledTimes(3);
});
