import { INVENTORY_PROFILE, INVENTORY_RELEASE } from './inventory-care-qualification-template.mjs';
const ref = n => ({ Ref: n });
/** Narrow a copied ordinary candidate, preserve all permissions/review/drain
 * logic. The original builder/default and draining deployment stay separate. */
export function inventoryFleetTemplate(parent, sourceCommit, spec) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || parent.Parameters?.PhiAllowed?.Default !== 'false'
    || parent.Parameters?.Activation?.Default !== 'blocked' || !parent.Parameters?.DatabaseName || !parent.Parameters?.SourceCommit
    || !parent.Conditions?.Qualification || !parent.Conditions?.Active
    || JSON.stringify(Object.entries(parent.Resources ?? {}).filter(([, r]) => r.Type === 'AWS::Lambda::Function').map(([n]) => n).sort())
      !== JSON.stringify(spec.functions.map(f => f.id).sort())) throw Error('inventory_fleet_template_parent_refused');
  const t = structuredClone(parent);
  t.Description = `107 synthetic-only ${parent.Description}`;
  t.Parameters.PhiAllowed.AllowedValues = ['false']; t.Parameters.Activation.AllowedValues = ['blocked'];
  t.Parameters.DatabaseName.AllowedValues = ['clinical_core_qualification']; t.Parameters.SourceCommit.AllowedValues = [sourceCommit];
  t.Parameters.MigrationReleaseSha256 = { Type: 'String', AllowedValues: [INVENTORY_RELEASE] };
  t.Parameters.InventoryQualificationProfile = { Type: 'String', Default: INVENTORY_PROFILE, AllowedValues: [INVENTORY_PROFILE] };
  t.Conditions.InventoryTargetPosture = { 'Fn::And': [
    { 'Fn::Equals': [ref('AWS::AccountId'), '588966314750'] }, { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] },
    { 'Fn::Equals': [ref('DatabaseName'), 'clinical_core_qualification'] }, { 'Fn::Equals': [ref('SourceCommit'), sourceCommit] },
    { 'Fn::Equals': [ref('MigrationReleaseSha256'), INVENTORY_RELEASE] }, { 'Fn::Equals': [ref('InventoryQualificationProfile'), INVENTORY_PROFILE] },
  ] };
  t.Conditions.Qualification = { 'Fn::And': [structuredClone(parent.Conditions.Qualification), { Condition: 'InventoryTargetPosture' }] };
  const bindings = [];
  for (const f of spec.functions) {
    const p = t.Resources[f.id].Properties, original = parent.Resources[f.id].Properties;
    if (original.Handler !== `${f.file.slice(0, -3) === 'worker' ? 'index' : f.file.slice(0, -3)}.${f.exportName}`
      || !p.Code?.S3Bucket?.Ref || !p.Code?.S3Key?.Ref || !p.Environment?.Variables
      || !Object.hasOwn(p.Environment.Variables, f.activation)) throw Error('inventory_fleet_function_mapping_refused');
    const key = p.Code.S3Key.Ref, version = p.Code.S3ObjectVersion?.Ref ?? `${key.slice(0, -3)}Version`;
    if (!key.endsWith('Key') || !t.Parameters[key] || p.Code.S3ObjectVersion && !p.Code.S3ObjectVersion.Ref) throw Error('inventory_fleet_code_version_refused');
    t.Parameters[version] ??= { Type: 'String', MinLength: 1, MaxLength: 1024, AllowedPattern: '^(?!null$).+$' };
    delete t.Parameters[key].Default;
    p.Code.S3ObjectVersion = ref(version);
    p.Handler = `${f.file.slice(0, -3)}.${f.exportName}`;
    Object.assign(p.Environment.Variables, { SOURCE_COMMIT: ref('SourceCommit'), MIGRATION_RELEASE_SHA256: ref('MigrationReleaseSha256'),
      INVENTORY_QUALIFICATION_PROFILE: ref('InventoryQualificationProfile'), DEPLOYMENT_ACCOUNT_ID: ref('AWS::AccountId') });
    bindings.push({ logicalId: f.id, file: f.file, handler: p.Handler, kind: f.kind, activationKey: f.activation,
      bucketParameter: p.Code.S3Bucket.Ref, keyParameter: key, versionParameter: version });
  }
  Object.assign(t.Outputs, { SourceCommit: { Value: ref('SourceCommit') }, MigrationReleaseSha256: { Value: ref('MigrationReleaseSha256') },
    DatabaseName: { Value: ref('DatabaseName') }, InventoryQualificationProfile: { Value: ref('InventoryQualificationProfile') } });
  return { template: t, bindings };
}
