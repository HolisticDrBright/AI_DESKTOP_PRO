import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Orchestration unit doubles only. No fictional transport report is hosted
// evidence. Each real component's AWS response/digest tests run separately.
const state = vi.hoisted(() => ({ prepare: vi.fn(), build: vi.fn(), artifact: vi.fn(), ledgerFactory: vi.fn(), ledger: vi.fn(),
  foundation: vi.fn(), database: vi.fn(), runtimeSecrets: vi.fn(), identity: vi.fn(), databaseIdentityFactory: vi.fn(), databaseIdentity: vi.fn(),
  stack: vi.fn(), service: vi.fn(), code: vi.fn(), api: vi.fn(), guard: vi.fn(), dispose: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: state.build }));
vi.mock('./inventory-qualification-configuration', () => ({ prepareInventoryQualificationConfiguration: state.prepare }));
vi.mock('./inventory-qualification-foundation-observer', () => ({ observeInventoryFoundation: state.foundation }));
vi.mock('./inventory-qualification-database-dependency', () => ({ observeInventoryDatabaseDependency: state.database }));
vi.mock('./inventory-qualification-runtime-secret-metadata', () => ({ observeInventoryRuntimeSecretMetadata: state.runtimeSecrets }));
vi.mock('./inventory-qualification-identity-dependency', () => ({ observeInventoryIdentityDependency: state.identity }));
vi.mock('./inventory-qualification-database-identity', () => ({ inventoryDatabaseIdentityReader: state.databaseIdentityFactory }));
vi.mock('./inventory-qualification-stack-observer', () => ({ observeInventoryStackDeclarations: state.stack }));
vi.mock('./inventory-qualification-service-observer', () => ({ observeInventoryCandidateServices: state.service }));
vi.mock('./inventory-qualification-code-observer', () => ({ observeInventoryCodeVersion: state.code }));
vi.mock('./inventory-qualification-api-observer', () => ({ observeInventorySharedApi: state.api }));
vi.mock('./inventory-qualification-ledger', () => ({ inventoryQualificationLedgerArtifact: state.artifact,
  inventoryQualificationLedgerReader: state.ledgerFactory }));
import { observeInventoryQualificationFleet } from './inventory-qualification-fleet-observer';

