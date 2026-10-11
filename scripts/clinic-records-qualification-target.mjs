import { createHash } from 'node:crypto';

const ACCOUNT = '588966314750', REGION = 'us-east-2', DATABASE = 'clinical_core_qualification';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const refuse = category => { throw new ClinicTargetError(category); };
export class ClinicTargetError extends Error { constructor(category) { super(category); this.category = category; } }
const stackArn = value => typeof value === 'string' && /^arn:aws:cloudformation:us-east-2:588966314750:stack\/[A-Za-z][A-Za-z0-9-]*\/[a-f0-9-]{36}$/.test(value);
const pairs = (rows, key, value) => {
  if (!Array.isArray(rows) || rows.some(row => typeof row?.[key] !== 'string' || typeof row?.[value] !== 'string')
    || new Set(rows.map(row => row[key])).size !== rows.length) refuse('target_metadata_shape');
  return Object.fromEntries(rows.map(row => [row[key], row[value]]));
};
const templateBody = body => { try { return typeof body === 'string' ? JSON.parse(body) : body; } catch { return refuse('target_template'); } };

/** A target names reviewed expectations, never observed facts or review approval.
 * The local deployment bytes and full SQL artifact are separately checked before
 * reading AWS. Fake transports remain embedded evidence, not hosted acceptance. */
export function assertClinicTarget({ target: t, binding: b, candidate: c, deployment: d, migrations }) {
  if (t?.contract !== 'clinic-records-hosted-target/1' || t.account !== ACCOUNT || t.region !== REGION || t.database !== DATABASE
    || t.apiId !== b.apiId || !stackArn(t.foundationStackArn) || !stackArn(t.candidateStackArn) || t.foundationStackArn === t.candidateStackArn
    || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(t.clusterArn ?? '')
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(t.secretArn ?? '')
    || !/^arn:aws:lambda:us-east-2:588966314750:function:[A-Za-z0-9-_]+$/.test(t.functionArn ?? '')
    || !digest(t.foundationTemplateSha256) || !digest(t.reviewSha256) || !digest(t.databaseReviewSha256)) refuse('target_manifest');
  if (!d || typeof d.templateText !== 'string' || !Buffer.isBuffer(d.zip) || !Buffer.isBuffer(d.code)
    || d.manifest?.contract !== 'clinic-records-deployment/1' || d.manifest.sourceClean !== true
    || d.manifest.sourceCommit !== b.sourceCommit || d.manifest.migrationCount !== 116
    || d.manifest.migrationReleaseSha256 !== c.migrationReleaseSha256 || d.manifest.extensionSha256 !== c.extensionSha256
    || hash(d.templateText) !== d.manifest.templateSha256 || hash(d.zip) !== d.manifest.deploymentZipSha256
    || hash(d.code) !== d.manifest.codeSha256 || d.zip.length !== d.manifest.deploymentZipBytes) refuse('target_local_artifact');
  const template = templateBody(d.templateText), p = t.parameters;
  if (!template?.Parameters || !p || !same(Object.keys(p).sort(), Object.keys(template.Parameters).sort())
    || Object.values(p).some(v => typeof v !== 'string')) refuse('target_parameters');
  const required = { ApiId: b.apiId, DatabaseClusterArn: t.clusterArn, DatabaseSecretArn: t.secretArn, DatabaseName: DATABASE,
    SourceCommit: b.sourceCommit, MigrationReleaseSha256: c.migrationReleaseSha256, ClinicRecordsExtensionSha256: c.extensionSha256,
    PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'enabled', QualificationAccountId: ACCOUNT,
    QualificationIdentitySubjects: Object.values(b.subjects).join(','), QualificationReviewSha256: b.reviews.qualification,
    DatabaseReviewSha256: t.databaseReviewSha256, DisclosureReviewSha256: b.reviews.disclosure,
    RetentionReviewSha256: b.reviews.retention, WorkforceMfaReviewSha256: b.reviews.workforceMfa,
    OrganizationId: b.organizationId, ConsumerIssuer: b.consumerIssuer, ConsumerAudience: b.consumerAudience,
    WorkforceIssuer: b.workforceIssuer, WorkforceAudience: b.workforceAudience };
  if (Object.entries(required).some(([k, v]) => p[k] !== v)
    || !/^arn:aws:sns:us-east-2:588966314750:[A-Za-z0-9-_]+$/.test(p.AlarmTopicArn ?? '')) refuse('target_posture');
  for (const [key, spec] of Object.entries(template.Parameters)) {
    const value = p[key];
    if (spec.AllowedValues && !spec.AllowedValues.map(String).includes(value)
      || spec.AllowedPattern && !new RegExp(`^(?:${spec.AllowedPattern})$`).test(value)
      || spec.MinLength !== undefined && value.length < spec.MinLength || spec.MaxLength !== undefined && value.length > spec.MaxLength) refuse('target_parameter_value');
  }
  if (!Array.isArray(migrations) || migrations.length !== 116 || migrations.some((row, i) => !/^\d{14}$/.test(row?.version ?? '')
    || !digest(row?.sha256) || i > 0 && migrations[i - 1].version >= row.version)
    || hash(migrations.map(row => `${row.version}:${row.sha256}`).join('\n')) !== c.migrationReleaseSha256) refuse('target_local_ledger');
  return { template, parameters: required };
}

