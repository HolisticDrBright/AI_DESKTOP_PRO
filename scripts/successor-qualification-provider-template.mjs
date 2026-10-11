import { successorFleetTemplate } from './successor-qualification-template.mjs';
import { SUCCESSOR_QUALIFICATION_RELEASE as release } from './successor-qualification-release.mjs';
const ref = name => ({ Ref: name }), eq = (a, b) => ({ 'Fn::Equals': [a, b] });

/** Separate copied templates, not edits to historical 112/116 builders.
 * Published versions bind the NEW zip, and all original reviews remain. */
export function successorProviderTemplate(parent, identity, kind, zipCodeSha256) {
  if (!['telehealth-consent', 'clinic-records'].includes(kind) || !/^[A-Za-z0-9+/]{43}=$/.test(zipCodeSha256))
    throw Error('successor_provider_template_refused');
  const activation = kind === 'telehealth-consent' ? 'TELEHEALTH_CONSENT_ACTIVATION' : 'CLINIC_RECORDS_ACTIVATION';
  const { template, bindings } = successorFleetTemplate(parent, identity, { functions: [
    { id: 'Function', file: 'index.js', exportName: 'handler', kind: 'api', activation },
  ] });
  template.Parameters.SourceClean = { Type: 'String', Default: String(identity.sourceClean), AllowedValues: [String(identity.sourceClean)] };
  template.Conditions.CleanSuccessorSource = eq(ref('SourceClean'), 'true');
  template.Conditions.Qualification['Fn::And'].push({ Condition: 'CleanSuccessorSource' });
  template.Rules.SuccessorCleanSource = { RuleCondition: eq(ref('QualificationExecution'), 'enabled'), Assertions: [
    { Assert: eq(ref('SourceClean'), 'true'), AssertDescription: 'A clean exact-source successor artifact is independently required' },
  ] };
  if (kind === 'telehealth-consent') {
    // The copied historical condition holds a literal 112 digest. Leaving it
    // unchanged would make every positive 117 deployment impossible.
    template.Conditions.ArtifactMatches = { 'Fn::And': [eq(ref('SourceCommit'), identity.sourceCommit),
      eq(ref('SourceInputSha256'), identity.sourceInputSha256), eq(ref('SourceClean'), 'true'),
      eq(ref('MigrationReleaseSha256'), release.migrationReleaseSha256), eq(ref('MigrationAssemblySha256'), release.migrationAssemblySha256)] };
  }
  template.Resources.Published = { Type: 'AWS::Lambda::Version', Properties: { FunctionName: ref('Function'),
    CodeSha256: zipCodeSha256, Description: { 'Fn::Sub': kind === 'telehealth-consent'
      ? '${SourceCommit}:${SourceInputSha256}:${ConfigurationSha256}' : '${SourceCommit}:${SourceInputSha256}' } } };
  template.Resources.Integration.Properties.IntegrationUri = ref('Published');
  for (const resource of Object.values(template.Resources)) if (resource.Type === 'AWS::Lambda::Permission')
    resource.Properties.FunctionName = ref('Published');
  template.Outputs.FunctionVersionArn = { Value: ref('Published') };
  return { template, bindings };
}
