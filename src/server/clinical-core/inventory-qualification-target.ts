if (typeof window !== 'undefined') throw Error('inventory qualification target is server-only');
import { createPublicKey } from 'node:crypto';
import { isInventoryCognitoSubject } from './inventory-cognito-subject';
import { designatedSubjects, validateQualificationTargetManifest, type QualificationTargetManifest } from './qualification-target-manifest';
import { INVENTORY_PROFILE, INVENTORY_RELEASE } from '../../../scripts/inventory-care-qualification-template.mjs';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, type InventoryArtifactSet, type InventoryTemplate } from './inventory-qualification-artifacts';

export type InventoryCodeObject = { file: string; bucket: string; key: string; versionId: string; sha256: string; bytes: number };
export type InventoryCandidateTarget = { candidate: string; stackName: string; manifestSha256: string; templateSha256: string;
  parameters: Record<string, string>; packages: InventoryCodeObject[] };
export type InventoryQualificationTarget = { contract: 'inventory-qualification-target/1'; target: QualificationTargetManifest;
  organizationId: string; identity: { consumerIssuer: string; consumerAudience: string; workforceIssuer: string; workforceAudience: string };
  artifactBucket: string; buildManifestSha256: string; sourceInputSha256: string; reviewSha256: string; candidates: InventoryCandidateTarget[] };
const keys = (v: unknown, names: string[]): Record<string, unknown> => {
  if (!inventoryRecord(v) || Object.keys(v).length !== names.length || names.some(k => !Object.hasOwn(v, k))) return inventoryRefuse('target_shape_refused');
  return v;
};
const text = (v: unknown, pattern: RegExp): string => {
  if (typeof v !== 'string' || !pattern.test(v)) return inventoryRefuse('target_value_refused'); return v;
};
const hex = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const same = (a: unknown, b: unknown) => { if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('target_binding_refused'); };

/** Bounded condition evaluation only. Never selects a permissive fallback for an unknown intrinsic. */
export function inventoryCondition(value: unknown, template: InventoryTemplate, parameters: Record<string, string>, depth = 0): unknown {
  if (depth > 64) return inventoryRefuse('target_condition_refused');
  if (!inventoryRecord(value)) { if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value; return inventoryRefuse('target_condition_refused'); }
  if (Object.keys(value).length !== 1) return inventoryRefuse('target_condition_refused');
  const next = (v: unknown) => inventoryCondition(v, template, parameters, depth + 1);
  if (typeof value.Ref === 'string' && Object.hasOwn(parameters, value.Ref)) return parameters[value.Ref];
  if (typeof value.Condition === 'string' && Object.hasOwn(template.Conditions, value.Condition)) return next(template.Conditions[value.Condition]);
  for (const op of ['Fn::Equals', 'Fn::And', 'Fn::Or', 'Fn::Not']) if (Object.hasOwn(value, op)) {
    const terms = value[op]; if (!Array.isArray(terms)) return inventoryRefuse('target_condition_refused');
    if (op === 'Fn::Equals' && terms.length === 2) return next(terms[0]) === next(terms[1]);
    if (op === 'Fn::Not' && terms.length === 1) { const v = next(terms[0]); if (typeof v !== 'boolean') return inventoryRefuse('target_condition_refused'); return !v; }
    if (['Fn::And', 'Fn::Or'].includes(op) && terms.length >= 2 && terms.length <= 10) {
      const evaluated = terms.map(next); if (evaluated.some(v => typeof v !== 'boolean')) return inventoryRefuse('target_condition_refused');
      return op === 'Fn::And' ? evaluated.every(v => v) : evaluated.some(v => v);
    }
  }
  return inventoryRefuse('target_condition_refused');
}

/** CloudFormation's independent parameter rules remain requirements even
 * when Qualification=true and Active=false. In particular, recovery/export/
 * retention flags cannot silently bypass their separate review inputs. */
