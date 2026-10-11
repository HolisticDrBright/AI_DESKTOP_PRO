import { inventoryFleetTemplate } from './inventory-qualification-fleet-template.mjs';
import { inventoryCareTemplate } from './inventory-care-qualification-template.mjs';
import { SUCCESSOR_QUALIFICATION_RELEASE as release } from './successor-qualification-release.mjs';
const ref = n => ({ Ref: n });

// Copy only; historical builders and all their review/drain/IAM conditions stay
// unchanged. A different profile is not permission to execute either template.
function bind(t, parent, identity, ids) {
  if (!/^[a-f0-9]{64}$/.test(identity.sourceInputSha256) || identity.sourceInputSha256 === '0'.repeat(64))
    throw Error('successor_template_source_refused');
  t.Description = `117 synthetic successor proposal; ${parent.Description}`;
  delete t.Parameters.InventoryQualificationProfile;
  delete t.Conditions.InventoryTargetPosture;
  delete t.Outputs.InventoryQualificationProfile;
  Object.assign(t.Parameters, {
    SuccessorQualificationProfile: { Type: 'String', Default: release.qualificationProfile, AllowedValues: [release.qualificationProfile] },
    MigrationReleaseSha256: { Type: 'String', AllowedValues: [release.migrationReleaseSha256] },
    MigrationAssemblySha256: { Type: 'String', AllowedValues: [release.migrationAssemblySha256] },
    SourceInputSha256: { Type: 'String', AllowedValues: [identity.sourceInputSha256] },
  });
  t.Parameters.DatabaseSecretArn.AllowedPattern = '^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-[A-Za-z0-9-]+$';
  t.Conditions.SuccessorTargetPosture = { 'Fn::And': [
    { 'Fn::Equals': [ref('AWS::AccountId'), '588966314750'] }, { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] },
    { 'Fn::Equals': [ref('DatabaseName'), 'clinical_core_qualification'] }, { 'Fn::Equals': [ref('SourceCommit'), identity.sourceCommit] },
    { 'Fn::Equals': [ref('SourceInputSha256'), identity.sourceInputSha256] },
    { 'Fn::Equals': [ref('MigrationReleaseSha256'), release.migrationReleaseSha256] },
    { 'Fn::Equals': [ref('MigrationAssemblySha256'), release.migrationAssemblySha256] },
    { 'Fn::Equals': [ref('SuccessorQualificationProfile'), release.qualificationProfile] },
  ] };
  t.Conditions.Qualification = { 'Fn::And': [structuredClone(parent.Conditions.Qualification), { Condition: 'SuccessorTargetPosture' }] };
  for (const id of ids) {
    const e = t.Resources[id].Properties.Environment.Variables;
    delete e.INVENTORY_QUALIFICATION_PROFILE;
    Object.assign(e, { SUCCESSOR_QUALIFICATION_PROFILE: ref('SuccessorQualificationProfile'),
      MIGRATION_RELEASE_SHA256: ref('MigrationReleaseSha256'), MIGRATION_ASSEMBLY_SHA256: ref('MigrationAssemblySha256'),
      SOURCE_INPUT_SHA256: ref('SourceInputSha256'), SOURCE_COMMIT: ref('SourceCommit'), DEPLOYMENT_ACCOUNT_ID: ref('AWS::AccountId') });
  }
  Object.assign(t.Outputs, { SuccessorQualificationProfile: { Value: ref('SuccessorQualificationProfile') },
    SourceInputSha256: { Value: ref('SourceInputSha256') }, MigrationAssemblySha256: { Value: ref('MigrationAssemblySha256') } });
  return t;
}
export function successorFleetTemplate(parent, identity, spec) {
  const original = inventoryFleetTemplate(parent, identity.sourceCommit, spec);
  return { template: bind(original.template, parent, identity, spec.functions.map(f => f.id)), bindings: original.bindings };
}
export function successorCareTemplate(parent, identity) {
  return bind(inventoryCareTemplate(parent, identity.sourceCommit), parent, identity, ['Function']);
}