const args = ['--observe-fleet', '--target=fictional.json'];
const source = { sourceCommit: 'a'.repeat(40), sourceInputSha256: 'b'.repeat(64), sourceClean: true };
function fixture() {
  const candidates = Array.from({ length: 12 }, (_, n) => ({ candidate: `fictional-${n}`, stackName: `fictional-stack-${n}`,
    parameters: { SecretKmsKeyArn: 'fictional-customer-key' }, packages: Array.from({ length: n === 0 ? 2 : 1 }, (_, p) =>
      ({ file: `fictional-${n}-${p}.zip` })) }));
  return { source, artifacts: { source, manifestSha256: 'c'.repeat(64), candidates: candidates.map(c => ({ candidate: c.candidate })) },
    target: { contract: 'inventory-qualification-target/1' as const, target: { schemaVersion: 'aws-clinical-core-qualification-target/3' as const,
      foundationStackName: 'fictional-foundation', databaseClusterArn: 'fictional-cluster', databaseSecretArn: 'fictional-secret',
      databaseName: 'clinical_core_qualification', apiId: 'fictional-api', apiOrigin: 'fictional-origin', exportBucket: 'fictional-exports',
      identitySubjects: { consumer: 'fictional-consumer', foreignConsumer: 'fictional-foreign', workforce: 'fictional-workforce' } },
    identity: { consumerIssuer: 'fictional-consumer-issuer', consumerAudience: 'fictional-consumer-client',
      workforceIssuer: 'fictional-workforce-issuer', workforceAudience: 'fictional-workforce-client' }, organizationId: 'fictional-org',
    artifactBucket: 'fictional-code', candidates }, targetSha256: 'd'.repeat(64), assertUnchanged: state.guard, dispose: state.dispose };
}
beforeEach(() => {
  vi.resetAllMocks();
  state.prepare.mockReturnValue(fixture()); state.build.mockReturnValue('{"fictional":true}');
  state.artifact.mockReturnValue('fictional-exact-107-ledger'); state.ledgerFactory.mockReturnValue(state.ledger);
  state.foundation.mockResolvedValue({ foundationStackId: 'fictional-foundation-stack-id', observationSha256: 'fictional-foundation-digest' });
  state.database.mockResolvedValue({ observationSha256: 'fictional-database-digest' });
  state.runtimeSecrets.mockResolvedValue({ observationSha256: 'fictional-runtime-secret-digest', runtimeCredentialsQualified: false });
  state.identity.mockResolvedValue({ observationSha256: 'fictional-identity-digest', personBindingsSha256: 'e'.repeat(64) });
  state.databaseIdentityFactory.mockReturnValue(state.databaseIdentity);
  state.databaseIdentity.mockResolvedValue({ observationSha256: 'fictional-database-identity-digest' });
  state.ledger.mockResolvedValue({ rows: 107, rolledBack: true });
  state.stack.mockImplementation(async c => ({ candidate: c.candidate, snapshot: { stackId: c.stackName, resources: [], outputs: {} } }));
  state.service.mockImplementation(async (_snapshot, c) => ({ candidate: c.candidate, observationSha256: `fictional-${c.candidate}` }));
  state.code.mockImplementation(async p => ({ file: p.file, uploadedVersionVerified: true }));
  state.api.mockResolvedValue({ observationSha256: 'fictional-api-digest' });
});
afterEach(() => { vi.unstubAllEnvs(); });

