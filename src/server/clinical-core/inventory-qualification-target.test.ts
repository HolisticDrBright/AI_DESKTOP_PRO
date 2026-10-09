import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { inventoryBoundedFile, inventoryCanonical, inventorySha, readInventoryQualificationArtifacts, type InventoryArtifactSet } from './inventory-qualification-artifacts';
import { inventoryCondition, inventoryRules, validateInventoryQualificationTarget, type InventoryQualificationTarget } from './inventory-qualification-target';
import { validateQualificationTargetManifest } from './qualification-target-manifest';
import { INVENTORY_PROFILE, INVENTORY_RELEASE } from '../../../scripts/inventory-care-qualification-template.mjs';
import { inspectInventoryStackDeclarations, observeInventoryStackDeclarations, resolveInventoryTemplate } from './inventory-qualification-stack-observer';
import { observeInventoryCandidateServices } from './inventory-qualification-service-observer';
import { fictionalInventoryServices } from './testing/inventory-service-fixture';
import { observeInventorySharedApi } from './inventory-qualification-api-observer';
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';

let directory: string, artifacts: InventoryArtifactSet;
const consumer = '11111111-1111-4111-8111-111111111111', workforce = '22222222-2222-4222-8222-222222222222';
const foreign = '33333333-3333-4333-8333-333333333333', retention = '44444444-4444-4444-8444-444444444444';
const retentionSubject = 'svc-fictional-qualification-retention';
const organization = '55555555-5555-4555-8555-555555555555', kms = 'arn:aws:kms:us-east-2:588966314750:key/66666666-6666-4666-8666-666666666666';
const digest = 'a'.repeat(64);
const fictionalSigner = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'alp-inventory-target-tests-'));
  execFileSync(process.execPath, ['scripts/build-inventory-qualification-target-verifier.mjs'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  execFileSync(process.execPath, ['scripts/build-inventory-qualification-fleet.mjs', `--out-dir=${directory}`], {
    encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  const summary = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  artifacts = readInventoryQualificationArtifacts(directory, { sourceCommit: summary.sourceCommit,
    sourceClean: summary.sourceClean, sourceInputSha256: summary.sourceInputSha256 });
}, 250000);
afterAll(() => {
  if (!directory) return;
  expect(dirname(realpathSync(directory))).toBe(realpathSync(tmpdir())); expect(basename(directory)).toMatch(/^alp-inventory-target-tests-/);
  expect(lstatSync(directory).isSymbolicLink()).toBe(false); rmSync(directory, { recursive: true, force: false });
});

// These are FICTIONAL schema-evaluator inputs, never reviews/deployment values.
// Clean-source admission is modeled for validator unit cases. Actual builder's
// dirty/clean observation is retained and independently tested by the file reader.
const admissionFixture = () => ({ ...structuredClone(artifacts), source: { ...artifacts.source, sourceClean: true } });
function targetFixture(): InventoryQualificationTarget {
  const a = admissionFixture();
  const target = { schemaVersion: 'aws-clinical-core-qualification-target/3' as const, environment: 'synthetic-staging' as const,
    dataClassification: 'synthetic_only' as const, containsPhi: false as const, awsAccountId: '588966314750', awsRegion: 'us-east-2',
    foundationStackName: 'fictional-qualification-foundation', apiId: 'abcdefghij', apiOrigin: 'https://abcdefghij.execute-api.us-east-2.amazonaws.com',
    databaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-qualification',
    databaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-secret', databaseName: 'clinical_core_qualification',
    exportBucket: 'fictional-qualification-exports', recordingBucket: 'fictional-qualification-recordings', sourceCommit: a.source.sourceCommit,
    migrationReleaseHash: INVENTORY_RELEASE, identitySubjects: { consumer, workforce, foreignConsumer: foreign, retentionService: retentionSubject },
    stacks: Object.fromEntries(a.candidates.map(c => [c.candidate, `fictional-qualification-${c.candidate}`])),
    refused: { stagingFoundationStackName: 'fictional-staging', stagingApiOrigin: 'https://klmnopqrst.execute-api.us-east-2.amazonaws.com', stagingDatabaseName: 'clinical_core' },
    reviewedAt: '2026-10-09T00:00:00.000Z' };
  const identity = { consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_ConsumerFixture', consumerAudience: 'consumerfixtureaudience00001',
    workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_WorkforceFixture', workforceAudience: 'workforcefixtureaudience00001' };
  const artifactBucket = 'fictional-qualification-artifacts';
  const candidates = a.candidates.map(c => {
    const parameters = Object.fromEntries(Object.entries(c.template.Parameters).map(([name, p]) => [name, p.Default === undefined ? 'fictional' : String(p.Default)]));
    const common: Record<string, string> = { ApiId: target.apiId, ClinicalApiId: target.apiId, PhiAllowed: 'false', Activation: 'blocked', ActivationEvidenceSha256: '',
      SourceCommit: a.source.sourceCommit, MigrationReleaseSha256: INVENTORY_RELEASE, InventoryQualificationProfile: INVENTORY_PROFILE,
      DatabaseClusterArn: target.databaseClusterArn, DatabaseSecretArn: target.databaseSecretArn, DatabaseName: target.databaseName,
      QualificationExecution: 'enabled', QualificationAccountId: target.awsAccountId, QualificationIdentitySubjects: [consumer, workforce, foreign, retentionSubject].join(','),
      AlarmTopicArn: 'arn:aws:sns:us-east-2:588966314750:fictional-alarms', OrganizationId: organization, ...Object.fromEntries(Object.entries(identity).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v])),
      SecretKmsKeyArn: kms, LogsKmsKeyArn: kms, ClinicalCoreKeyArn: kms, ExportKmsKeyArn: kms, ExportBucketName: target.exportBucket, RecordingBucket: target.recordingBucket,
      AllowedScopes: 'forms_checkins,lab_history', BillingApiOrigin: target.apiOrigin, ConsumerJwtAuthorizerId: 'fictionalauthorizer',
      OpenAISecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-provider', RetentionServiceSubject: retentionSubject,
      RecordingKmsKeyArn: kms, CaptureReleaseId: foreign, TranscriptionReleaseId: consumer, DraftingReleaseId: workforce, CleanupReleaseId: retention,
      LabRangeMode: 'reviewed_release', LabRangeReleaseBucket: 'fictional-qualification-ranges', LabRangeReleaseKey: 'reviewed-lab-ranges/fictional.json',
      LabRangeReleaseSha256: digest, LabRangeSignerPublicKeyPem: fictionalSigner,
      DraftingOpenAiSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-drafting-provider' };
    for (const name of Object.keys(parameters)) {
      if (/ReviewSha256$|CleanupWorkerSha256$/.test(name)) parameters[name] = digest;
      if (Object.hasOwn(common, name)) parameters[name] = common[name];
    }
    if (c.candidate === 'owned-lab') parameters.AllowedScopes = 'ai_context,lab_history';
    if (c.candidate === 'owned-voice') parameters.AllowedScopes = 'ai_context,voice_transcription';
    const packages = c.packages.map(p => {
      const key = `inventory-qualification/${a.source.sourceCommit}/${c.candidate}/${p.file}`, versionId = `fictional-version-${p.file}`;
      parameters[p.bucketParameter] = artifactBucket; parameters[p.keyParameter] = key; parameters[p.versionParameter] = versionId;
      return { file: p.file, bucket: artifactBucket, key, versionId, sha256: p.sha256, bytes: p.bytes };
    });
    return { candidate: c.candidate, stackName: target.stacks[c.candidate], manifestSha256: c.manifestSha256,
      templateSha256: c.templateSha256, parameters, packages };
  });
  return { contract: 'inventory-qualification-target/1', target, organizationId: organization, identity, artifactBucket,
    buildManifestSha256: a.manifestSha256, sourceInputSha256: a.source.sourceInputSha256, reviewSha256: digest, candidates };
}

// Fictional CloudFormation responses, not deployed resources or actual reviews.
// Attribute values below are assembled independently of the production mapper.
function stackFixture(candidate: InventoryQualificationTarget['candidates'][number], a: InventoryArtifactSet['candidates'][number]) {
  const p = { ...candidate.parameters, 'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2', 'AWS::Partition': 'aws',
    'AWS::StackName': candidate.stackName, 'AWS::StackId': `arn:aws:cloudformation:us-east-2:588966314750:stack/${candidate.stackName}/fixture`, 'AWS::URLSuffix': 'amazonaws.com' };
  const active = Object.entries(a.template.Resources).filter(([, r]) => !r.Condition || inventoryCondition(a.template.Conditions[r.Condition], a.template, p));
  const resources = active.map(([id, r]) => {
    const names: Record<string, string> = { 'AWS::Lambda::Function': 'FunctionName', 'AWS::Logs::LogGroup': 'LogGroupName',
      'AWS::Events::Rule': 'Name', 'AWS::DynamoDB::Table': 'TableName', 'AWS::S3::Bucket': 'BucketName', 'AWS::IAM::Role': 'RoleName', 'AWS::CloudWatch::Alarm': 'AlarmName' };
    let physical = `${candidate.candidate}-${id}`;
    const explicit = r.Properties[names[r.Type]];
    if (explicit !== undefined) physical = String(resolveInventoryTemplate(explicit, { template: a.template, parameters: p, refs: {}, attributes: {} }));
    if (r.Type === 'AWS::SQS::Queue') physical = `https://sqs.us-east-2.amazonaws.com/588966314750/${id}`;
    if (r.Type === 'AWS::StepFunctions::StateMachine') physical = 'arn:aws:states:us-east-2:588966314750:stateMachine:'
      + resolveInventoryTemplate(r.Properties.StateMachineName, { template: a.template, parameters: p, refs: {}, attributes: {} });
    return { LogicalResourceId: id, PhysicalResourceId: physical, ResourceType: r.Type, ResourceStatus: 'CREATE_COMPLETE' };
  });
  const refs = Object.fromEntries(resources.map(r => [r.LogicalResourceId, r.PhysicalResourceId])), attributes: Record<string, string> = {};
  for (const r of resources) {
    const id = r.LogicalResourceId, physical = r.PhysicalResourceId;
    const services: Record<string, string> = { 'AWS::Lambda::Function': 'lambda:us-east-2:588966314750:function:',
      'AWS::DynamoDB::Table': 'dynamodb:us-east-2:588966314750:table/', 'AWS::Events::Rule': 'events:us-east-2:588966314750:rule/', 'AWS::IAM::Role': 'iam::588966314750:role/' };
    if (services[r.ResourceType]) attributes[`${id}.Arn`] = 'arn:aws:' + services[r.ResourceType] + physical;
    if (r.ResourceType === 'AWS::Logs::LogGroup') attributes[`${id}.Arn`] = `arn:aws:logs:us-east-2:588966314750:log-group:${physical}:*`;
    if (r.ResourceType === 'AWS::S3::Bucket') attributes[`${id}.Arn`] = `arn:aws:s3:::${physical}`;
    if (r.ResourceType === 'AWS::StepFunctions::StateMachine') attributes[`${id}.Arn`] = physical;
    if (r.ResourceType === 'AWS::SQS::Queue') {
      attributes[`${id}.QueueName`] = id; attributes[`${id}.Arn`] = `arn:aws:sqs:us-east-2:588966314750:${id}`;
    }
  }
  const context = { template: a.template, parameters: p, refs, attributes };
  const outputs = Object.entries(a.template.Outputs).filter(([, row]) => !(row as Record<string, unknown>).Condition
    || inventoryCondition(a.template.Conditions[String((row as Record<string, unknown>).Condition)], a.template, p))
    .map(([name, row]) => ({ OutputKey: name, OutputValue: String(resolveInventoryTemplate((row as Record<string, unknown>).Value, context)) }));
  return { stack: { Stacks: [{ StackName: candidate.stackName, StackId: p['AWS::StackId'], StackStatus: 'CREATE_COMPLETE',
    Parameters: Object.entries(candidate.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })), Outputs: outputs }] },
    template: { TemplateBody: structuredClone(a.template) }, resources: { StackResourceSummaries: resources } };
}

