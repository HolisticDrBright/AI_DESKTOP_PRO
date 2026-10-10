if (typeof window !== 'undefined') throw Error('inventory database dependency observation is server-only');
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';

type Row = Record<string, unknown>;
export type InventoryDatabaseDependency = { databaseClusterArn: string; databaseSecretArn: string; secretKmsKeyArn: string };
const object = (v: unknown): Row => inventoryRecord(v) ? v : inventoryRefuse('database_dependency_shape_refused');
const equal = (a: unknown, b: unknown) => {
  if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('database_dependency_refused');
};
function tags(v: unknown): Row {
  if (!Array.isArray(v) || v.length > 128) return inventoryRefuse('database_dependency_tags_refused');
  const result: Row = {};
  for (const row of v) {
    const r = object(row);
    if (Object.keys(r).sort().join(',') !== 'Key,Value' || typeof r.Key !== 'string' || typeof r.Value !== 'string'
      || Object.hasOwn(result, r.Key)) return inventoryRefuse('database_dependency_tags_refused');
    result[r.Key] = r.Value;
  }
  equal(result.DataClassification, 'synthetic_only'); equal(result.Environment, 'synthetic-staging');
  return result;
}
function stable(service: string, operation: string, input: unknown) {
  const copy = structuredClone(input);
  // Access/rotation timestamps can advance during a read-only inspection.
  // Rotation configuration and version-stage identities remain in the digest.
  if (service === 'secretsmanager' && operation === 'describe-secret' && inventoryRecord(copy))
    for (const k of ['LastAccessedDate', 'NextRotationDate']) delete copy[k];
  if (service === 'kms' && operation === 'get-key-rotation-status' && inventoryRecord(copy)) delete copy.NextRotationDate;
  return copy;
}

/** RDS-managed credential/encryption binding, not full dependency or security
 * qualification. Never reads a secret value, provider key, record or user data.
 * No identity, network, database schema, preservation or human-review claim. */
export async function observeInventoryDatabaseDependency(input: InventoryDatabaseDependency,
  transport: InventoryServiceRead = inventoryServiceReader()) {
  const b = structuredClone(input);
  if (!inventoryRecord(b) || Object.keys(b).sort().join(',') !== 'databaseClusterArn,databaseSecretArn,secretKmsKeyArn'
    || !buildQualificationFoundation().Parameters.DatabaseClusterArn.AllowedValues.includes(b.databaseClusterArn)
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$/.test(b.databaseSecretArn)
    || !/^arn:aws:kms:us-east-2:588966314750:key\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.secretKmsKeyArn))
    return inventoryRefuse('database_dependency_binding_refused');
  const observations: Array<{ service: string; operation: string; parameters: Record<string, string | string[]>; sha256: string }> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    const v = await transport(service, operation, parameters);
    observations.push({ service, operation, parameters: structuredClone(parameters), sha256: inventorySha(inventoryCanonical(stable(service, operation, v))) });
    return v;
  };
  const principal = object(await read('sts', 'get-caller-identity', {}));
  if (principal.Account !== '588966314750' || typeof principal.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9+=,.@_-]+$/.test(principal.Arn))
    return inventoryRefuse('database_dependency_principal_refused');
  const clusters = object(await read('rds', 'describe-db-clusters', { DBClusterIdentifier: b.databaseClusterArn }));
  if (clusters.Marker !== undefined || !Array.isArray(clusters.DBClusters) || clusters.DBClusters.length !== 1)
    return inventoryRefuse('database_dependency_shape_refused');
  const cluster = object(clusters.DBClusters[0]);
  for (const [key, value] of Object.entries({ DBClusterArn: b.databaseClusterArn, Status: 'available', Engine: 'aurora-postgresql',
    StorageEncrypted: true, HttpEndpointEnabled: true, DeletionProtection: true, KmsKeyId: b.secretKmsKeyArn })) equal(cluster[key], value);
  if (cluster.PubliclyAccessible === true || Object.keys(object(cluster.PendingModifiedValues ?? {})).length)
    return inventoryRefuse('database_dependency_refused');
  equal(cluster.MasterUserSecret, { SecretArn: b.databaseSecretArn, SecretStatus: 'active', KmsKeyId: b.secretKmsKeyArn });
  tags(cluster.TagList);
  const secret = object(await read('secretsmanager', 'describe-secret', { SecretId: b.databaseSecretArn }));
  for (const [key, value] of Object.entries({ ARN: b.databaseSecretArn, KmsKeyId: b.secretKmsKeyArn, OwningService: 'rds', RotationEnabled: true })) equal(secret[key], value);
  equal(secret.RotationRules, { AutomaticallyAfterDays: 7 });
  if (secret.DeletedDate !== undefined || secret.RotationLambdaARN !== undefined || secret.Type !== undefined
    || secret.PrimaryRegion !== undefined && secret.PrimaryRegion !== 'us-east-2'
    || secret.ReplicationStatus !== undefined && (!Array.isArray(secret.ReplicationStatus) || secret.ReplicationStatus.length))
    return inventoryRefuse('database_dependency_refused');
  const secretTags = tags(secret.Tags); equal(secretTags.ContainsPhi, 'false');
  equal(secretTags['aws:rds:primaryDBClusterArn'], b.databaseClusterArn); equal(secretTags['aws:secretsmanager:owningService'], 'rds');
  const versions = object(secret.VersionIdsToStages), current = Object.entries(versions).filter(([, stages]) => Array.isArray(stages) && stages.includes('AWSCURRENT'));
  if (Object.keys(versions).length > 128 || current.length !== 1 || Object.entries(versions).some(([id, stages]) =>
    !/^[A-Za-z0-9-]{32,64}$/.test(id) || !Array.isArray(stages) || !stages.length || stages.length > 20
    || new Set(stages).size !== stages.length || stages.some(s => typeof s !== 'string' || !['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING'].includes(s))))
    return inventoryRefuse('database_dependency_versions_refused');
  const key = object(object(await read('kms', 'describe-key', { KeyId: b.secretKmsKeyArn })).KeyMetadata);
  for (const [name, expected] of Object.entries({ Arn: b.secretKmsKeyArn, KeyId: b.secretKmsKeyArn.split('/')[1], AWSAccountId: '588966314750',
    Enabled: true, KeyState: 'Enabled', KeyManager: 'CUSTOMER', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', KeySpec: 'SYMMETRIC_DEFAULT', MultiRegion: false })) equal(key[name], expected);
  equal(key.EncryptionAlgorithms, ['SYMMETRIC_DEFAULT']);
  if (key.DeletionDate !== undefined || key.ValidTo !== undefined || key.CustomKeyStoreId !== undefined || key.XksKeyConfiguration !== undefined)
    return inventoryRefuse('database_dependency_refused');
  const rotation = object(await read('kms', 'get-key-rotation-status', { KeyId: b.secretKmsKeyArn }));
  equal(rotation.KeyId, b.secretKmsKeyArn); equal(rotation.KeyRotationEnabled, true); equal(rotation.RotationPeriodInDays ?? 365, 365);
  for (const o of observations) equal(inventorySha(inventoryCanonical(stable(o.service, o.operation,
    await transport(o.service, o.operation, o.parameters)))), o.sha256);
  return { contract: 'inventory-qualification-database-dependency/1', databaseCredentialBindingVerified: true, customerEncryptionBindingVerified: true,
    observations: observations.length, observationSha256: inventorySha(inventoryCanonical(observations)),
    identityDependenciesVerified: false, networkVerified: false, keyPolicyReviewed: false, wholeLedgerVerified: false, preservationVerified: false,
    liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
}