export function inventoryRules(template: InventoryTemplate, parameters: Record<string, string>) {
  if (template.Rules === undefined) return;
  if (!inventoryRecord(template.Rules) || Object.keys(template.Rules).length > 128) return inventoryRefuse('target_rule_refused');
  for (const rule of Object.values(template.Rules)) {
    if (!inventoryRecord(rule) || Object.keys(rule).some(k => !['RuleCondition', 'Assertions'].includes(k))
      || !Array.isArray(rule.Assertions) || !rule.Assertions.length || rule.Assertions.length > 128) return inventoryRefuse('target_rule_refused');
    const applies = Object.hasOwn(rule, 'RuleCondition') ? inventoryCondition(rule.RuleCondition, template, parameters) : true;
    if (typeof applies !== 'boolean') return inventoryRefuse('target_rule_refused');
    for (const assertion of rule.Assertions) {
      if (!inventoryRecord(assertion) || !Object.hasOwn(assertion, 'Assert') || Object.keys(assertion).some(k => !['Assert', 'AssertDescription'].includes(k))) return inventoryRefuse('target_rule_refused');
      const value = inventoryCondition(assertion.Assert, template, parameters);
      if (typeof value !== 'boolean' || applies && !value) return inventoryRefuse('target_rule_refused');
    }
  }
}

/** New outer contract; the historical /1,/2,/3 loaders reject it. A hash binds
 * review bytes, not proof that a person actually reviewed or approved them.
 * This validates proposed configuration, NOT AWS observations or acceptance. */