function sharedApiFixture() {
  const target = targetFixture(), storage = artifacts.candidates.find(c => c.candidate === 'personal-storage')!;
  const consumerId = Object.entries(storage.template.Resources).find(([, r]) => r.Type === 'AWS::ApiGatewayV2::Authorizer'
    && inventoryCanonical(r.Properties.JwtConfiguration).includes('ConsumerIssuer'))![0];
  const voice = target.candidates.find(c => c.candidate === 'owned-voice')!;
  voice.parameters.ConsumerJwtAuthorizerId = `personal-storage-${consumerId}`;
  validateInventoryQualificationTarget(target, admissionFixture());
  const snapshots = Object.fromEntries(target.candidates.map(c => {
    const a = artifacts.candidates.find(a => a.candidate === c.candidate)!;
    return [c.candidate, inspectInventoryStackDeclarations(c, a, stackFixture(c, a))];
  }));
  const foundation = buildQualificationFoundation(), stackId = `arn:aws:cloudformation:us-east-2:588966314750:stack/${target.target.foundationStackName}/fictional`;
  const responses: Record<string, unknown> = {
    'get-api': { ApiId: target.target.apiId, ApiEndpoint: target.target.apiOrigin, Name: foundation.Resources.Api.Properties.Name,
      ProtocolType: 'HTTP', RouteSelectionExpression: '$request.method $request.path', ApiKeySelectionExpression: '$request.header.x-api-key',
      DisableExecuteApiEndpoint: false, IpAddressType: 'ipv4', Tags: foundation.Resources.Api.Properties.Tags },
    'get-stages': { Items: [{ StageName: '$default', AutoDeploy: true, DefaultRouteSettings: foundation.Resources.Stage.Properties.DefaultRouteSettings,
      AccessLogSettings: { DestinationArn: `arn:aws:logs:us-east-2:588966314750:log-group:/aws/apigateway/qualification/${target.target.apiId}`,
        Format: foundation.Resources.Stage.Properties.AccessLogSettings.Format }, RouteSettings: {}, StageVariables: {},
      DeploymentId: 'fictional', LastDeploymentStatusMessage: "Successfully deployed stage with deployment ID 'fictional'",
      Tags: foundation.Resources.Stage.Properties.Tags }] },
  };
  for (const suffix of ['Route', 'Integration', 'Authorizer']) responses[`get-${suffix.toLowerCase()}s`] = { Items: Object.values(snapshots)
    .flatMap(s => s.resources.filter(r => r.type === `AWS::ApiGatewayV2::${suffix}`)).map(r => {
      const { ApiId: _apiId, ...properties } = r.properties;
      return { [`${suffix}Id`]: r.physicalId, ...properties };
    }) };
  return { target, snapshots, stackId, responses };
}
it('checks the whole shared HTTP API inventory derived from all twelve actual templates', async () => {
  const f = sharedApiFixture(); let calls = 0;
  const report = await observeInventorySharedApi(f.target, f.snapshots, f.stackId, admissionFixture(), async (service, operation, parameters) => {
    expect(service).toBe('apigatewayv2'); expect(parameters).toEqual({ ApiId: f.target.target.apiId }); calls++;
    return structuredClone(f.responses[operation]);
  });
  expect(report.sharedApiInventoryVerified).toBe(true); expect(report.routes).toBeGreaterThan(20); expect(calls).toBe(10);
  for (const flag of ['sourcePrincipalFoundationVerified', 'wholeLedgerVerified', 'uploadedVersionsVerified', 'acceptance', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const)
    expect(report[flag]).toBe(false);
});
it('refuses extra or hidden shared routes, stages, authorizers, integrations and configuration drift', async () => {
  const baseline = sharedApiFixture();
  await observeInventorySharedApi(baseline.target, baseline.snapshots, baseline.stackId, admissionFixture(), async (_s, o) => structuredClone(baseline.responses[o]));
  type R = Record<string, unknown>;
  const item = (r: R) => (r.Items as R[])[0];
  const changes: Array<[string, (r: R) => void]> = [
    ['get-api', r => { r.ProtocolType = 'WEBSOCKET'; }], ['get-api', r => { r.ApiEndpoint = 'https://foreign.invalid'; }],
    ['get-api', r => { r.CorsConfiguration = { AllowOrigins: ['*'] }; }], ['get-api', r => { r.IpAddressType = 'dualstack'; }],
    ['get-api', r => { r.RouteSelectionExpression = '$default'; }], ['get-api', r => { r.ApiGatewayManaged = true; }],
    ['get-api', r => { (r.Tags as R)['aws:cloudformation:stack-id'] = 'foreign'; }],
    ['get-stages', r => { (r.Items as R[]).push({ ...item(r), StageName: 'public' }); }],
    ['get-stages', r => { item(r).AutoDeploy = false; }], ['get-stages', r => { item(r).RouteSettings = { '$default': { ThrottlingRateLimit: 10000 } }; }],
    ['get-stages', r => { item(r).StageVariables = { routing: 'foreign' }; }],
    ['get-stages', r => { item(r).AccessLogSettings = { DestinationArn: 'foreign', Format: '$context.requestBody' }; }],
    ['get-stages', r => { item(r).LastDeploymentStatusMessage = 'deployment failed'; }],
    ['get-stages', r => { r.NextToken = 'unfinished'; }],
    ['get-routes', r => { (r.Items as R[]).push({ RouteId: 'foreign', RouteKey: '$default', AuthorizationType: 'NONE' }); }],
    ['get-routes', r => { item(r).AuthorizationType = 'NONE'; }], ['get-routes', r => { item(r).Target = 'integrations/foreign'; }],
    ['get-routes', r => { item(r).AuthorizationScopes = ['foreign']; }], ['get-routes', r => { (r.Items as R[]).pop(); }],
    ['get-routes', r => { (r.Items as R[]).push(structuredClone(item(r))); }], ['get-routes', r => { r.NextToken = 'unfinished'; }],
    ['get-integrations', r => { item(r).IntegrationUri = 'arn:aws:lambda:us-east-2:588966314750:function:foreign'; }],
    ['get-integrations', r => { item(r).RequestParameters = { 'overwrite:header.Authorization': 'foreign' }; }],
    ['get-integrations', r => { item(r).ConnectionType = 'VPC_LINK'; }], ['get-integrations', r => { item(r).IntegrationMethod = 'GET'; }],
    ['get-authorizers', r => { item(r).AuthorizerType = 'REQUEST'; }],
    ['get-authorizers', r => { item(r).JwtConfiguration = { Issuer: 'foreign', Audience: ['foreign'] }; }],
    ['get-authorizers', r => { (r.Items as R[]).push({ AuthorizerId: 'foreign', AuthorizerType: 'JWT' }); }],
  ];
  for (const [operation, mutate] of changes) {
    const changed = structuredClone(baseline.responses), before = inventoryCanonical(changed[operation]); mutate(changed[operation] as R);
    expect(inventoryCanonical(changed[operation])).not.toBe(before);
    await expect(observeInventorySharedApi(baseline.target, baseline.snapshots, baseline.stackId, admissionFixture(),
      async (_s, o) => structuredClone(changed[o]))).rejects.toThrow();
  }
  let count = 0;
  await expect(observeInventorySharedApi(baseline.target, baseline.snapshots, baseline.stackId, admissionFixture(), async (_s, o) => {
    const response = structuredClone(baseline.responses[o]) as R;
    if (++count === 6) response.Name = 'changed'; return response;
  })).rejects.toThrow('shared_api_observation_changed');
  const forged = structuredClone(baseline.snapshots), route = Object.values(forged).flatMap(s => s.resources).find(r => r.type === 'AWS::ApiGatewayV2::Route')!;
  route.properties.RouteKey = 'POST /invented';
  await expect(observeInventorySharedApi(baseline.target, forged, baseline.stackId, admissionFixture(),
    async () => { throw Error('transport must not run'); })).rejects.toThrow('shared_api_binding_refused');
});

it('maps every active declaration in all twelve actually built templates without asserting live-service acceptance', async () => {
  const target = targetFixture(); validateInventoryQualificationTarget(target, admissionFixture());
  for (const c of target.candidates) {
    const a = artifacts.candidates.find(a => a.candidate === c.candidate)!, observed = stackFixture(c, a);
    const snapshot = inspectInventoryStackDeclarations(c, a, observed);
    expect(snapshot.resources.length).toBeGreaterThan(0); expect(snapshot.outputs.InventoryQualificationProfile).toBe(INVENTORY_PROFILE);
    expect(snapshot.outputs.DatabaseName).toBe('clinical_core_qualification');
    const report = await observeInventoryStackDeclarations(c, a, async operation => structuredClone(observed[operation === 'describe-stacks' ? 'stack' : operation === 'get-template' ? 'template' : 'resources']));
    expect(report.declarationsVerified).toBe(true);
    for (const flag of ['liveServicesVerified', 'wholeLedgerVerified', 'acceptance', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const) expect(report[flag]).toBe(false);
  }
});
it('retention schedule declarations are omitted when off and required when independently reviewed on', () => {
  const target = targetFixture(), c = target.candidates.find(c => c.candidate === 'privacy-operations')!, a = artifacts.candidates.find(a => a.candidate === 'privacy-operations')!;
  const off = inspectInventoryStackDeclarations(c, a, stackFixture(c, a)); expect(off.resources.some(r => r.logicalId === 'RetentionSweep')).toBe(false);
  Object.assign(c.parameters, { RetentionScheduleEnabled: 'true', RetentionScheduleEvidenceSha256: digest, RetentionServicePersonId: retention,
    RetentionServiceOrganizationId: organization, ExportCleanupEnabled: 'true', ExportCleanupEvidenceSha256: digest });
  validateInventoryQualificationTarget(target, admissionFixture());
  const on = stackFixture(c, a), verified = inspectInventoryStackDeclarations(c, a, on);
  expect(verified.resources.some(r => r.logicalId === 'RetentionSweep')).toBe(true);
  expect(verified.resources.find(r => r.logicalId === 'RetentionSweepSchedule')!.properties.State).toBe('ENABLED');
  on.resources.StackResourceSummaries = on.resources.StackResourceSummaries.filter(r => r.LogicalResourceId !== 'RetentionSweep');
  expect(() => inspectInventoryStackDeclarations(c, a, on)).toThrow();
});
it('checks service configurations for every active resource in all twelve built templates using fictional responses only', async () => {
  const target = targetFixture();
  const retentionCandidate = target.candidates.find(c => c.candidate === 'privacy-operations')!;
  Object.assign(retentionCandidate.parameters, { RetentionScheduleEnabled: 'true', RetentionScheduleEvidenceSha256: digest, RetentionServicePersonId: retention,
    RetentionServiceOrganizationId: organization, ExportCleanupEnabled: 'true', ExportCleanupEvidenceSha256: digest });
  validateInventoryQualificationTarget(target, admissionFixture());
  const types = new Set<string>();
  for (const c of target.candidates) {
    const a = artifacts.candidates.find(a => a.candidate === c.candidate)!;
    const snapshot = inspectInventoryStackDeclarations(c, a, stackFixture(c, a));
    for (const resource of snapshot.resources) types.add(resource.type);
    const report = await observeInventoryCandidateServices(snapshot, c, a, fictionalInventoryServices(snapshot, c, a).read);
    expect(report.serviceDeclarationsVerified).toBe(true); expect(report.resources).toBe(snapshot.resources.length);
    expect(report.observations).toBeGreaterThan(snapshot.resources.length);
    for (const flag of ['sourcePrincipalFoundationVerified', 'uploadedVersionsVerified', 'wholeLedgerVerified', 'acceptance', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const)
      expect(report[flag]).toBe(false);
  }
  expect(types.size).toBe(17);
});
it('refuses deployment, authority, data-store and configuration drift from an admitted owned-lab baseline', async () => {
  const c = targetFixture().candidates.find(c => c.candidate === 'owned-lab')!, a = artifacts.candidates.find(a => a.candidate === c.candidate)!;
  const snapshot = inspectInventoryStackDeclarations(c, a, stackFixture(c, a));
  type R = Record<string, unknown>;
  const child = (r: R, name: string) => r[name] as R;
  const first = (r: R, name: string) => (r[name] as R[])[0];
  const changes: Array<[string, string, string, (r: R) => void]> = [
    ['lambda code', 'lambda', 'get-function-configuration', r => { r.CodeSha256 = 'unrelated'; }],
    ['lambda runtime', 'lambda', 'get-function-configuration', r => { r.Runtime = 'python3.12'; }],
    ['lambda handler', 'lambda', 'get-function-configuration', r => { r.Handler = 'worker.unexpected'; }],
    ['lambda environment', 'lambda', 'get-function-configuration', r => { child(child(r, 'Environment'), 'Variables').PHI_ALLOWED = 'true'; }],
    ['lambda layers', 'lambda', 'get-function-configuration', r => { r.Layers = [{ Arn: 'foreign-layer' }]; }],
    ['lambda role', 'lambda', 'get-function-configuration', r => { r.Role = 'foreign-role'; }],
    ['lambda inactive', 'lambda', 'get-function-configuration', r => { r.State = 'Pending'; }],
    ['lambda KMS', 'lambda', 'get-function-configuration', r => { r.KMSKeyArn = 'foreign'; }],
    ['lambda logging', 'lambda', 'get-function-configuration', r => { const logging = child(r, 'LoggingConfig'); logging.LogFormat = logging.LogFormat === 'JSON' ? 'Text' : 'JSON'; }],
    ['lambda tracing', 'lambda', 'get-function-configuration', r => { r.TracingConfig = { Mode: 'Active' }; }],
    ['lambda aliases', 'lambda', 'list-aliases', r => { r.Aliases = [{ Name: 'foreign' }]; }],
    ['lambda versions', 'lambda', 'list-versions-by-function', r => { (r.Versions as unknown[]).push({ Version: '1' }); }],
    ['lambda concurrency', 'lambda', 'get-function-concurrency', r => { r.ReservedConcurrentExecutions = 500; }],
    ['public URL', 'lambda', 'get-function-url-config', r => { r.FunctionUrl = 'https://fictional.lambda-url.us-east-2.on.aws'; }],
    ['IAM boundary', 'iam', 'get-role', r => { child(r, 'Role').PermissionsBoundary = {}; }],
    ['IAM trust', 'iam', 'get-role', r => { child(r, 'Role').AssumeRolePolicyDocument = { Statement: [{ Effect: 'Allow', Principal: '*', Action: 'sts:AssumeRole' }] }; }],
    ['attached policy', 'iam', 'list-attached-role-policies', r => { r.AttachedPolicies = [{ PolicyArn: 'foreign' }]; }],
    ['IAM pagination', 'iam', 'list-role-policies', r => { r.IsTruncated = true; }],
    ['inline policy', 'iam', 'get-role-policy', r => { r.PolicyDocument = { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }; }],
    ['log encryption', 'logs', 'describe-log-groups', r => { first(r, 'logGroups').kmsKeyId = 'foreign'; }],
    ['log pagination', 'logs', 'describe-log-groups', r => { r.nextToken = 'more'; }],
    ['API anonymous', 'apigatewayv2', 'get-route', r => { r.AuthorizationType = 'NONE'; }],
    ['API target', 'apigatewayv2', 'get-integration', r => { r.IntegrationUri = 'https://foreign.invalid'; }],
    ['API remapping', 'apigatewayv2', 'get-integration', r => { r.RequestParameters = { 'overwrite:header.auth': 'foreign' }; }],
    ['authorizer', 'apigatewayv2', 'get-authorizer', r => { r.JwtConfiguration = { Issuer: 'foreign', Audience: ['foreign'] }; }],
    ['alarm action drift', 'cloudwatch', 'describe-alarms', r => { first(r, 'MetricAlarms').ActionsEnabled = !first(r, 'MetricAlarms').ActionsEnabled; }],
    ['alarm target', 'cloudwatch', 'describe-alarms', r => { first(r, 'MetricAlarms').AlarmActions = ['foreign']; }],
    ['alarm undeclared unit', 'cloudwatch', 'describe-alarms', r => { first(r, 'MetricAlarms').Unit = 'Bytes'; }],
    ['event target', 'events', 'list-targets-by-rule', r => { first(r, 'Targets').Arn = 'foreign'; }],
    ['event state drift', 'events', 'describe-rule', r => { r.State = r.State === 'DISABLED' ? 'ENABLED' : 'DISABLED'; }],
    ['Dynamo key schema', 'dynamodb', 'describe-table', r => { child(r, 'Table').KeySchema = []; }],
    ['Dynamo encryption', 'dynamodb', 'describe-table', r => { child(child(r, 'Table'), 'SSEDescription').KMSMasterKeyArn = 'foreign'; }],
    ['Dynamo index', 'dynamodb', 'describe-table', r => { first(child(r, 'Table'), 'GlobalSecondaryIndexes').IndexStatus = 'CREATING'; }],
    ['Dynamo PITR', 'dynamodb', 'describe-continuous-backups', r => { child(child(r, 'ContinuousBackupsDescription'), 'PointInTimeRecoveryDescription').PointInTimeRecoveryStatus = 'DISABLED'; }],
    ['Dynamo TTL', 'dynamodb', 'describe-time-to-live', r => { child(r, 'TimeToLiveDescription').TimeToLiveStatus = 'ENABLED'; }],
    ['Dynamo policy', 'dynamodb', 'get-resource-policy', r => { r.Policy = '{}'; }],
    ['S3 encryption', 's3api', 'get-bucket-encryption', r => { child(first(child(r, 'ServerSideEncryptionConfiguration'), 'Rules'), 'ApplyServerSideEncryptionByDefault').KMSMasterKeyID = 'foreign'; }],
    ['S3 versioning', 's3api', 'get-bucket-versioning', r => { r.Status = 'Suspended'; }],
    ['S3 public access', 's3api', 'get-public-access-block', r => { child(r, 'PublicAccessBlockConfiguration').BlockPublicPolicy = false; }],
    ['S3 platform tag binding', 's3api', 'get-bucket-tagging', r => { (r.TagSet as R[]).find(t => t.Key === 'aws:cloudformation:stack-id')!.Value = 'foreign-stack'; }],
    ['S3 undeclared lifecycle', 's3api', 'get-bucket-lifecycle-configuration', r => { r.Rules = [{ Status: 'Enabled' }]; }],
    ['S3 foreign policy', 's3api', 'get-bucket-policy', r => { r.Policy = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] }); }],
    ['state machine', 'stepfunctions', 'describe-state-machine', r => { r.definition = '{"StartAt":"foreign"}'; }],
    ['SQS encryption', 'sqs', 'get-queue-attributes', r => { child(r, 'Attributes').SqsManagedSseEnabled = 'false'; }],
    ['SQS policy', 'sqs', 'get-queue-attributes', r => { child(r, 'Attributes').Policy = '{"Statement":[]}'; }],
    ['async destination', 'lambda', 'get-function-event-invoke-config', r => { child(r, 'DestinationConfig').OnFailure = { Destination: 'foreign' }; }],
  ];
  for (const [name, service, operation, mutate] of changes) {
    const fixture = fictionalInventoryServices(snapshot, c, a);
    await expect(observeInventoryCandidateServices(snapshot, c, a, fixture.read), name + ' valid baseline').resolves.toMatchObject({ serviceDeclarationsVerified: true, acceptance: false });
    const id = [...fixture.responses.keys()].find(k => k.startsWith(`${service}/${operation}/`)); expect(id, name + ' exercised operation').toBeDefined();
    const value = fixture.responses.get(id!) ?? {}, before = inventoryCanonical(value); mutate(value as R);
    if (inventoryCanonical(value) === before) throw Error('negative fixture did not change: ' + name);
    fixture.responses.set(id!, value);
    let refused = false;
    try { await observeInventoryCandidateServices(snapshot, c, a, fixture.read); } catch { refused = true; }
    if (!refused) throw Error('service negative did not refuse: ' + name);
  }
  const incomplete = structuredClone(snapshot); incomplete.resources.pop();
  await expect(observeInventoryCandidateServices(incomplete, c, a, fictionalInventoryServices(snapshot, c, a).read)).rejects.toThrow('service_resource_coverage_refused');
  const tampered = structuredClone(snapshot);
  (tampered.resources.find(r => r.type === 'AWS::Lambda::Function')!.properties.Environment as R).Variables = { PHI_ALLOWED: 'true' };
  await expect(observeInventoryCandidateServices(tampered, c, a, fictionalInventoryServices(tampered, c, a).read)).rejects.toThrow('service_binding_refused');
  const changedPackage = structuredClone(c); changedPackage.packages[0].sha256 = 'f'.repeat(64);
  await expect(observeInventoryCandidateServices(snapshot, changedPackage, a, fictionalInventoryServices(snapshot, changedPackage, a).read)).rejects.toThrow('service_code_binding_refused');
  const fixture = fictionalInventoryServices(snapshot, c, a); let configurationReads = 0;
  await expect(observeInventoryCandidateServices(snapshot, c, a, async (s, o, p) => {
    const value = await fixture.read(s, o, p); if (s === 'lambda' && o === 'get-function-configuration' && ++configurationReads > 3) (value as R).RevisionId = 'changed'; return value;
  })).rejects.toThrow('service_observation_changed');
  let operationalReads = 0;
  await expect(observeInventoryCandidateServices(snapshot, c, a, async (s, o, p) => {
    const value = await fixture.read(s, o, p);
    if (s === 'dynamodb' && o === 'describe-table') child(value as R, 'Table').ItemCount = ++operationalReads;
    if (s === 'cloudwatch' && o === 'describe-alarms') first(value as R, 'MetricAlarms').StateUpdatedTimestamp = ++operationalReads;
    return value;
  })).resolves.toMatchObject({ serviceDeclarationsVerified: true, acceptance: false });
});
describe('actual stack declaration negative matrix', () => {
  const mutations: Array<[string, (v: ReturnType<typeof stackFixture>) => void]> = [
    ['wrong account', v => { v.stack.Stacks[0].StackId = v.stack.Stacks[0].StackId.replace('588966314750', '173535830222'); }],
    ['unfinished stack', v => { v.stack.Stacks[0].StackStatus = 'UPDATE_IN_PROGRESS'; }],
    ['changed source parameter', v => { v.stack.Stacks[0].Parameters.find(p => p.ParameterKey === 'SourceCommit')!.ParameterValue = 'f'.repeat(40); }],
    ['changed template', v => { v.template.TemplateBody.Resources.Function.Properties.Timeout = 1; }],
    ['missing resource', v => { v.resources.StackResourceSummaries.pop(); }],
    ['extra resource', v => { v.resources.StackResourceSummaries.push({ LogicalResourceId: 'Unexpected', PhysicalResourceId: 'unexpected', ResourceType: 'AWS::IAM::Role', ResourceStatus: 'CREATE_COMPLETE' }); }],
    ['duplicate resource', v => { v.resources.StackResourceSummaries.push(structuredClone(v.resources.StackResourceSummaries[0])); }],
    ['wrong resource type', v => { v.resources.StackResourceSummaries[0].ResourceType = 'AWS::IAM::Role'; }],
    ['unfinished resource', v => { v.resources.StackResourceSummaries[0].ResourceStatus = 'UPDATE_FAILED'; }],
    ['wrong function name', v => { v.resources.StackResourceSummaries.find(r => r.LogicalResourceId === 'Function')!.PhysicalResourceId = 'different-function'; }],
    ['wrong output', v => { v.stack.Stacks[0].Outputs.find(o => o.OutputKey === 'DatabaseName')!.OutputValue = 'clinical_core'; }],
  ];
  for (const [name, mutate] of mutations) it(name, () => {
    const c = targetFixture().candidates.find(c => c.candidate === 'personal-storage')!, a = artifacts.candidates.find(a => a.candidate === c.candidate)!, observed = stackFixture(c, a);
    expect(() => inspectInventoryStackDeclarations(c, a, observed)).not.toThrow(); mutate(observed); expect(() => inspectInventoryStackDeclarations(c, a, observed)).toThrow();
  });
});
it('repeated metadata drift is refused and captured inputs do not mutate while awaiting AWS', async () => {
  const c = targetFixture().candidates.find(c => c.candidate === 'personal-storage')!, a = artifacts.candidates.find(a => a.candidate === c.candidate)!, observed = stackFixture(c, a);
  let calls = 0;
  await expect(observeInventoryStackDeclarations(c, a, async operation => {
    calls++; const value = structuredClone(observed[operation === 'describe-stacks' ? 'stack' : operation === 'get-template' ? 'template' : 'resources']);
    if (calls === 4 && operation === 'describe-stacks') (value as typeof observed.stack).Stacks[0].StackStatus = 'UPDATE_IN_PROGRESS';
    return value;
  })).rejects.toThrow('stack_observation_changed'); expect(calls).toBe(6);
  await expect(observeInventoryStackDeclarations(c, a, async operation => {
    const value = structuredClone(observed[operation === 'describe-stacks' ? 'stack' : operation === 'get-template' ? 'template' : 'resources']);
    c.parameters.DatabaseName = 'clinical_core'; return value;
  })).resolves.toMatchObject({ acceptance: false, declarationsVerified: true });
});

