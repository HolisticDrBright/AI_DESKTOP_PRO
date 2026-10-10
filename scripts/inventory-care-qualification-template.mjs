// Distinct 107 synthetic profile. The original 106 templates are inputs, never
// modified on disk. No review, approval, provider row or consent is manufactured.
export const INVENTORY_PROFILE = 'adopted-plan-inventory-qualification/1';
export const INVENTORY_PARENT = '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b';
export const INVENTORY_RELEASE = '542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c';
const ref = name => ({ Ref: name });
export function inventoryCareTemplate(parent, sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || parent.Parameters?.SourceCommit?.AllowedValues?.length !== 1
    || parent.Parameters.SourceCommit.AllowedValues[0] !== sourceCommit
    || JSON.stringify(parent.Parameters?.MigrationReleaseSha256?.AllowedValues) !== JSON.stringify([INVENTORY_PARENT])
    || parent.Parameters?.PhiAllowed?.Default !== 'false' || parent.Parameters?.Activation?.Default !== 'blocked'
    || !parent.Conditions?.Qualification || !parent.Conditions?.Active
    || parent.Resources?.Function?.Type !== 'AWS::Lambda::Function'
    || parent.Resources.Function.Properties.Handler !== 'index.handler') throw Error('inventory_care_template_parent_refused');
  const t = structuredClone(parent);
  t.Description = `107 synthetic-only ${parent.Description}`;
  t.Parameters.PhiAllowed.AllowedValues = ['false'];
  t.Parameters.Activation.AllowedValues = ['blocked'];
  t.Parameters.DatabaseName.AllowedValues = ['clinical_core_qualification'];
  t.Parameters.MigrationReleaseSha256.AllowedValues = [INVENTORY_RELEASE];
  t.Parameters.InventoryQualificationProfile = { Type: 'String', Default: INVENTORY_PROFILE, AllowedValues: [INVENTORY_PROFILE] };
  t.Conditions.InventoryTargetPosture = { 'Fn::And': [
    { 'Fn::Equals': [ref('AWS::AccountId'), '588966314750'] }, { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] },
    { 'Fn::Equals': [ref('DatabaseName'), 'clinical_core_qualification'] },
    { 'Fn::Equals': [ref('InventoryQualificationProfile'), INVENTORY_PROFILE] },
    { 'Fn::Equals': [ref('MigrationReleaseSha256'), INVENTORY_RELEASE] }, { 'Fn::Equals': [ref('SourceCommit'), sourceCommit] },
  ] };
  // Nest rather than exceed CloudFormation's ten-condition limit. Preserve
  // every original review requirement and every independent recovery gate.
  t.Conditions.Qualification = { 'Fn::And': [structuredClone(parent.Conditions.Qualification), { Condition: 'InventoryTargetPosture' }] };
  Object.assign(t.Resources.Function.Properties.Environment.Variables, {
    INVENTORY_QUALIFICATION_PROFILE: ref('InventoryQualificationProfile'),
    MIGRATION_RELEASE_SHA256: ref('MigrationReleaseSha256'), SOURCE_COMMIT: ref('SourceCommit'),
  });
  t.Outputs.InventoryQualificationProfile = { Value: ref('InventoryQualificationProfile') };
  return t;
}
