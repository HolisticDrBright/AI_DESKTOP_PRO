import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { telehealthQualificationTemplate } from './telehealth-qualification-template.mjs';
import { verifyTelehealthQualificationPreflight } from './telehealth-qualification-preflight.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceCommit = 'a'.repeat(40), versionId = '3/L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY';
const target = {
  ...JSON.parse(readFileSync('infra/aws-clinical-core/qualification-target-connections.example.json', 'utf8')),
  sourceCommit, migrationReleaseHash: 'b'.repeat(64),
  databaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-secret',
  identitySubjects: { consumer: 'fictional-consumer', workforce: 'fictional-workforce',
    foreignConsumer: 'fictional-other-consumer', retentionService: 'fictional-retention-service' },
};
const base = JSON.parse(readFileSync('infra/aws-clinical-core/telehealth-requests-extension.json', 'utf8'));
const template = telehealthQualificationTemplate(base, target, sourceCommit);
const targetBytes = Buffer.from(JSON.stringify(target));
const templateBytes = Buffer.from(JSON.stringify(template, null, 2) + '\n');
const codeBytes = Buffer.from('fictional compiled Lambda');
const localZipBytes = Buffer.from('fictional deterministic ZIP');
const codeBucket = 'alp-qualification-code-588966314750-us-east-2';
const artifact = {
  contract: 'telehealth-qualification-deployment/1', dataClassification: 'synthetic_only', containsPhi: false,
  deployed: false, phiApproved: false, sourceClean: true, sourceCommit,
  apiId: target.apiId, databaseName: target.databaseName, migrationReleaseHash: target.migrationReleaseHash,
  targetManifestSha256: hash(targetBytes), templateSha256: hash(templateBytes), codeSha256: hash(codeBytes),
  deploymentZipSha256: hash(localZipBytes), deploymentZipBytes: localZipBytes.length,
  codeKey: `telehealth-qualification/${sourceCommit}/deployment.zip`,
};
const foundation = { StackStatus: 'CREATE_COMPLETE', Outputs: Object.entries({
  PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled',
  QualificationInfrastructure: 'prepared_no_candidates', Environment: 'synthetic-staging', DataClassification: 'synthetic_only',
  ApiId: target.apiId, ApiOrigin: target.apiOrigin, DatabaseName: target.databaseName,
  DatabaseClusterArn: target.databaseClusterArn, DatabaseSecretArn: target.databaseSecretArn,
  CodeBucket: codeBucket,
}).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
const input = () => ({ artifact: structuredClone(artifact), template: structuredClone(template), target: structuredClone(target),
  targetBytes, templateBytes, codeBytes, localZipBytes, downloadedZipBytes: localZipBytes,
  versionId, sourceCommit, caller: { Account: target.awsAccountId,
    Arn: `arn:aws:sts::${target.awsAccountId}:assumed-role/OrganizationAccountAccessRole/fictional-session` },
  foundation: structuredClone(foundation), api: { ApiId: target.apiId, ApiEndpoint: target.apiOrigin, ProtocolType: 'HTTP' },
  versioning: { Status: 'Enabled' }, objectHead: { VersionId: versionId, ContentLength: localZipBytes.length },
  stackAbsent: true, rebuilt: { codeSha256: artifact.codeSha256,
    deploymentZipSha256: artifact.deploymentZipSha256, templateSha256: artifact.templateSha256 } });

test('accepts exact read-only observations without pretending a deployment happened', () => {
  const report = verifyTelehealthQualificationPreflight(input());
  assert.equal(report.observedOnly, true);
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.phiApproved, false);
  assert.equal(report.codeVersionId, versionId);
});

test('refuses substituted target, caller, foundation, API, object version, bytes and existing stack', () => {
  for (const change of [
    x => { x.sourceCommit = 'c'.repeat(40); }, x => { x.artifact.apiId = 'aaaaaaaaaa'; },
    x => { x.caller.Account = '173535830222'; }, x => { x.caller.Arn = `arn:aws:iam::${target.awsAccountId}:root`; },
    x => { x.foundation.Outputs.find(o => o.OutputKey === 'PhiAllowed').OutputValue = 'true'; },
    x => { x.foundation.Outputs.find(o => o.OutputKey === 'ApiId').OutputValue = 'aaaaaaaaaa'; },
    x => { x.api.ApiEndpoint = target.refused.stagingApiOrigin; },
    x => { x.versioning.Status = 'Suspended'; }, x => { x.versionId = 'null'; },
    x => { x.objectHead.VersionId = 'other'; }, x => { x.downloadedZipBytes = Buffer.from('different'); },
    x => { x.stackAbsent = false; }, x => { x.template.Parameters.ZoomEnabled.AllowedValues = ['false', 'true']; },
    x => { x.rebuilt.codeSha256 = '0'.repeat(64); },
  ]) {
    const changed = input(); change(changed);
    assert.throws(() => verifyTelehealthQualificationPreflight(changed), /telehealth_qualification_preflight_refused/);
  }
});