it('reads all actual candidate/template/runtime/ZIP bytes and preserves builder identity', () => {
  expect(artifacts.candidates).toHaveLength(12); expect(artifacts.candidates.reduce((n, c) => n + c.bindings.length, 0)).toBe(15);
  expect(artifacts.candidates.reduce((n, c) => n + c.packages.length, 0)).toBe(13);
  const summary = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  expect(artifacts.source.sourceClean).toBe(summary.sourceClean); expect(artifacts.source.sourceCommit).toBe(summary.sourceCommit);
  expect(artifacts.manifestSha256).toBe(inventorySha(readFileSync(join(directory, 'manifest.json'))));
});
it('new target captures configuration and is never accepted by historical target loaders', () => {
  const fixture = targetFixture(), result = validateInventoryQualificationTarget(fixture, admissionFixture());
  expect(result.candidates).toHaveLength(12); expect(result).toEqual(fixture); expect(() => validateQualificationTargetManifest(result)).toThrow();
  fixture.candidates[0].parameters.SourceCommit = 'b'.repeat(40); expect(result.candidates[0].parameters.SourceCommit).toBe(artifacts.source.sourceCommit);
});
it('actually dirty source cannot become an admitted target by changing the target file', () => {
  const a = admissionFixture(); a.source.sourceClean = false;
  expect(() => validateInventoryQualificationTarget(targetFixture(), a)).toThrow('target_dirty_source_refused');
});
it('actual bundled CLI reports only configuration, or refuses its independently observed dirty source', () => {
  // Every identity/review/object version here remains a FICTIONAL unit fixture.
  // Successful configuration must still report review/live/deployment/acceptance
  // false; no provider request, AWS resource or review row is created.
  const file = join(directory, 'target.json'); writeFileSync(file, JSON.stringify(targetFixture()));
  const result = spawnSync(process.execPath, ['dist/aws-clinical-core/inventory-qualification-target/index.cjs', '--check-configuration', `--target=${file}`],
    { encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  if (artifacts.source.sourceClean) {
    expect(result.status).toBe(0); const report = JSON.parse(result.stdout);
    expect(report.configurationChecked).toBe(true); expect(report.candidates).toBe(12); expect(report.packages).toBe(13);
    expect(report.sourceCommit).toBe(artifacts.source.sourceCommit); expect(report.sourceInputSha256).toBe(artifacts.source.sourceInputSha256);
    expect(report.buildManifestSha256).toBe(artifacts.manifestSha256);
    for (const key of ['liveTargetVerified', 'reviewVerified', 'acceptance', 'deploymentPerformed', 'phiAllowed']) expect(report[key]).toBe(false);
  } else {
    expect(result.status).toBe(1); expect(JSON.parse(result.stderr)).toMatchObject({ category: 'dirty_source_refused', configurationChecked: false, acceptance: false });
  }
}, 250000);
it('actual bundled CLI refuses deployment commands with fixed non-sensitive output', () => {
  for (const args of [[], ['--activate'], ['--check-configuration', '--target=target.json', '--deploy'],
    ['--observe-fleet'], ['--observe-fleet', '--target='], ['--observe-fleet', '--target=target.json', '--acceptance=true'],
    ['--observe-fleet', '--target=target.json', '--phi=true'], ['--observe-fleet', '--target=target.json', '--transport=fixture']]) {
    const result = spawnSync(process.execPath, ['dist/aws-clinical-core/inventory-qualification-target/index.cjs', ...args],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ status: 'not_completed', category: 'argument_refused', configurationChecked: false,
      liveTargetVerified: false, reviewVerified: false, acceptance: false, deploymentPerformed: false, phiAllowed: false });
  }
});
describe('strict configuration negatives', () => {
  const cases: Array<[string, (v: InventoryQualificationTarget) => void]> = [
    ['legacy outer contract', v => { (v as unknown as Record<string, unknown>).contract = 'aws-clinical-core-qualification-target/3'; }],
    ['unknown top field', v => { (v as unknown as Record<string, unknown>).activation = 'approved'; }],
    ['106 release', v => { v.target.migrationReleaseHash = 'b'.repeat(64); }],
    ['staging database', v => { v.target.databaseName = 'clinical_core'; }],
    ['wrong source', v => { v.target.sourceCommit = 'b'.repeat(40); }],
    ['wrong source bytes', v => { v.sourceInputSha256 = 'b'.repeat(64); }],
    ['wrong build', v => { v.buildManifestSha256 = 'b'.repeat(64); }],
    ['no review binding', v => { v.reviewSha256 = '0'.repeat(64); }],
    ['missing candidate', v => { v.candidates.pop(); }],
    ['duplicate candidate', v => { v.candidates[0] = structuredClone(v.candidates[1]); }],
    ['wrong stack', v => { v.candidates[0].stackName = v.target.foundationStackName; }],
    ['wrong template', v => { v.candidates[0].templateSha256 = 'b'.repeat(64); }],
    ['wrong manifest', v => { v.candidates[0].manifestSha256 = 'b'.repeat(64); }],
    ['same identity pool', v => { v.identity.workforceIssuer = v.identity.consumerIssuer; }],
    ['same audience', v => { v.identity.workforceAudience = v.identity.consumerAudience; }],
    ['shared clinical artifact bucket', v => { v.artifactBucket = v.target.exportBucket; }],
    ['unknown parameter', v => { v.candidates[0].parameters.NewBypass = 'true'; }],
    ['missing parameter', v => { delete v.candidates[0].parameters.QualificationReviewSha256; }],
    ['missing independent review', v => { v.candidates[0].parameters.DatabaseReviewSha256 = ''; }],
    ['all zero review', v => { v.candidates[0].parameters.DatabaseReviewSha256 = '0'.repeat(64); }],
    ['PHI', v => { v.candidates[0].parameters.PhiAllowed = 'true'; }],
    ['production activation', v => { v.candidates[0].parameters.Activation = 'approved'; }],
    ['production evidence', v => { v.candidates[0].parameters.ActivationEvidenceSha256 = digest; }],
    ['foreign cluster', v => { v.candidates[0].parameters.DatabaseClusterArn = 'arn:aws:rds:us-east-2:173535830222:cluster:foreign'; }],
    ['foreign key', v => { v.candidates[0].parameters.SecretKmsKeyArn = kms.replace('588966314750', '173535830222'); }],
    ['wrong identity in one candidate', v => { v.candidates[0].parameters.ConsumerAudience = 'foreignaudi ence00000001'; }],
    ['omitted isolation identity', v => { v.candidates[0].parameters.QualificationIdentitySubjects = [consumer, workforce].join(','); }],
    ['wrong profile', v => { v.candidates[0].parameters.InventoryQualificationProfile = 'legacy'; }],
    ['control characters in scope', v => { v.candidates[0].parameters.AllowedScopes = 'forms_checkins\n'; }],
    ['foreign consumer recovery pool', v => { v.candidates.find(c => c.candidate === 'privacy-operations')!.parameters.ConsumerUserPoolId = 'us-east-2_ForeignFixture'; }],
    ['foreign billing origin', v => { v.candidates.find(c => c.candidate === 'owned-lab')!.parameters.BillingApiOrigin = 'https://zzzzzzzzzz.execute-api.us-east-2.amazonaws.com'; }],
    ['unreviewed claim recovery', v => { const p = v.candidates.find(c => c.candidate === 'care-connections')!.parameters;
      p.ClaimRecoveryEnabled = 'true'; p.ClaimRecoveryReviewSha256 = ''; }],
    ['unreviewed export delivery', v => { const p = v.candidates.find(c => c.candidate === 'personal-storage')!.parameters;
      p.ExportReviewSha256 = ''; }],
    ['fallback lab ranges', v => { v.candidates.find(c => c.candidate === 'owned-lab')!.parameters.LabRangeMode = 'synthetic_fixture'; }],
    ['missing range release', v => { v.candidates.find(c => c.candidate === 'owned-lab')!.parameters.LabRangeReleaseSha256 = ''; }],
    ['private range signer', v => { v.candidates.find(c => c.candidate === 'owned-lab')!.parameters.LabRangeSignerPublicKeyPem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'; }],
    ['malformed public range signer', v => { v.candidates.find(c => c.candidate === 'owned-lab')!.parameters.LabRangeSignerPublicKeyPem = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'; }],
    ['missing package', v => { v.candidates.find(c => c.candidate === 'owned-lab')!.packages.pop(); }],
    ['duplicate package', v => { const c = v.candidates.find(c => c.candidate === 'owned-lab')!; c.packages[1] = structuredClone(c.packages[0]); }],
    ['unversioned object', v => { v.candidates[0].packages[0].versionId = 'null'; }],
    ['latest object', v => { v.candidates[0].packages[0].versionId = 'latest'; }],
    ['wrong version parameter', v => { v.candidates[0].parameters.CodeVersion = 'different'; }],
    ['wrong package hash', v => { v.candidates[0].packages[0].sha256 = 'b'.repeat(64); }],
    ['wrong package size', v => { v.candidates[0].packages[0].bytes++; }],
    ['foreign prefix', v => { v.candidates[0].packages[0].key = 'staging/deployment.zip'; }],
    ['traversal prefix', v => { v.candidates[0].packages[0].key += '/../other.zip'; }],
    ['wrong code bucket parameter', v => { v.candidates[0].parameters.CodeBucket = 'different-bucket'; }],
  ];
  for (const [name, mutate] of cases) it(name, () => {
    const v = targetFixture();
    // Prove the starting configuration is admitted, so a fixture defect cannot
    // make every negative case pass for an unrelated reason.
    expect(() => validateInventoryQualificationTarget(v, admissionFixture())).not.toThrow();
    mutate(v); expect(() => validateInventoryQualificationTarget(v, admissionFixture())).toThrow();
  });
});
it('retention activation cannot name another clinic or omit the service identity', () => {
  for (const organizationId of ['', consumer]) {
    const v = targetFixture(), p = v.candidates.find(c => c.candidate === 'privacy-operations')!.parameters;
    Object.assign(p, { RetentionScheduleEnabled: 'true', RetentionScheduleEvidenceSha256: digest, RetentionServicePersonId: retention, RetentionServiceOrganizationId: organizationId });
    expect(() => validateInventoryQualificationTarget(v, admissionFixture())).toThrow();
  }
});
it('admits the non-human retention subject required by the actual release operator and refuses a human subject', () => {
  const v = targetFixture(), serviceSubject = 'svc-fictional-qualification-retention';
  v.target.identitySubjects.retentionService = serviceSubject;
  for (const c of v.candidates) {
    c.parameters.QualificationIdentitySubjects = [consumer, workforce, foreign, serviceSubject].join(',');
    if (Object.hasOwn(c.parameters, 'RetentionServiceSubject')) c.parameters.RetentionServiceSubject = serviceSubject;
  }
  const p = v.candidates.find(c => c.candidate === 'privacy-operations')!.parameters;
  Object.assign(p, { RetentionScheduleEnabled: 'true', RetentionScheduleEvidenceSha256: digest, RetentionServicePersonId: retention,
    RetentionServiceOrganizationId: organization, ExportCleanupEnabled: 'true', ExportCleanupEvidenceSha256: digest });
  expect(() => validateInventoryQualificationTarget(v, admissionFixture())).not.toThrow();
  for (const subject of [retention, 'svc-ACTUAL', 'svc-a', 'svc-name:invalid', 'svc-name_with_underscore']) {
    const changed = structuredClone(v); changed.target.identitySubjects.retentionService = subject;
    for (const c of changed.candidates) {
      c.parameters.QualificationIdentitySubjects = [consumer, workforce, foreign, subject].join(',');
      if (Object.hasOwn(c.parameters, 'RetentionServiceSubject')) c.parameters.RetentionServiceSubject = subject;
    }
    expect(() => validateInventoryQualificationTarget(changed, admissionFixture())).toThrow('target_retention_identity_refused');
  }
  const duplicate = structuredClone(v); duplicate.target.identitySubjects.retentionService = consumer;
  expect(() => validateInventoryQualificationTarget(duplicate, admissionFixture())).toThrow('target_manifest_invalid');
});
it('unknown, cyclic and nonboolean conditions never select a permissive branch', () => {
  const t = structuredClone(artifacts.candidates[0].template);
  for (const condition of [{ 'Fn::Unknown': true }, { 'Fn::Not': ['nonboolean'] }, { 'Fn::And': [true, 'false'] }, { 'Ref': 'missing' }]) {
    expect(() => inventoryCondition(condition, t, {})).toThrow('target_condition_refused');
  }
  t.Conditions.Loop = { Condition: 'Loop' }; expect(() => inventoryCondition({ Condition: 'Loop' }, t, {})).toThrow('target_condition_refused');
});
it('unknown, nonboolean and malformed independent parameter rules refuse', () => {
  for (const Rules of [{ Broken: { RuleCondition: 'false', Assertions: [{ Assert: true }] } },
    { Broken: { RuleCondition: false, Assertions: [{ Assert: { 'Fn::Unknown': true } }] } },
    { Broken: { Assertions: [{ Assert: 'true' }] } }, { Broken: { Assertions: [] } }]) {
    const t = structuredClone(artifacts.candidates[0].template); t.Rules = Rules;
    expect(() => inventoryRules(t, {})).toThrow();
  }
});
it('actual damaged code, ZIP, parent, metadata and template files are refused', () => {
  const paths = [['personal-storage', 'index.js'], ['privacy-operations', 'deployment-1.zip'], ['recording-capture', 'recording-capture-runtime.js'],
    ['owned-lab', 'template.json'], ['owned-lab', 'artifact-manifest.json'], ['care-build', 'care-messaging', 'historical-106', 'template.json'],
    ['care-build', 'care-connections', 'historical-106', 'artifact-manifest.json']];
  for (const names of paths) {
    const file = join(directory, ...names), original = readFileSync(file);
    try { writeFileSync(file, Buffer.concat([original, Buffer.from('damage')])); expect(() => readInventoryQualificationArtifacts(directory, artifacts.source)).toThrow(); }
    finally { writeFileSync(file, original); }
  }
  expect(readInventoryQualificationArtifacts(directory, artifacts.source)).toEqual(artifacts);
}, 60000);
it('symlink roots, traversal and oversized reads are rejected without following a target', () => {
  expect(() => inventoryBoundedFile(directory, ['..', 'manifest.json'], 1000)).toThrow('artifact_path_refused');
  expect(() => inventoryBoundedFile(directory, ['manifest.json'], 1)).toThrow('artifact_file_refused');
  const link = `${directory}-link`; symlinkSync(directory, link, 'junction');
  try { expect(() => readInventoryQualificationArtifacts(link, artifacts.source)).toThrow('artifact_path_refused'); }
  finally { expect(lstatSync(link).isSymbolicLink()).toBe(true); unlinkSync(link); }
});
it('independent source identity mismatch refuses before target admission', () => {
  expect(() => readInventoryQualificationArtifacts(directory, { ...artifacts.source, sourceCommit: 'b'.repeat(40) })).toThrow('artifact_source_refused');
  expect(() => readInventoryQualificationArtifacts(directory, { ...artifacts.source, sourceInputSha256: 'b'.repeat(64) })).toThrow('artifact_source_refused');
  expect(inventoryCanonical({ b: 2, a: 1 })).toBe(inventoryCanonical({ a: 1, b: 2 }));
});