it('rebuilds migration bytes, reads all twelve candidates and thirteen versions twice, and never issues acceptance', async () => {
  const result = await observeInventoryQualificationFleet(args);
  expect(state.prepare).toHaveBeenCalledWith(args, '--observe-fleet');
  expect(state.build.mock.calls[0][1]).toEqual(['scripts/build-adopted-plan-inventory-candidate.mjs', '--json']);
  expect(state.artifact).toHaveBeenCalledWith({ fictional: true });
  expect(state.ledgerFactory).toHaveBeenCalledWith('fictional-exact-107-ledger');
  for (const reader of [state.foundation, state.database, state.identity, state.databaseIdentity, state.ledger, state.api]) expect(reader).toHaveBeenCalledTimes(2);
  expect(state.databaseIdentityFactory).toHaveBeenCalledWith('fictional-exact-107-ledger');
  expect(state.stack).toHaveBeenCalledTimes(24); expect(state.service).toHaveBeenCalledTimes(24); expect(state.code).toHaveBeenCalledTimes(26);
  expect(state.code.mock.calls.every(call => call.length === 3 && call[1] === source.sourceCommit)).toBe(true);
  expect(state.service.mock.calls.every(call => call.length === 3 && call[0].stackId === call[1].stackName
    && call[1].candidate === call[2].candidate)).toBe(true);
  for (const call of state.api.mock.calls) {
    expect(Object.keys(call[1])).toHaveLength(12);
    expect(call[2]).toBe('fictional-foundation-stack-id'); expect(call).toHaveLength(4);
  }
  expect(result).toMatchObject({ status: 'not_completed', passes: 2, candidates: 12, packages: 13,
    observedResourcePlane: true, successorLedgerObserved: true, liveFleetVerified: false, acceptance: false,
    identityConfigurationVerified: true, designatedSyntheticSubjectsVerified: true, databaseIdentityAuthorityVerified: true,
    identityDependenciesVerified: false, networkVerified: false, providerDependenciesVerified: false,
    humanReviewsVerified: false, phiAllowed: false, mutations: false });
  expect(result.observationSha256).toMatch(/^[a-f0-9]{64}$/); expect(state.dispose).toHaveBeenCalledTimes(1);
  expect(state.runtimeSecrets).not.toHaveBeenCalled(); expect(result.runtimeSecretMetadataObserved).toBe(false);
});
it('passes exact shared foundation/database bindings rather than environment overrides', async () => {
  vi.stubEnv('DATABASE_NAME', 'clinical_core'); vi.stubEnv('QUALIFICATION_VERIFIED', 'true'); vi.stubEnv('PHI_ALLOWED', 'true');
  const result = await observeInventoryQualificationFleet(args);
  expect(state.ledger).toHaveBeenCalledWith({ DatabaseName: 'clinical_core_qualification',
    DatabaseClusterArn: 'fictional-cluster', DatabaseSecretArn: 'fictional-secret' });
  expect(state.database).toHaveBeenCalledWith({ databaseClusterArn: 'fictional-cluster', databaseSecretArn: 'fictional-secret', secretKmsKeyArn: 'fictional-customer-key' });
  expect(state.identity).toHaveBeenCalledWith({ identity: fixture().target.identity, organizationId: 'fictional-org',
    subjects: fixture().target.target.identitySubjects });
  expect(state.identity.mock.calls.every(c => c.length === 1)).toBe(true);
  expect(state.databaseIdentity).toHaveBeenCalledWith({ database: { DatabaseName: 'clinical_core_qualification',
    DatabaseClusterArn: 'fictional-cluster', DatabaseSecretArn: 'fictional-secret' }, organizationId: 'fictional-org',
    subjects: fixture().target.target.identitySubjects, cognitoPersonBindingsSha256: 'e'.repeat(64) });
  expect(state.databaseIdentity.mock.calls.every(c => c.length === 1)).toBe(true);
  expect(state.foundation).toHaveBeenCalledWith({ foundationStackName: 'fictional-foundation', databaseClusterArn: 'fictional-cluster',
    databaseSecretArn: 'fictional-secret', apiId: 'fictional-api', apiOrigin: 'fictional-origin', artifactBucket: 'fictional-code', exportBucket: 'fictional-exports' });
  expect(result.phiAllowed).toBe(false); expect(result.liveFleetVerified).toBe(false); expect(result.acceptance).toBe(false);
});

it('routes separated fleet administrative reads to the operator and never substitutes the request credential', async () => {
  const f = fixture();
  const separated = { ...f, target: { ...f.target, contract: 'inventory-qualification-target/2',
    target: { ...f.target.target, schemaVersion: 'aws-clinical-core-qualification-target/4',
      databaseSecretArn: 'fictional-api-secret', operatorDatabaseSecretArn: 'fictional-operator-secret',
      runtimeCredentialReviewSha256: 'f'.repeat(64) },
    databaseCredentials: { clusterKmsKeyArn: 'fictional-cluster-key', operatorSecretKmsKeyArn: 'fictional-operator-key',
      apiSecretKmsKeyArn: 'fictional-customer-key', fullscriptWorkerDatabaseSecretArn: 'fictional-worker-secret',
      fullscriptWorkerSecretKmsKeyArn: 'fictional-worker-key' } } };
  state.prepare.mockReturnValue(separated);
  const result = await observeInventoryQualificationFleet(args);
  expect(state.foundation).toHaveBeenCalledWith({ foundationStackName: 'fictional-foundation', databaseClusterArn: 'fictional-cluster',
    databaseSecretArn: 'fictional-operator-secret', apiId: 'fictional-api', apiOrigin: 'fictional-origin',
    artifactBucket: 'fictional-code', exportBucket: 'fictional-exports', runtimeCredentials: {
      apiSecretArn: 'fictional-api-secret', fullscriptWorkerSecretArn: 'fictional-worker-secret', reviewSha256: 'f'.repeat(64) } });
  expect(state.database).toHaveBeenCalledWith({ databaseClusterArn: 'fictional-cluster', databaseSecretArn: 'fictional-operator-secret',
    secretKmsKeyArn: 'fictional-operator-key', clusterKmsKeyArn: 'fictional-cluster-key' });
  for (const [binding] of state.ledger.mock.calls) expect(binding.DatabaseSecretArn).toBe('fictional-operator-secret');
  for (const [binding] of state.databaseIdentity.mock.calls) expect(binding.database.DatabaseSecretArn).toBe('fictional-operator-secret');
  expect(result).toMatchObject({ contract: 'inventory-qualification-fleet-observation/2', runtimeCredentialsQualified: false,
    acceptance: false, phiAllowed: false, mutations: false });
  // The actual coordinator must observe both runtime secrets, not merely
  // accept their declarations or reuse the operator metadata report.
  expect(state.runtimeSecrets).toHaveBeenCalledTimes(2);
  expect(state.runtimeSecrets).toHaveBeenCalledWith({ databaseClusterArn: 'fictional-cluster', operatorDatabaseSecretArn: 'fictional-operator-secret',
    runtimeCredentialReviewSha256: 'f'.repeat(64), api: { secretArn: 'fictional-api-secret', kmsKeyArn: 'fictional-customer-key' },
    fullscriptWorker: { secretArn: 'fictional-worker-secret', kmsKeyArn: 'fictional-worker-key' } });
  expect(result).toMatchObject({ runtimeSecretMetadataObserved: true, runtimeRotationQualified: false });
});

