import { expect, it } from 'vitest';
import type { execFileSync } from 'node:child_process';
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical } from './inventory-qualification-artifacts';
import { observeInventoryDatabaseDependency, type InventoryDatabaseDependency } from './inventory-qualification-database-dependency';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';
type Row = Record<string, unknown>;
const obj = (v: unknown) => v as Row;
function fixture() {
  const binding: InventoryDatabaseDependency = { databaseClusterArn: buildQualificationFoundation().Parameters.DatabaseClusterArn.AllowedValues[0],
    databaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional-secret',
    secretKmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/11111111-1111-4111-8111-111111111111' };
  const tags = [{ Key: 'DataClassification', Value: 'synthetic_only' }, { Key: 'Environment', Value: 'synthetic-staging' }];
  const responses: Record<string, unknown> = {
    'sts/get-caller-identity': { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional' },
    'rds/describe-db-clusters': { DBClusters: [{ DBClusterArn: binding.databaseClusterArn, Status: 'available', Engine: 'aurora-postgresql',
      StorageEncrypted: true, HttpEndpointEnabled: true, DeletionProtection: true, KmsKeyId: binding.secretKmsKeyArn, TagList: tags,
      MasterUserSecret: { SecretArn: binding.databaseSecretArn, SecretStatus: 'active', KmsKeyId: binding.secretKmsKeyArn } }] },
    'secretsmanager/describe-secret': { ARN: binding.databaseSecretArn, KmsKeyId: binding.secretKmsKeyArn, OwningService: 'rds', RotationEnabled: true,
      RotationRules: { AutomaticallyAfterDays: 7 }, VersionIdsToStages: { ['a'.repeat(32)]: ['AWSCURRENT'], ['b'.repeat(32)]: ['AWSPREVIOUS'] },
      Tags: [...tags, { Key: 'ContainsPhi', Value: 'false' }, { Key: 'aws:rds:primaryDBClusterArn', Value: binding.databaseClusterArn },
        { Key: 'aws:secretsmanager:owningService', Value: 'rds' }] },
    'kms/describe-key': { KeyMetadata: { Arn: binding.secretKmsKeyArn, KeyId: binding.secretKmsKeyArn.split('/')[1], AWSAccountId: '588966314750',
      Enabled: true, KeyState: 'Enabled', KeyManager: 'CUSTOMER', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', KeySpec: 'SYMMETRIC_DEFAULT',
      MultiRegion: false, EncryptionAlgorithms: ['SYMMETRIC_DEFAULT'] } },
    'kms/get-key-rotation-status': { KeyId: binding.secretKmsKeyArn, KeyRotationEnabled: true, RotationPeriodInDays: 365 },
  };
  const calls: Array<[string, string, Record<string, string | string[]>]> = [];
  const read: InventoryServiceRead = async (s, o, p) => { calls.push([s, o, p]); if (!Object.hasOwn(responses, `${s}/${o}`)) throw Error('unmodeled read'); return structuredClone(responses[`${s}/${o}`]); };
  return { binding, responses, read, calls };
}
it('binds RDS-managed secret and customer encryption with repeated read-only metadata, not readiness', async () => {
  const f = fixture(), report = await observeInventoryDatabaseDependency(f.binding, f.read);
  expect(report.databaseCredentialBindingVerified).toBe(true); expect(report.customerEncryptionBindingVerified).toBe(true);
  expect(report.observations).toBe(5); expect(f.calls).toHaveLength(10);
  expect(f.calls[1][2]).toEqual({ DBClusterIdentifier: f.binding.databaseClusterArn });
  expect(f.calls[2][2]).toEqual({ SecretId: f.binding.databaseSecretArn });
  for (const flag of ['identityDependenciesVerified', 'networkVerified', 'keyPolicyReviewed', 'wholeLedgerVerified', 'preservationVerified',
    'liveFleetVerified', 'acceptance', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const) expect(report[flag]).toBe(false);
});
it('refuses wrong bindings before any AWS read', async () => {
  const f = fixture();
  for (const changed of [{ ...f.binding, databaseClusterArn: f.binding.databaseClusterArn.replace('588966314750', '173535830222') },
    { ...f.binding, databaseSecretArn: f.binding.databaseSecretArn.replace('rds!cluster-', 'provider-') },
    { ...f.binding, secretKmsKeyArn: 'alias/aws/rds' }, { ...f.binding, approval: true }])
    await expect(observeInventoryDatabaseDependency(changed, f.read)).rejects.toThrow('database_dependency_binding_refused');
  expect(f.calls).toHaveLength(0);
});
it('rejects mismatched cluster, active secret, synthetic tags, rotation and keys from valid independent baseline', async () => {
  await observeInventoryDatabaseDependency(fixture().binding, fixture().read);
  const changes: Array<[string, (r: Row) => void]> = [];
  const cluster = (fn: (r: Row) => void) => changes.push(['rds/describe-db-clusters', r => fn(obj((r.DBClusters as Row[])[0]))]);
  for (const [name, value] of Object.entries({ DBClusterArn: 'foreign', Status: 'stopped', Engine: 'postgres', StorageEncrypted: false,
    HttpEndpointEnabled: false, DeletionProtection: false, KmsKeyId: 'foreign', PubliclyAccessible: true, PendingModifiedValues: { EngineVersion: 'pending' } }))
    cluster(r => { r[name] = value; });
  cluster(r => { obj(r.MasterUserSecret).SecretArn = 'foreign'; });
  cluster(r => { obj(r.MasterUserSecret).SecretStatus = 'rotating'; });
  cluster(r => { obj(r.MasterUserSecret).KmsKeyId = 'foreign'; });
  cluster(r => { (r.TagList as Row[])[0].Value = 'real'; });
  cluster(r => { (r.TagList as Row[]).push({ Key: 'Environment', Value: 'synthetic-staging' }); });
  changes.push(['rds/describe-db-clusters', r => { r.Marker = 'more'; }]);
  changes.push(['rds/describe-db-clusters', r => { (r.DBClusters as Row[]).push({}); }]);
  for (const [name, value] of Object.entries({ ARN: 'foreign', OwningService: 'user', KmsKeyId: 'foreign', RotationEnabled: false,
    RotationRules: { AutomaticallyAfterDays: 30 }, DeletedDate: 'pending', RotationLambdaARN: 'foreign', Type: 'external',
    PrimaryRegion: 'us-east-1', ReplicationStatus: [{ Region: 'foreign' }], VersionIdsToStages: {} }))
    changes.push(['secretsmanager/describe-secret', r => { r[name] = value; }]);
  changes.push(['secretsmanager/describe-secret', r => { obj(r.VersionIdsToStages)['b'.repeat(32)] = ['AWSCURRENT']; }]);
  changes.push(['secretsmanager/describe-secret', r => { obj(r.VersionIdsToStages)['a'.repeat(32)] = ['AWSCURRENT', 'AWSCURRENT']; }]);
  changes.push(['secretsmanager/describe-secret', r => { (r.Tags as Row[])[2].Value = 'true'; }]);
  changes.push(['secretsmanager/describe-secret', r => { (r.Tags as Row[])[3].Value = 'foreign'; }]);
  for (const [name, value] of Object.entries({ Arn: 'foreign', KeyState: 'PendingDeletion', KeyManager: 'AWS', Enabled: false,
    Origin: 'EXTERNAL', MultiRegion: true, KeySpec: 'RSA_2048', EncryptionAlgorithms: [], CustomKeyStoreId: 'foreign', DeletionDate: 'pending' }))
    changes.push(['kms/describe-key', r => { obj(r.KeyMetadata)[name] = value; }]);
  changes.push(['kms/get-key-rotation-status', r => { r.KeyRotationEnabled = false; }]);
  changes.push(['kms/get-key-rotation-status', r => { r.RotationPeriodInDays = 730; }]);
  changes.push(['sts/get-caller-identity', r => { r.Arn = 'arn:aws:iam::588966314750:root'; }]);
  for (const [operation, change] of changes) {
    const f = fixture(), before = inventoryCanonical(f.responses[operation]); change(obj(f.responses[operation]));
    expect(inventoryCanonical(f.responses[operation])).not.toBe(before);
    await expect(observeInventoryDatabaseDependency(f.binding, f.read)).rejects.toThrow();
  }
});
it('does not convert failed, missing, interrupted or drifting metadata into verified dependencies', async () => {
  const f = fixture();
  await expect(observeInventoryDatabaseDependency(f.binding, async () => { throw Error('AccessDenied'); })).rejects.toThrow('AccessDenied');
  let count = 0;
  await expect(observeInventoryDatabaseDependency(f.binding, async (s, o, p) => {
    const v = await f.read(s, o, p); if (++count === 8) obj(v).RotationEnabled = false; return v;
  })).rejects.toThrow('database_dependency_refused');
});
it('uses exact DB acronym flags and never admits secret-value operations', async () => {
  const calls: string[][] = [], execute = ((_file: string, args: string[]) => { calls.push(args); return '{}'; }) as unknown as typeof execFileSync;
  const read = inventoryServiceReader(execute);
  await read('rds', 'describe-db-clusters', { DBClusterIdentifier: 'fictional' });
  await read('secretsmanager', 'describe-secret', { SecretId: 'fictional' });
  expect(calls[0]).toContain('--db-cluster-identifier'); expect(calls[1]).toContain('--secret-id');
  for (const operation of ['get-secret-value', 'batch-get-secret-value', 'put-secret-value', 'rotate-secret'])
    await expect(read('secretsmanager', operation, { SecretId: 'fictional' })).rejects.toThrow('service_read_operation_refused');
  expect(calls).toHaveLength(2);
});