/** Only fixed read operations are passed to the AWS adapter; no secrets are
 * retrieved, SQL writes made, permissions granted or reviews synthesized. */
export async function observeClinicTarget(input) {
  const { target: t, candidate: c, deployment: d, migrations, ports } = input;
  const { template } = assertClinicTarget(input);
  if (typeof ports?.readAws !== 'function' || typeof ports?.sql !== 'function') refuse('target_observer_required');
  const read = async (service, operation, args = {}) => {
    const response = await ports.readAws(service, operation, args);
    if (!response || typeof response !== 'object') refuse('target_metadata_shape');
    return response;
  };
  const principal = await read('sts', 'get-caller-identity');
  if (principal.Account !== ACCOUNT || !String(principal.Arn ?? '').startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/OrganizationAccountAccessRole/`)
    || !principal.UserId || !principal.Arn.split('/')[2]) refuse('target_principal');
  const stack = async arn => {
    const observed = await read('cloudformation', 'describe-stacks', { 'stack-name': arn });
    if (observed.Stacks?.length !== 1 || observed.Stacks[0].StackId !== arn
      || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(observed.Stacks[0].StackStatus)) refuse('target_stack');
    return observed.Stacks[0];
  };
  const foundation = await stack(t.foundationStackArn);
  const fp = pairs(foundation.Parameters, 'ParameterKey', 'ParameterValue'), fo = pairs(foundation.Outputs, 'OutputKey', 'OutputValue');
  if (fp.DatabaseClusterArn !== t.clusterArn || fp.DatabaseSecretArn !== t.secretArn || fo.ApiId !== t.apiId
    || fo.PhiAllowed !== 'false' || fo.Activation !== 'blocked') refuse('target_foundation');
  const ft = templateBody((await read('cloudformation', 'get-template', { 'stack-name': t.foundationStackArn, 'template-stage': 'Original' })).TemplateBody);
  if (hash(canonical(ft)) !== t.foundationTemplateSha256) refuse('target_foundation_template');
  const candidateStack = await stack(t.candidateStackArn);
  if (!same(pairs(candidateStack.Parameters, 'ParameterKey', 'ParameterValue'), t.parameters)) refuse('target_stack_parameters');
  const ct = templateBody((await read('cloudformation', 'get-template', { 'stack-name': t.candidateStackArn, 'template-stage': 'Original' })).TemplateBody);
  if (!same(ct, template)) refuse('target_template');
  const resources = await read('cloudformation', 'list-stack-resources', { 'stack-name': t.candidateStackArn });
  if (resources.NextToken || !Array.isArray(resources.StackResourceSummaries)) refuse('target_resource_pagination');
  const physical = key => {
    const rows = resources.StackResourceSummaries.filter(row => row.LogicalResourceId === key);
    if (rows.length !== 1 || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(rows[0].ResourceStatus) || !rows[0].PhysicalResourceId) refuse('target_resource');
    return rows[0].PhysicalResourceId;
  };
  if (t.functionArn !== `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${physical('Function')}`) refuse('target_function_binding');
  const [cluster, secret, api, fn] = await Promise.all([
    read('rds', 'describe-db-clusters', { 'db-cluster-identifier': t.clusterArn }),
    read('secretsmanager', 'describe-secret', { 'secret-id': t.secretArn }),
    read('apigatewayv2', 'get-api', { 'api-id': t.apiId }),
    read('lambda', 'get-function', { 'function-name': t.functionArn }),
  ]);
  const db = cluster.DBClusters?.[0];
  if (cluster.DBClusters?.length !== 1 || db.DBClusterArn !== t.clusterArn || db.Status !== 'available' || db.HttpEndpointEnabled !== true
    || db.StorageEncrypted !== true || db.Engine !== 'aurora-postgresql' || secret.ARN !== t.secretArn || secret.DeletedDate) refuse('target_database_resources');
  if (api.ApiId !== t.apiId || api.ProtocolType !== 'HTTP' || api.DisableExecuteApiEndpoint === true
    || api.ApiEndpoint !== `https://${t.apiId}.execute-api.${REGION}.amazonaws.com`) refuse('target_api');
  const stage = await read('apigatewayv2', 'get-stage', { 'api-id': t.apiId, 'stage-name': '$default' });
  if (stage.StageName !== '$default' || stage.AutoDeploy !== true || !stage.DeploymentId) refuse('target_stage');
  const published = await read('apigatewayv2', 'get-deployment', { 'api-id': t.apiId, 'deployment-id': stage.DeploymentId });
  if (published.DeploymentId !== stage.DeploymentId || published.DeploymentStatus !== 'DEPLOYED' || published.AutoDeployed !== true) refuse('target_stage_deployment');
  const config = fn.Configuration;
  const resolve = value => {
    if (typeof value === 'string') return value;
    if (value?.Ref) return value.Ref === 'AWS::AccountId' ? ACCOUNT : t.parameters[value.Ref] ?? refuse('target_environment');
    if (value?.['Fn::If']?.[0] === 'Qualification') return resolve(value['Fn::If'][1]);
    return refuse('target_environment');
  };
  const environment = Object.fromEntries(Object.entries(template.Resources.Function.Properties.Environment.Variables).map(([key, value]) => [key, resolve(value)]));
  if (config?.FunctionArn !== t.functionArn || config.State !== 'Active' || config.LastUpdateStatus !== 'Successful'
    || config.Runtime !== 'nodejs22.x' || config.Handler !== 'index.handler' || config.PackageType !== 'Zip'
    || config.Role !== `arn:aws:iam::${ACCOUNT}:role/${physical('Role')}`
    || config.CodeSha256 !== Buffer.from(d.manifest.deploymentZipSha256, 'hex').toString('base64')
    || config.CodeSize !== d.zip.length || config.Environment?.Error || !same(config.Environment?.Variables, environment)) refuse('target_lambda');
  const routes = [], seen = new Set();
  let next;
  do {
    const page = await read('apigatewayv2', 'get-routes', { 'api-id': t.apiId, ...(next ? { 'next-token': next } : {}) });
    if (!Array.isArray(page.Items) || page.NextToken && (typeof page.NextToken !== 'string' || seen.has(page.NextToken)) || seen.size > 100) refuse('target_route_pagination');
    routes.push(...page.Items); next = page.NextToken; if (next) seen.add(next);
  } while (next);
  for (const pool of ['Consumer', 'Workforce']) {
    const path = `POST /clinical-core/${pool.toLowerCase()}/clinic-records`, matches = routes.filter(row => row.RouteKey === path);
    const id = physical(`Route${pool}ClinicRecords`), authorizer = physical(`${pool}Authorizer`), integration = physical('Integration');
    if (matches.length !== 1 || matches[0].RouteId !== id || matches[0].AuthorizationType !== 'JWT'
      || matches[0].AuthorizerId !== authorizer || matches[0].Target !== `integrations/${integration}`) refuse('target_route');
    const auth = await read('apigatewayv2', 'get-authorizer', { 'api-id': t.apiId, 'authorizer-id': authorizer });
    const transport = await read('apigatewayv2', 'get-integration', { 'api-id': t.apiId, 'integration-id': integration });
    if (auth.AuthorizerId !== authorizer || auth.AuthorizerType !== 'JWT' || !same(auth.IdentitySource, ['$request.header.Authorization'])
      || !same(auth.JwtConfiguration, { Issuer: t.parameters[`${pool}Issuer`], Audience: [t.parameters[`${pool}Audience`]] })
      || transport.IntegrationId !== integration || transport.IntegrationType !== 'AWS_PROXY' || transport.IntegrationUri !== t.functionArn
      || transport.PayloadFormatVersion !== '2.0') refuse('target_route_authority');
  }
  // One statement yields the name and ordered ledger from one DB snapshot.
  const result = await ports.sql("select current_database() as database, coalesce((select json_agg(json_build_object('version',version,'sha256',sha256) order by version) from clinical_core.schema_migrations),'[]'::json) as ledger", []);
  const row = result?.rows?.[0], actual = typeof row?.ledger === 'string' ? JSON.parse(row.ledger) : row?.ledger;
  if (result?.rows?.length !== 1 || row.database !== DATABASE || !same(actual, migrations)) refuse('target_actual_ledger');
  return { contract: 'clinic-records-target-observation/1', account: principal.Account, principalArn: principal.Arn, region: REGION,
    database: row.database, apiId: api.ApiId, functionArn: config.FunctionArn, sourceCommit: config.Environment.Variables.SOURCE_COMMIT,
    migrationRows: actual.length, migrationReleaseSha256: c.migrationReleaseSha256, extensionSha256: c.extensionSha256,
    zipSha256: d.manifest.deploymentZipSha256, foundationStackArn: foundation.StackId, candidateStackArn: candidateStack.StackId,
    routes: ['POST /clinical-core/consumer/clinic-records', 'POST /clinical-core/workforce/clinic-records'], phiAllowed: false,
    activation: 'blocked', qualification: 'enabled', humanReviewsVerified: false, atomicAwsSnapshot: false };
}

export const clinicTargetCanonicalSha256 = value => hash(canonical(value));