for (const mode of ['failure', 'drift']) it(`does not issue a fleet report after runtime secret ${mode}`, async () => {
  const f = fixture();
  state.prepare.mockReturnValue({ ...f, target: { ...f.target, contract: 'inventory-qualification-target/2', target: {
    ...f.target.target, schemaVersion: 'aws-clinical-core-qualification-target/4', databaseSecretArn: 'fictional-api',
    operatorDatabaseSecretArn: 'fictional-operator', runtimeCredentialReviewSha256: 'f'.repeat(64) }, databaseCredentials: {
      apiSecretKmsKeyArn: 'fictional-customer-key', fullscriptWorkerDatabaseSecretArn: 'fictional-worker',
      clusterKmsKeyArn: 'fictional-storage-key', operatorSecretKmsKeyArn: 'fictional-operator-key', fullscriptWorkerSecretKmsKeyArn: 'fictional-worker-key' } } });
  if (mode === 'failure') state.runtimeSecrets.mockRejectedValueOnce(Error('runtime_secret_read_failed'));
  else state.runtimeSecrets.mockResolvedValueOnce({ observationSha256: 'changed-runtime-secret' });
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow(mode === 'failure' ? 'runtime_secret_read_failed' : 'fleet_observation_changed');
  expect(state.dispose).toHaveBeenCalledTimes(1);
  if (mode === 'failure') { expect(state.ledger).not.toHaveBeenCalled(); expect(state.runtimeSecrets).toHaveBeenCalledTimes(1); }
});

for (const mode of ['unknown-contract', 'mixed-legacy', 'missing-operator', 'missing-review', 'missing-credentials', 'wrong-request-key'])
  it(`refuses ${mode} instead of falling back to request authority`, async () => {
    const f = fixture();
    const target: Record<string, unknown> = { ...f.target, contract: 'inventory-qualification-target/2', target: {
      ...f.target.target, schemaVersion: 'aws-clinical-core-qualification-target/4', databaseSecretArn: 'fictional-api-secret',
      operatorDatabaseSecretArn: 'fictional-operator-secret', runtimeCredentialReviewSha256: 'f'.repeat(64) },
      databaseCredentials: { apiSecretKmsKeyArn: 'fictional-customer-key' } };
    if (mode === 'unknown-contract') target.contract = 'inventory-qualification-target/3';
    if (mode === 'mixed-legacy') target.contract = 'inventory-qualification-target/1';
    if (mode === 'missing-operator') delete (target.target as Record<string, unknown>).operatorDatabaseSecretArn;
    if (mode === 'missing-review') delete (target.target as Record<string, unknown>).runtimeCredentialReviewSha256;
    if (mode === 'missing-credentials') delete target.databaseCredentials;
    if (mode === 'wrong-request-key') (target.databaseCredentials as Record<string, unknown>).apiSecretKmsKeyArn = 'foreign';
    state.prepare.mockReturnValue({ ...f, target });
    await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('fleet_runtime_credential_binding_refused');
    expect(state.foundation).not.toHaveBeenCalled(); expect(state.ledger).not.toHaveBeenCalled(); expect(state.dispose).toHaveBeenCalledTimes(1);
  });
