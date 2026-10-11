if (typeof window !== 'undefined') throw Error('inventory runtime secret observation is server-only');
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';

type Row = Record<string, unknown>;
export type InventoryRuntimeSecretMetadataBinding = {
  databaseClusterArn: string; operatorDatabaseSecretArn: string; runtimeCredentialReviewSha256: string;
  api: { secretArn: string; kmsKeyArn: string };
  fullscriptWorker: { secretArn: string; kmsKeyArn: string };
};
const keyPattern = /^arn:aws:kms:us-east-2:588966314750:key\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = (v: unknown): Row => inventoryRecord(v) ? v : inventoryRefuse('runtime_secret_metadata_shape_refused');
const same = (a: unknown, b: unknown) => {
  if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('runtime_secret_metadata_refused');
};
function exact(v: unknown, names: string[]): Row {
  const row = object(v);
  if (Object.keys(row).sort().join(',') !== [...names].sort().join(',')) return inventoryRefuse('runtime_secret_binding_refused');
  return row;
}
function slot(v: unknown, purpose: 'runtime-api' | 'fullscript-worker') {
  const row = exact(v, ['secretArn', 'kmsKeyArn']);
  if (typeof row.secretArn !== 'string' || !new RegExp(`^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/${purpose}-[A-Za-z0-9/_+=.@-]+$`).test(row.secretArn)
    || row.secretArn.length > 2048 || typeof row.kmsKeyArn !== 'string' || !keyPattern.test(row.kmsKeyArn))
    return inventoryRefuse('runtime_secret_binding_refused');
  return { secretArn: row.secretArn, kmsKeyArn: row.kmsKeyArn };
}
function syntheticTags(v: unknown) {
  if (!Array.isArray(v) || v.length > 128) return inventoryRefuse('runtime_secret_metadata_shape_refused');
  const result: Row = {};
  for (const value of v) {
    const tag = exact(value, ['Key', 'Value']);
    if (typeof tag.Key !== 'string' || !tag.Key.length || tag.Key.length > 128 || typeof tag.Value !== 'string'
      || tag.Value.length > 256 || Object.hasOwn(result, tag.Key)) return inventoryRefuse('runtime_secret_metadata_shape_refused');
    result[tag.Key] = tag.Value;
  }
  same(result.DataClassification, 'synthetic_only'); same(result.Environment, 'synthetic-staging'); same(result.ContainsPhi, 'false');
}
function versions(v: unknown) {
  const row = object(v), entries = Object.entries(row);
  if (!entries.length || entries.length > 128 || entries.some(([id, stages]) => !/^[A-Za-z0-9-]{32,64}$/.test(id)
    || !Array.isArray(stages) || !stages.length || stages.length > 20 || new Set(stages).size !== stages.length
    || stages.some(s => typeof s !== 'string' || !['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING'].includes(s))))
    return inventoryRefuse('runtime_secret_versions_refused');
  for (const stage of ['AWSCURRENT', 'AWSPREVIOUS', 'AWSPENDING']) {
    const count = entries.filter(([, value]) => (value as string[]).includes(stage)).length;
    if (count > 1 || stage === 'AWSCURRENT' && count !== 1) return inventoryRefuse('runtime_secret_versions_refused');
  }
}
function rotation(secret: Row) {
  // DescribeSecret omits RotationEnabled for never-configured secrets. False
  // can retain a previous schedule. Neither is silently upgraded to enabled.
  if (secret.RotationEnabled !== undefined && secret.RotationEnabled !== null && typeof secret.RotationEnabled !== 'boolean')
    return inventoryRefuse('runtime_secret_rotation_shape_refused');
  const status = secret.RotationEnabled === true ? 'enabled' : secret.RotationEnabled === false ? 'disabled' : 'not_configured';
  const rules = secret.RotationRules === undefined ? {} : object(secret.RotationRules);
  if (Object.keys(rules).some(k => !['AutomaticallyAfterDays', 'Duration', 'ScheduleExpression'].includes(k))
    || rules.AutomaticallyAfterDays !== undefined && (!Number.isSafeInteger(rules.AutomaticallyAfterDays) || Number(rules.AutomaticallyAfterDays) < 1)
    || rules.Duration !== undefined && (typeof rules.Duration !== 'string' || !/^[1-9][0-9]*h$/.test(rules.Duration) || rules.Duration.length > 16)
    || rules.ScheduleExpression !== undefined && (typeof rules.ScheduleExpression !== 'string' || rules.ScheduleExpression.length > 256
      || !/^(?:rate|cron)\([^\x00-\x1f\x7f]+\)$/.test(rules.ScheduleExpression))
    || secret.RotationLambdaARN !== undefined && (typeof secret.RotationLambdaARN !== 'string' || secret.RotationLambdaARN.length > 2048
      || !/^arn:aws:lambda:us-east-2:588966314750:function:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/.test(secret.RotationLambdaARN))
    || status === 'enabled' && (secret.RotationLambdaARN === undefined || rules.AutomaticallyAfterDays === undefined && rules.ScheduleExpression === undefined))
    return inventoryRefuse('runtime_secret_rotation_shape_refused');
  return { status, configurationSha256: inventorySha(inventoryCanonical({ status, rules, lambda: secret.RotationLambdaARN ?? null })) };
}
function stable(operation: string, input: unknown) {
  const copy = structuredClone(input);
  if (inventoryRecord(copy) && operation === 'describe-secret')
    for (const key of ['LastAccessedDate', 'NextRotationDate']) delete copy[key];
  if (inventoryRecord(copy) && operation === 'get-key-rotation-status') delete copy.NextRotationDate;
  return copy;
}

