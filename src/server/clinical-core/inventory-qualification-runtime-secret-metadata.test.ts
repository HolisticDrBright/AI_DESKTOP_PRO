import { expect, it } from 'vitest';
import type { execFileSync } from 'node:child_process';
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical } from './inventory-qualification-artifacts';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';
import { observeInventoryRuntimeSecretMetadata, type InventoryRuntimeSecretMetadataBinding } from './inventory-qualification-runtime-secret-metadata';

type Row = Record<string, unknown>;
const object = (v: unknown) => v as Row;
function fixture(sharedKey = false) {
  const binding: InventoryRuntimeSecretMetadataBinding = {
    databaseClusterArn: buildQualificationFoundation().Parameters.DatabaseClusterArn.AllowedValues[0],
    operatorDatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional-operator',
    runtimeCredentialReviewSha256: 'a'.repeat(64),
    api: { secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional-AbCd12',
      kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/11111111-1111-4111-8111-111111111111' },
    fullscriptWorker: { secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/fullscript-worker-fictional-XyZ123',
      kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/22222222-2222-4222-8222-222222222222' },
  };
  if (sharedKey) binding.fullscriptWorker.kmsKeyArn = binding.api.kmsKeyArn;
  const responses: Record<string, Row> = {
    'sts/get-caller-identity': { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional' },
  };
  for (const [purpose, value] of [['api', binding.api], ['worker', binding.fullscriptWorker]] as const) {
    responses[`secretsmanager/describe-secret/${value.secretArn}`] = { ARN: value.secretArn,
      Name: value.secretArn.split(':secret:')[1].replace(/-[A-Za-z0-9]{6}$/, ''), KmsKeyId: value.kmsKeyArn,
      RotationEnabled: true, RotationLambdaARN: `arn:aws:lambda:us-east-2:588966314750:function:fictional-rotate-${purpose}`,
      RotationRules: { AutomaticallyAfterDays: 7, Duration: '2h', ScheduleExpression: 'rate(7 days)' },
      Tags: [{ Key: 'Environment', Value: 'synthetic-staging' }, { Key: 'DataClassification', Value: 'synthetic_only' }, { Key: 'ContainsPhi', Value: 'false' }],
      VersionIdsToStages: { ['a'.repeat(32)]: ['AWSCURRENT'], ['b'.repeat(32)]: ['AWSPREVIOUS'] } };
    responses[`kms/describe-key/${value.kmsKeyArn}`] = { KeyMetadata: { Arn: value.kmsKeyArn, KeyId: value.kmsKeyArn.split('/')[1],
      AWSAccountId: '588966314750', Enabled: true, KeyState: 'Enabled', KeyManager: 'CUSTOMER', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS',
      KeySpec: 'SYMMETRIC_DEFAULT', MultiRegion: false, EncryptionAlgorithms: ['SYMMETRIC_DEFAULT'] } };
    responses[`kms/get-key-rotation-status/${value.kmsKeyArn}`] = { KeyId: value.kmsKeyArn, KeyRotationEnabled: true, RotationPeriodInDays: 365 };
  }
  const calls: Array<[string, string, Record<string, string | string[]>]> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    calls.push([service, operation, structuredClone(parameters)]);
    const key = `${service}/${operation}${parameters.SecretId || parameters.KeyId ? '/' + (parameters.SecretId ?? parameters.KeyId) : ''}`;
    if (!Object.hasOwn(responses, key)) throw Error('unmodeled_read');
    return structuredClone(responses[key]);
  };
  return { binding, responses, calls, read,
    apiSecret: responses[`secretsmanager/describe-secret/${binding.api.secretArn}`],
    workerSecret: responses[`secretsmanager/describe-secret/${binding.fullscriptWorker.secretArn}`] };
}

it('observes both exact independently encrypted runtime secrets twice without claiming credential or rotation qualification', async () => {
  const f = fixture(), report = await observeInventoryRuntimeSecretMetadata(f.binding, f.read);
  expect(report).toMatchObject({ contract: 'inventory-qualification-runtime-secret-metadata/1', credentialMetadataObserved: true,
    customerEncryptionBindingVerified: true, rotationConfigurationObserved: true, observations: 7 });
  expect(f.calls).toHaveLength(14);
  expect(f.calls.filter(c => c[0] === 'secretsmanager').map(c => c[2].SecretId)).toEqual([
    f.binding.api.secretArn, f.binding.fullscriptWorker.secretArn, f.binding.api.secretArn, f.binding.fullscriptWorker.secretArn]);
  expect(report.rotations.api.status).toBe('enabled'); expect(report.rotations.fullscriptWorker.status).toBe('enabled');
  expect(report.observationSha256).toMatch(/^[a-f0-9]{64}$/);
  for (const flag of ['runtimeCredentialsQualified', 'runtimeRotationQualified', 'reviewApprovalVerified', 'keyPolicyReviewed',
    'effectiveGrantsVerified', 'networkVerified', 'liveFleetVerified', 'acceptance', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const)
    expect(report[flag]).toBe(false);
});

it('deduplicates a deliberately shared customer key but never shares secret identities', async () => {
  const f = fixture(true), report = await observeInventoryRuntimeSecretMetadata(f.binding, f.read);
  expect(report.observations).toBe(5); expect(f.calls).toHaveLength(10);
  expect(f.calls.filter(c => c[0] === 'kms' && c[1] === 'describe-key')).toHaveLength(2);
});

it('accepts documented KmsKeyId UUID representation only for the exact customer key', async () => {
  const f = fixture(); f.apiSecret.KmsKeyId = f.binding.api.kmsKeyArn.split('/')[1];
  expect((await observeInventoryRuntimeSecretMetadata(f.binding, f.read)).customerEncryptionBindingVerified).toBe(true);
});

for (const mode of ['missing', 'null', 'disabled']) it(`reports ${mode} rotation honestly rather than inventing an enabled policy`, async () => {
  const f = fixture();
  if (mode === 'missing') { delete f.apiSecret.RotationEnabled; delete f.apiSecret.RotationRules; delete f.apiSecret.RotationLambdaARN; }
  else f.apiSecret.RotationEnabled = mode === 'null' ? null : false;
  const rotation = f.responses[`kms/get-key-rotation-status/${f.binding.api.kmsKeyArn}`];
  rotation.KeyRotationEnabled = false; delete rotation.RotationPeriodInDays;
  const report = await observeInventoryRuntimeSecretMetadata(f.binding, f.read);
  expect(report.rotations.api.status).toBe(mode === 'disabled' ? 'disabled' : 'not_configured');
  expect(report.keyRotation[f.binding.api.kmsKeyArn]).toEqual({ enabled: false, periodInDays: null });
  expect(report.runtimeRotationQualified).toBe(false); expect(report.acceptance).toBe(false);
});

it('refuses malformed, substituted and foreign bindings before any cloud read', async () => {
  const changes: Array<(b: Row) => void> = [b => { delete b.api; }, b => { b.api = []; }, b => { b.phiAllowed = true; },
    b => { b.runtimeCredentialReviewSha256 = '0'.repeat(64); }, b => { b.runtimeCredentialReviewSha256 = ['a'.repeat(64)]; },
    b => { b.databaseClusterArn = 'foreign'; }, b => { b.operatorDatabaseSecretArn = object(b.api).secretArn; },
    b => { object(b.api).secretArn = object(b.fullscriptWorker).secretArn; }, b => { object(b.api).kmsKeyArn = 'alias/aws/secretsmanager'; },
    b => { object(b.fullscriptWorker).kmsKeyArn = String(object(b.fullscriptWorker).kmsKeyArn).replace('588966314750', '173535830222'); },
    b => { object(b.fullscriptWorker).secretArn = String(object(b.fullscriptWorker).secretArn).replace('us-east-2', 'us-east-1'); }];
  for (const change of changes) {
    const f = fixture(), binding = structuredClone(f.binding) as unknown as Row; change(binding);
    await expect(observeInventoryRuntimeSecretMetadata(binding as unknown as InventoryRuntimeSecretMetadataBinding, f.read)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  for (const invalid of [null, [], undefined])
    await expect(observeInventoryRuntimeSecretMetadata(invalid as unknown as InventoryRuntimeSecretMetadataBinding, f.read)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

it('refuses changed encryption, unsafe version stages, external/deleted metadata and invalid rotation on either secret', async () => {
  await observeInventoryRuntimeSecretMetadata(fixture().binding, fixture().read);
  const changes: Array<(secret: Row) => void> = [s => { s.ARN = 'foreign'; }, s => { s.Name = 'foreign'; }, s => { delete s.KmsKeyId; },
    s => { s.KmsKeyId = 'alias/aws/secretsmanager'; }, s => { s.KmsKeyId = '33333333-3333-4333-8333-333333333333'; },
    s => { s.DeletedDate = 1; }, s => { s.OwningService = 'rds'; }, s => { s.Type = 'external'; }, s => { s.SecretString = 'must-not-read'; },
    s => { s.PrimaryRegion = 'us-east-1'; }, s => { s.ReplicationStatus = [{ Region: 'us-east-1' }]; },
    s => { object(s.VersionIdsToStages)['b'.repeat(32)] = ['AWSCURRENT']; }, s => { s.VersionIdsToStages = {}; },
    s => { object(s.VersionIdsToStages)['c'.repeat(32)] = ['AWSPENDING']; object(s.VersionIdsToStages)['d'.repeat(32)] = ['AWSPENDING']; },
    s => { object(s.VersionIdsToStages)['a'.repeat(32)] = ['AWSCURRENT', 'AWSCURRENT']; },
    s => { object(s.VersionIdsToStages)['a'.repeat(32)] = ['unreviewed-stage']; },
    s => { (s.Tags as Row[])[2].Value = 'true'; }, s => { (s.Tags as Row[]).push({ Key: 'Environment', Value: 'synthetic-staging' }); },
    s => { s.RotationEnabled = 'true'; }, s => { delete s.RotationLambdaARN; }, s => { s.RotationRules = {}; },
    s => { s.RotationLambdaARN = 'arn:aws:lambda:us-east-2:173535830222:function:foreign'; },
    s => { object(s.RotationRules).AutomaticallyAfterDays = 0; }, s => { object(s.RotationRules).Duration = '2 days'; },
    s => { object(s.RotationRules).ScheduleExpression = 'invented schedule'; }, s => { object(s.RotationRules).approved = true; }];
  for (const purpose of ['apiSecret', 'workerSecret'] as const) for (const change of changes) {
    const f = fixture(), before = inventoryCanonical(f[purpose]); change(f[purpose]);
    expect(inventoryCanonical(f[purpose])).not.toBe(before);
    await expect(observeInventoryRuntimeSecretMetadata(f.binding, f.read)).rejects.toThrow();
  }
});

it('refuses non-customer, disabled, foreign or rotating key metadata from a valid independent baseline', async () => {
  for (const purpose of ['api', 'fullscriptWorker'] as const) {
    const changes: Array<[string, (row: Row) => void]> = [
      ['describe-key', r => { object(r.KeyMetadata).Enabled = false; }], ['describe-key', r => { object(r.KeyMetadata).KeyManager = 'AWS'; }],
      ['describe-key', r => { object(r.KeyMetadata).Arn = 'foreign'; }], ['describe-key', r => { object(r.KeyMetadata).DeletionDate = 1; }],
      ['get-key-rotation-status', r => { r.KeyId = 'foreign'; }], ['get-key-rotation-status', r => { r.KeyRotationEnabled = 'true'; }],
      ['get-key-rotation-status', r => { r.RotationPeriodInDays = 89; }], ['get-key-rotation-status', r => { r.OnDemandRotationStartDate = 1; }]];
    for (const [operation, change] of changes) {
      const f = fixture(); change(f.responses[`kms/${operation}/${f.binding[purpose].kmsKeyArn}`]);
      await expect(observeInventoryRuntimeSecretMetadata(f.binding, f.read)).rejects.toThrow();
    }
  }
  const f = fixture(); f.responses['sts/get-caller-identity'].Arn = 'arn:aws:iam::588966314750:root';
  await expect(observeInventoryRuntimeSecretMetadata(f.binding, f.read)).rejects.toThrow('runtime_secret_principal_refused');
});

it('repeats actual reads and refuses version, rotation or key drift rather than certifying a torn observation', async () => {
  for (const mode of ['version', 'rotation', 'key']) {
    const f = fixture(); let count = 0;
    await expect(observeInventoryRuntimeSecretMetadata(f.binding, async (s, o, p) => {
      const value = await f.read(s, o, p); ++count;
      if (count > 7 && mode === 'version' && o === 'describe-secret') object(value).VersionIdsToStages = { ['c'.repeat(32)]: ['AWSCURRENT'] };
      if (count > 7 && mode === 'rotation' && o === 'describe-secret') object(value).RotationEnabled = false;
      if (count > 7 && mode === 'key' && o === 'describe-key') object(object(value).KeyMetadata).Enabled = false;
      return value;
    })).rejects.toThrow('runtime_secret_metadata_refused');
  }
});

it('ignores documented access/next-schedule timestamps only and does not turn denied reads into an absent configuration', async () => {
  const f = fixture(); let count = 0;
  expect((await observeInventoryRuntimeSecretMetadata(f.binding, async (s, o, p) => {
    const value = await f.read(s, o, p); ++count;
    if (count > 7 && o === 'describe-secret') { object(value).LastAccessedDate = 123; object(value).NextRotationDate = 456; }
    if (count > 7 && o === 'get-key-rotation-status') object(value).NextRotationDate = 789;
    return value;
  })).credentialMetadataObserved).toBe(true);
  await expect(observeInventoryRuntimeSecretMetadata(f.binding, async () => { throw Error('AccessDenied'); })).rejects.toThrow('AccessDenied');
});

it('uses only the bounded metadata CLI surface and never obtains, writes or rotates a secret', async () => {
  const f = fixture(), calls: string[][] = [];
  const execute = ((_file: string, args: string[]) => {
    calls.push(args); const operation = args[0] + '/' + args[1], idFlag = args[0] === 'secretsmanager' ? '--secret-id' : '--key-id';
    const id = args.includes(idFlag) ? '/' + args[args.indexOf(idFlag) + 1] : '';
    return JSON.stringify(f.responses[operation + id]);
  }) as unknown as typeof execFileSync;
  await observeInventoryRuntimeSecretMetadata(f.binding, inventoryServiceReader(execute));
  expect(calls).toHaveLength(14);
  expect(new Set(calls.map(c => c.slice(0, 2).join('/')))).toEqual(new Set(['sts/get-caller-identity', 'secretsmanager/describe-secret', 'kms/describe-key', 'kms/get-key-rotation-status']));
  for (const call of calls) { expect(call).toContain('ai-synthetic-member'); expect(call).not.toContain('--endpoint-url'); }
});