for (const keyMode of ['missing', 'conflicting']) it(`refuses ${keyMode} database key bindings before AWS`, async () => {
  const f = fixture();
  for (const c of f.target.candidates) c.parameters = keyMode === 'missing' ? {} as typeof c.parameters : c.parameters;
  if (keyMode === 'conflicting') f.target.candidates[1].parameters.SecretKmsKeyArn = 'foreign-key';
  state.prepare.mockReturnValue(f);
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('fleet_database_key_binding_refused');
  expect(state.foundation).not.toHaveBeenCalled(); expect(state.dispose).toHaveBeenCalledTimes(1);
});
for (const stage of ['build', 'artifact', 'guard', 'foundation', 'database', 'identity', 'databaseIdentityFactory', 'databaseIdentity', 'ledger', 'stack', 'service', 'code', 'api'] as const)
  it(`refuses failed ${stage}, never retries and disposes only its owned temporary build`, async () => {
    state[stage].mockImplementationOnce(() => { throw Error(`fictional_${stage}_failure`); });
    await expect(observeInventoryQualificationFleet(args)).rejects.toThrow(`fictional_${stage}_failure`);
    expect(state[stage]).toHaveBeenCalledTimes(1); expect(state.dispose).toHaveBeenCalledTimes(1);
  });
it('malformed migration output refuses before AWS or a ledger transaction', async () => {
  state.build.mockReturnValue('not-json');
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('inventory_ledger_artifact_refused');
  expect(state.foundation).not.toHaveBeenCalled(); expect(state.ledger).not.toHaveBeenCalled();
});
for (const component of ['foundation', 'database', 'identity', 'databaseIdentity', 'ledger', 'api'] as const) it(`refuses cross-window ${component} drift`, async () => {
  state[component].mockResolvedValueOnce({ stable: 'initial', foundationStackId: 'fictional-foundation-stack-id' });
  state[component].mockResolvedValueOnce({ stable: 'changed', foundationStackId: 'fictional-foundation-stack-id' });
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('fleet_observation_changed');
  expect(state.dispose).toHaveBeenCalledTimes(1);
});
it('refuses deployed service drift between complete passes', async () => {
  state.service.mockResolvedValueOnce({ observationSha256: 'changed-service-digest' });
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('fleet_observation_changed');
});
it('refuses code-version drift between complete passes', async () => {
  state.code.mockResolvedValueOnce({ uploadedVersionVerified: true, file: 'changed-version' });
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('fleet_observation_changed');
});
it('source or target changes after the final pass refuse a report', async () => {
  // one post-build guard + two passes with fourteen guards each + final guard
  state.guard.mockImplementation(() => { if (state.guard.mock.calls.length === 30) throw Error('source_or_target_changed'); });
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('source_or_target_changed');
  expect(state.dispose).toHaveBeenCalledTimes(1);
});
it('disposal failure refuses rather than reporting a successfully closed observation', async () => {
  state.dispose.mockImplementation(() => { throw Error('temporary_cleanup_refused'); });
  await expect(observeInventoryQualificationFleet(args)).rejects.toThrow('temporary_cleanup_refused');
});
