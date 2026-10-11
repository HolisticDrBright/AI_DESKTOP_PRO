// Credential-free, explicitly fictional metadata. Never a runnable target or
// evidence of any AWS deployment. Shared only by the source regression suites.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { clinicTargetCanonicalSha256 } from './clinic-records-qualification-target.mjs';

export function clinicTargetFixture(binding, candidate, migrations) {
  const temp = mkdtempSync(join(tmpdir(), 'alp-clinic-target-fixture-'));
  let deployment;
  try {
    execFileSync(process.execPath, ['scripts/build-aws-clinic-records.mjs', `--out-dir=${temp}`], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    deployment = { manifest: JSON.parse(readFileSync(join(temp, 'artifact-manifest.json'), 'utf8')), templateText: readFileSync(join(temp, 'template.json'), 'utf8'),
      zip: readFileSync(join(temp, 'deployment.zip')), code: readFileSync(join(temp, 'index.js')) };
  } finally {
    // Only this newly created test leaf, never a workspace or user directory.
    if (dirname(resolvePath(temp)) !== resolvePath(tmpdir()) || !basename(temp).startsWith('alp-clinic-target-fixture-')) throw Error('fixture_cleanup_scope');
    rmSync(temp, { recursive: true });
  }
  // Fictional source metadata for injected embedded transports only. The hosted
  // CLI instead rebuilds a clean checkout and verifies its actual commit.
  deployment.manifest.sourceClean = true; deployment.manifest.sourceCommit = binding.sourceCommit;
  const template = JSON.parse(deployment.templateText), account = '588966314750', region = 'us-east-2';
  template.Parameters.SourceCommit.AllowedValues = [binding.sourceCommit];
  deployment.templateText = JSON.stringify(template, null, 2) + '\n';
  deployment.manifest.templateSha256 = createHash('sha256').update(deployment.templateText).digest('hex');
  const stack = name => `arn:aws:cloudformation:${region}:${account}:stack/${name}/11111111-1111-4111-8111-111111111111`;
  const target = { contract: 'clinic-records-hosted-target/1', account, region, database: 'clinical_core_qualification', apiId: binding.apiId,
    clusterArn: `arn:aws:rds:${region}:${account}:cluster:fictional`, secretArn: `arn:aws:secretsmanager:${region}:${account}:secret:fictional-AbCd12`,
    functionArn: `arn:aws:lambda:${region}:${account}:function:fictional-clinic-records`, foundationStackArn: stack('fictional-foundation'),
    candidateStackArn: stack('fictional-candidate'), reviewSha256: 'a'.repeat(64), databaseReviewSha256: 'b'.repeat(64),
    foundationTemplateSha256: clinicTargetCanonicalSha256({ Description: 'fictional foundation' }), parameters: {} };
  target.parameters = Object.fromEntries(Object.entries(template.Parameters).map(([key, spec]) => [key, String(spec.Default ?? '')]));
  Object.assign(target.parameters, { ApiId: binding.apiId, DatabaseClusterArn: target.clusterArn, DatabaseSecretArn: target.secretArn, DatabaseName: target.database,
    SourceCommit: binding.sourceCommit, MigrationReleaseSha256: candidate.migrationReleaseSha256, ClinicRecordsExtensionSha256: candidate.extensionSha256,
    PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'enabled', QualificationAccountId: account,
    QualificationIdentitySubjects: Object.values(binding.subjects).join(','), QualificationReviewSha256: binding.reviews.qualification,
    DatabaseReviewSha256: target.databaseReviewSha256, DisclosureReviewSha256: binding.reviews.disclosure,
    RetentionReviewSha256: binding.reviews.retention, WorkforceMfaReviewSha256: binding.reviews.workforceMfa,
    OrganizationId: binding.organizationId, ConsumerIssuer: binding.consumerIssuer, ConsumerAudience: binding.consumerAudience,
    WorkforceIssuer: binding.workforceIssuer, WorkforceAudience: binding.workforceAudience,
    CodeBucket: 'fictional-code', CodeKey: 'fictional/deployment.zip', CodeVersion: 'fictional-version',
    SecretKmsKeyArn: `arn:aws:kms:${region}:${account}:key/11111111-1111-4111-8111-111111111111`,
    LogsKmsKeyArn: `arn:aws:kms:${region}:${account}:key/22222222-2222-4222-8222-222222222222`,
    AlarmTopicArn: `arn:aws:sns:${region}:${account}:fictional-alarms` });
  const parameterRows = values => Object.entries(values).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
  const foundation = { StackId: target.foundationStackArn, StackStatus: 'CREATE_COMPLETE',
    Parameters: parameterRows({ DatabaseClusterArn: target.clusterArn, DatabaseSecretArn: target.secretArn }),
    Outputs: Object.entries({ ApiId: binding.apiId, PhiAllowed: 'false', Activation: 'blocked' }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const candidateStack = { StackId: target.candidateStackArn, StackStatus: 'CREATE_COMPLETE', Parameters: parameterRows(target.parameters) };
  const resources = { Function: 'fictional-clinic-records', Role: 'fictional-role', Integration: 'fictional-integration',
    ConsumerAuthorizer: 'fictional-consumer-auth', WorkforceAuthorizer: 'fictional-workforce-auth',
    RouteConsumerClinicRecords: 'fictional-consumer-route', RouteWorkforceClinicRecords: 'fictional-workforce-route' };
  const resolve = value => typeof value === 'string' ? value : value.Ref ? value.Ref === 'AWS::AccountId' ? account : target.parameters[value.Ref] : resolve(value['Fn::If'][1]);
  const lambda = { Configuration: { FunctionArn: target.functionArn, State: 'Active', LastUpdateStatus: 'Successful', Runtime: 'nodejs22.x',
    Handler: 'index.handler', PackageType: 'Zip', Role: `arn:aws:iam::${account}:role/fictional-role`,
    CodeSha256: Buffer.from(deployment.manifest.deploymentZipSha256, 'hex').toString('base64'), CodeSize: deployment.zip.length,
    Environment: { Variables: Object.fromEntries(Object.entries(template.Resources.Function.Properties.Environment.Variables).map(([key, value]) => [key, resolve(value)])) } } };
  const routes = ['Consumer', 'Workforce'].map(pool => ({ RouteKey: `POST /clinical-core/${pool.toLowerCase()}/clinic-records`,
    RouteId: resources[`Route${pool}ClinicRecords`], AuthorizationType: 'JWT', AuthorizerId: resources[`${pool}Authorizer`], Target: `integrations/${resources.Integration}` }));
  const snapshots = { foundation, candidateStack, template, lambda, routes, resources };
  const readAws = async (service, operation, args) => {
    switch (`${service}/${operation}`) {
      case 'sts/get-caller-identity': return { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/OrganizationAccountAccessRole/fictional`, UserId: 'fictional:user' };
      case 'cloudformation/describe-stacks': return { Stacks: [args['stack-name'] === target.foundationStackArn ? foundation : candidateStack] };
      case 'cloudformation/get-template': return { TemplateBody: args['stack-name'] === target.foundationStackArn ? { Description: 'fictional foundation' } : template };
      case 'cloudformation/list-stack-resources': return { StackResourceSummaries: Object.entries(resources).map(([LogicalResourceId, PhysicalResourceId]) => ({ LogicalResourceId, PhysicalResourceId, ResourceStatus: 'CREATE_COMPLETE' })) };
      case 'rds/describe-db-clusters': return { DBClusters: [{ DBClusterArn: target.clusterArn, Status: 'available', HttpEndpointEnabled: true, StorageEncrypted: true, Engine: 'aurora-postgresql' }] };
      case 'secretsmanager/describe-secret': return { ARN: target.secretArn };
      case 'apigatewayv2/get-api': return { ApiId: binding.apiId, ProtocolType: 'HTTP', ApiEndpoint: `https://${binding.apiId}.execute-api.${region}.amazonaws.com` };
      case 'apigatewayv2/get-stage': return { StageName: '$default', AutoDeploy: true, DeploymentId: 'fictional-deployment' };
      case 'apigatewayv2/get-deployment': return { DeploymentId: 'fictional-deployment', DeploymentStatus: 'DEPLOYED', AutoDeployed: true };
      case 'lambda/get-function': return lambda;
      case 'apigatewayv2/get-routes': return { Items: routes };
      case 'apigatewayv2/get-authorizer': {
        const pool = args['authorizer-id'] === resources.ConsumerAuthorizer ? 'Consumer' : 'Workforce';
        return { AuthorizerId: args['authorizer-id'], AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
          JwtConfiguration: { Issuer: target.parameters[`${pool}Issuer`], Audience: [target.parameters[`${pool}Audience`]] } };
      }
      case 'apigatewayv2/get-integration': return { IntegrationId: resources.Integration, IntegrationType: 'AWS_PROXY', IntegrationUri: target.functionArn, PayloadFormatVersion: '2.0' };
      default: throw Error('fictional_read_not_defined');
    }
  };
  return { target, deployment, migrations, readAws, snapshots };
}