/** Public metadata only. This cannot certify stored credentials, privileges,
 * rotation execution/authority, IAM effectiveness, review approval or PHI. */
export async function observeInventoryRuntimeSecretMetadata(input: InventoryRuntimeSecretMetadataBinding,
  transport: InventoryServiceRead = inventoryServiceReader()) {
  const root = exact(structuredClone(input), ['databaseClusterArn', 'operatorDatabaseSecretArn', 'runtimeCredentialReviewSha256', 'api', 'fullscriptWorker']);
  if (typeof root.databaseClusterArn !== 'string' || !buildQualificationFoundation().Parameters.DatabaseClusterArn.AllowedValues.includes(root.databaseClusterArn)
    || typeof root.operatorDatabaseSecretArn !== 'string' || root.operatorDatabaseSecretArn.length > 2048
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$/.test(root.operatorDatabaseSecretArn)
    || typeof root.runtimeCredentialReviewSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(root.runtimeCredentialReviewSha256) || /^0+$/.test(root.runtimeCredentialReviewSha256))
    return inventoryRefuse('runtime_secret_binding_refused');
  const api = slot(root.api, 'runtime-api'), worker = slot(root.fullscriptWorker, 'fullscript-worker');
  if (new Set([root.operatorDatabaseSecretArn, api.secretArn, worker.secretArn]).size !== 3) return inventoryRefuse('runtime_secret_binding_refused');
  const observations: Array<{ service: string; operation: string; parameters: Record<string, string | string[]>; sha256: string }> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    const value = await transport(service, operation, parameters);
    observations.push({ service, operation, parameters: structuredClone(parameters), sha256: inventorySha(inventoryCanonical(stable(operation, value))) });
    return value;
  };
  const principal = object(await read('sts', 'get-caller-identity', {}));
  if (principal.Account !== '588966314750' || typeof principal.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9+=,.@_-]+$/.test(principal.Arn))
    return inventoryRefuse('runtime_secret_principal_refused');
  const rotations = {} as Record<'api' | 'fullscriptWorker', ReturnType<typeof rotation>>;
  const known = ['ARN', 'CreatedDate', 'Description', 'KmsKeyId', 'LastAccessedDate', 'LastChangedDate', 'LastRotatedDate', 'Name',
    'NextRotationDate', 'PrimaryRegion', 'ReplicationStatus', 'RotationEnabled', 'RotationLambdaARN', 'RotationRules', 'Tags', 'VersionIdsToStages'];
  for (const [purpose, binding] of [['api', api], ['fullscriptWorker', worker]] as const) {
    const secret = object(await read('secretsmanager', 'describe-secret', { SecretId: binding.secretArn }));
    if (Object.keys(secret).some(k => !known.includes(k)) || secret.ARN !== binding.secretArn
      // AWS permits a key ID or ARN here. Both must denote the exact key; no
      // alias or default AWS-managed key is accepted as an inferred match.
      || secret.KmsKeyId !== binding.kmsKeyArn && secret.KmsKeyId !== binding.kmsKeyArn.split('/')[1]
      || secret.PrimaryRegion !== undefined && secret.PrimaryRegion !== 'us-east-2'
      || secret.ReplicationStatus !== undefined && (!Array.isArray(secret.ReplicationStatus) || secret.ReplicationStatus.length)
      || secret.Name !== undefined && (typeof secret.Name !== 'string' || secret.Name !== binding.secretArn.split(':secret:')[1].replace(/-[A-Za-z0-9]{6}$/, '')))
      return inventoryRefuse('runtime_secret_metadata_refused');
    syntheticTags(secret.Tags); versions(secret.VersionIdsToStages); rotations[purpose] = rotation(secret);
  }
  const keyRotation: Record<string, { enabled: boolean; periodInDays: number | null }> = {};
  for (const keyArn of [...new Set([api.kmsKeyArn, worker.kmsKeyArn])]) {
    const key = object(object(await read('kms', 'describe-key', { KeyId: keyArn })).KeyMetadata);
    for (const [name, expected] of Object.entries({ Arn: keyArn, KeyId: keyArn.split('/')[1], AWSAccountId: '588966314750',
      Enabled: true, KeyState: 'Enabled', KeyManager: 'CUSTOMER', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', KeySpec: 'SYMMETRIC_DEFAULT', MultiRegion: false })) same(key[name], expected);
    same(key.EncryptionAlgorithms, ['SYMMETRIC_DEFAULT']);
    if (key.DeletionDate !== undefined || key.ValidTo !== undefined || key.CustomKeyStoreId !== undefined || key.XksKeyConfiguration !== undefined)
      return inventoryRefuse('runtime_secret_metadata_refused');
    const status = object(await read('kms', 'get-key-rotation-status', { KeyId: keyArn }));
    if (status.KeyId !== keyArn || typeof status.KeyRotationEnabled !== 'boolean'
      || status.RotationPeriodInDays !== undefined && (!Number.isSafeInteger(status.RotationPeriodInDays) || Number(status.RotationPeriodInDays) < 90 || Number(status.RotationPeriodInDays) > 2560)
      || status.OnDemandRotationStartDate !== undefined) return inventoryRefuse('runtime_secret_rotation_shape_refused');
    keyRotation[keyArn] = { enabled: status.KeyRotationEnabled, periodInDays: status.RotationPeriodInDays as number ?? null };
  }
  for (const o of observations) same(inventorySha(inventoryCanonical(stable(o.operation,
    await transport(o.service, o.operation, o.parameters)))), o.sha256);
  return { contract: 'inventory-qualification-runtime-secret-metadata/1',
    credentialMetadataObserved: true, customerEncryptionBindingVerified: true, rotationConfigurationObserved: true,
    rotations, keyRotation, observations: observations.length, observationSha256: inventorySha(inventoryCanonical(observations)),
    runtimeCredentialsQualified: false, runtimeRotationQualified: false, reviewApprovalVerified: false, keyPolicyReviewed: false,
    effectiveGrantsVerified: false, networkVerified: false, liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
}