export function validateInventoryQualificationTarget(input: unknown, supplied: InventoryArtifactSet): InventoryQualificationTarget {
  const artifacts = structuredClone(supplied);
  if (!artifacts.source.sourceClean) return inventoryRefuse('target_dirty_source_refused');
  const v = keys(input, ['contract', 'target', 'organizationId', 'identity', 'artifactBucket', 'buildManifestSha256', 'sourceInputSha256', 'reviewSha256', 'candidates']);
  if (v.contract !== 'inventory-qualification-target/1') return inventoryRefuse('target_contract_refused');
  const base = validateQualificationTargetManifest(v.target);
  if (base.schemaVersion !== 'aws-clinical-core-qualification-target/3' || base.awsAccountId !== '588966314750' || base.awsRegion !== 'us-east-2'
    || base.databaseName !== 'clinical_core_qualification' || base.sourceCommit !== artifacts.source.sourceCommit || base.migrationReleaseHash !== INVENTORY_RELEASE) return inventoryRefuse('target_release_refused');
  const organizationId = text(v.organizationId, uuid);
  const i = keys(v.identity, ['consumerIssuer', 'consumerAudience', 'workforceIssuer', 'workforceAudience']);
  const issuer = /^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/;
  const audience = /^[A-Za-z0-9]{20,128}$/;
  const identity = { consumerIssuer: text(i.consumerIssuer, issuer), consumerAudience: text(i.consumerAudience, audience),
    workforceIssuer: text(i.workforceIssuer, issuer), workforceAudience: text(i.workforceAudience, audience) };
  if (identity.consumerIssuer === identity.workforceIssuer || identity.consumerAudience === identity.workforceAudience) return inventoryRefuse('target_identity_refused');
  const artifactBucket = text(v.artifactBucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  if (/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(artifactBucket) || [base.exportBucket, base.recordingBucket].includes(artifactBucket)) return inventoryRefuse('target_artifact_bucket_refused');
  const reviewSha256 = text(v.reviewSha256, hex); if (/^0+$/.test(reviewSha256)) return inventoryRefuse('target_review_refused');
  same(v.buildManifestSha256, artifacts.manifestSha256); same(v.sourceInputSha256, artifacts.source.sourceInputSha256);
  if (!Array.isArray(v.candidates) || v.candidates.length !== 12) return inventoryRefuse('target_fleet_refused');
  same(v.candidates.map(c => inventoryRecord(c) ? c.candidate : null).sort(), artifacts.candidates.map(c => c.candidate).sort());
  const subjects = designatedSubjects(base.identitySubjects);
  // Cognito users are opaque issuer-local subjects; the scheduled sweep is a
  // named non-human database identity, not a fourth human Cognito account.
  if ([base.identitySubjects.consumer, base.identitySubjects.workforce, base.identitySubjects.foreignConsumer].some(s => !isInventoryCognitoSubject(s)))
    return inventoryRefuse('target_identity_refused');
  if (base.identitySubjects.retentionService !== undefined && !/^svc-[a-z0-9][a-z0-9-]{2,60}$/.test(base.identitySubjects.retentionService))
    return inventoryRefuse('target_retention_identity_refused');
  const objectNames = new Set<string>();
  const candidates = v.candidates.map(row => {
    const c = keys(row, ['candidate', 'stackName', 'manifestSha256', 'templateSha256', 'parameters', 'packages']);
    const a = artifacts.candidates.find(a => a.candidate === c.candidate); if (!a) return inventoryRefuse('target_fleet_refused');
    same(c.stackName, base.stacks[a.candidate]); same(c.manifestSha256, a.manifestSha256); same(c.templateSha256, a.templateSha256);
    if (!inventoryRecord(c.parameters)) return inventoryRefuse('target_parameters_refused');
    same(Object.keys(c.parameters).sort(), Object.keys(a.template.Parameters).sort());
    const parameters: Record<string, string> = {};
    for (const [name, definition] of Object.entries(a.template.Parameters)) {
      const raw = c.parameters[name];
      const control = name === 'LabRangeSignerPublicKeyPem' ? /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
      if (typeof raw !== 'string' || raw.length > 8192 || control.test(raw)) return inventoryRefuse('target_parameters_refused');
      if (name === 'LabRangeSignerPublicKeyPem' && raw) {
        if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(raw)) return inventoryRefuse('target_signer_refused');
        try { if (createPublicKey(raw).asymmetricKeyType !== 'ed25519') return inventoryRefuse('target_signer_refused'); }
        catch { return inventoryRefuse('target_signer_refused'); }
      }
      if (definition.AllowedValues && !definition.AllowedValues.map(String).includes(raw)
        || definition.AllowedPattern && !new RegExp(`^(?:${definition.AllowedPattern})$`).test(raw)
        || definition.MinLength !== undefined && raw.length < definition.MinLength || definition.MaxLength !== undefined && raw.length > definition.MaxLength) return inventoryRefuse('target_parameters_refused');
      if (definition.Type === 'Number' && (!/^-?\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))
        || definition.MinValue !== undefined && Number(raw) < definition.MinValue || definition.MaxValue !== undefined && Number(raw) > definition.MaxValue)) return inventoryRefuse('target_parameters_refused');
      if (/Sha256$/.test(name) && raw && (!hex.test(raw) || /^0+$/.test(raw))) return inventoryRefuse('target_review_refused');
      if (raw.startsWith('arn:aws:')) {
        const fields = raw.split(':'); if (fields.length < 6 || fields[4] && fields[4] !== base.awsAccountId || fields[3] && fields[3] !== base.awsRegion) return inventoryRefuse('target_account_refused');
      }
      if (raw === base.refused.stagingApiOrigin || raw === base.refused.stagingDatabaseName || raw === base.refused.stagingFoundationStackName) return inventoryRefuse('target_staging_refused');
      parameters[name] = raw;
    }
    const expected: Record<string, string> = { PhiAllowed: 'false', Activation: 'blocked', ActivationEvidenceSha256: '', QualificationExecution: 'enabled',
      QualificationAccountId: base.awsAccountId, QualificationIdentitySubjects: subjects.join(','), DatabaseClusterArn: base.databaseClusterArn,
      DatabaseSecretArn: base.databaseSecretArn, DatabaseName: base.databaseName, SourceCommit: artifacts.source.sourceCommit,
      MigrationReleaseSha256: INVENTORY_RELEASE, InventoryQualificationProfile: INVENTORY_PROFILE,
      ApiId: base.apiId, ClinicalApiId: base.apiId, ExportBucketName: base.exportBucket, RecordingBucket: base.recordingBucket,
      OrganizationId: organizationId, ConsumerIssuer: identity.consumerIssuer, ConsumerAudience: identity.consumerAudience,
      WorkforceIssuer: identity.workforceIssuer, WorkforceAudience: identity.workforceAudience,
      RetentionServiceSubject: base.identitySubjects.retentionService ?? '' };
    for (const [name, value] of Object.entries(expected)) if (Object.hasOwn(parameters, name)) same(parameters[name], value);
    // Optional account-erasure permission must never target an unrelated pool.
    if (parameters.ConsumerUserPoolId) same(parameters.ConsumerUserPoolId, identity.consumerIssuer.split('/').at(-1));
    if (parameters.BillingApiOrigin) same(parameters.BillingApiOrigin, base.apiOrigin);
    if (parameters.RetentionScheduleEnabled === 'true') {
      if (!base.identitySubjects.retentionService || !uuid.test(parameters.RetentionServicePersonId ?? '')) return inventoryRefuse('target_retention_identity_refused');
      same(parameters.RetentionServiceOrganizationId, organizationId);
    }
    const context = { ...parameters, 'AWS::AccountId': base.awsAccountId, 'AWS::Region': base.awsRegion };
    inventoryRules(a.template, context);
    if (inventoryCondition(a.template.Conditions.Qualification, a.template, context) !== true
      || inventoryCondition(a.template.Conditions.Active, a.template, context) !== false) return inventoryRefuse('target_posture_refused');
    if (!Array.isArray(c.packages) || c.packages.length !== a.packages.length) return inventoryRefuse('target_code_refused');
    same(c.packages.map(p => inventoryRecord(p) ? p.file : null).sort(), a.packages.map(p => p.file).sort());
    const packages = c.packages.map(entry => {
      const p = keys(entry, ['file', 'bucket', 'key', 'versionId', 'sha256', 'bytes']), original = a.packages.find(p0 => p0.file === p.file);
      if (!original) return inventoryRefuse('target_code_refused');
      same(p.bucket, artifactBucket); same(p.sha256, original.sha256); same(p.bytes, original.bytes);
      const key = text(p.key, /^[A-Za-z0-9/_.-]{1,1024}$/);
      if (key !== `inventory-qualification/${artifacts.source.sourceCommit}/${a.candidate}/${original.file}`) return inventoryRefuse('target_code_prefix_refused');
      const versionId = text(p.versionId, /^(?!null$)(?!latest$)[A-Za-z0-9+/._=-]{1,1024}$/);
      const unique = `${artifactBucket}:${key}`; if (objectNames.has(unique)) return inventoryRefuse('target_code_duplicate'); objectNames.add(unique);
      same(parameters[original.bucketParameter], artifactBucket); same(parameters[original.keyParameter], key); same(parameters[original.versionParameter], versionId);
      return { file: original.file, bucket: artifactBucket, key, versionId, sha256: original.sha256, bytes: original.bytes };
    });
    return { candidate: a.candidate, stackName: String(c.stackName), manifestSha256: a.manifestSha256, templateSha256: a.templateSha256, parameters, packages };
  });
  if (objectNames.size !== 13) return inventoryRefuse('target_fleet_refused');
  return structuredClone({ contract: 'inventory-qualification-target/1', target: base, organizationId, identity, artifactBucket,
    buildManifestSha256: artifacts.manifestSha256, sourceInputSha256: artifacts.source.sourceInputSha256, reviewSha256, candidates });
}
