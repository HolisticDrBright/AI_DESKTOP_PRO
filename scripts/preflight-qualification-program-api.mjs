/** Read-only, fixed-target preflight. This neither deploys nor enables programs. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const account = '588966314750';
const region = 'us-east-2';
const profile = 'ai-synthetic-member';
const apiId = '6zt8e9qz04';
const foundationName = 'ai-clinical-core-qualification-foundation';
const billingName = 'ai-clinical-core-qualification-core-billing';
const ledgerSha256 = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
const boundarySha256 = '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6';
const qualificationFunctionSha256 = '83ce2f61711f9fa8b94962cf9330af8eb2e0c984a55e4c0edf2a40764c8a31af';
const assignmentFunctionSha256 = 'd9c07fec841cd1d68689be602c933fa67cddd343f4ee5228f336efe9362c981d';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = reason => { throw new Error(`qualification_program_preflight_refused:${reason}`); };
const map = rows => Object.fromEntries((rows ?? []).map(row => [row.OutputKey ?? row.ParameterKey,
  row.OutputValue ?? row.ParameterValue]));
const field = cell => cell?.stringValue ?? cell?.longValue ?? cell?.booleanValue;

export function evaluateQualificationProgramPreflight(input) {
  const { caller, foundation, billing, routes, authorizers, database, template, buildIdentity,
    sourceCommit, sourceClean, bundleSha256 } = input;
  if (caller?.Account !== account || !String(caller.Arn ?? '').startsWith(`arn:aws:sts::${account}:assumed-role/`)) reject('account');
  if (!sourceClean || !/^[a-f0-9]{40}$/.test(sourceCommit) || buildIdentity?.sourceCommit !== sourceCommit
    || buildIdentity?.contract !== 'qualification-program-bundle/1'
    || buildIdentity?.boundaryCandidateSha256 !== boundarySha256 || buildIdentity?.bundleSha256 !== bundleSha256) reject('source');
  if (template?.Metadata?.ClinicalCore?.ContractVersion !== 'qualification-program-api-candidate/2'
    || template.Metadata.ClinicalCore.RuntimeSchemaRequirement?.BoundaryCandidateSha256 !== boundarySha256
    || template.Metadata.ClinicalCore.RuntimeSchemaRequirement?.MigrationReleaseSha256 !== ledgerSha256
    || template.Metadata.ClinicalCore.PhiAllowed !== false || template.Metadata.ClinicalCore.Activation !== 'blocked') reject('template');
  const f = map(foundation?.Outputs);
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(foundation?.StackStatus)
    || f.ApiId !== apiId || f.DatabaseName !== 'clinical_core_qualification'
    || f.PhiAllowed !== 'false' || f.Activation !== 'blocked' || f.QualificationExecution !== 'disabled'
    || f.DataClassification !== 'synthetic_only' || f.CodeBucket !== 'alp-qualification-code-588966314750-us-east-2'
    || f.AlarmTopicArn !== 'arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms'
    || template.Parameters.DatabaseClusterArn?.AllowedValues?.[0] !== f.DatabaseClusterArn
    || template.Parameters.ClinicalCoreKeyArn?.AllowedValues?.[0] !== f.LogsKmsKeyArn) reject('foundation');
  const b = map(billing?.Parameters), bo = map(billing?.Outputs);
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(billing?.StackStatus) || b.BillingActivation !== 'blocked'
    || b.CommercialReleaseApproval !== 'blocked' || b.EnabledStores !== 'none'
    || b.StoreEnvironment !== 'Sandbox' || b.StoreSecretArn !== '' || b.ReservedConcurrency !== '0'
    || bo.Activation !== 'blocked'
    || template.Parameters.ConsumerUserPoolId?.AllowedValues?.[0] !== b.ConsumerPoolId
    || template.Parameters.ConsumerUserPoolClientId?.AllowedValues?.[0] !== b.ConsumerClientId
    || !/^https:\/\/[a-z0-9]{10}\.execute-api\.us-east-2\.amazonaws\.com$/.test(bo.ApiOrigin ?? '')) reject('billing');
  const expected = [
    { pool: template.Parameters.ConsumerUserPoolId.AllowedValues[0], client: template.Parameters.ConsumerUserPoolClientId.AllowedValues[0] },
    { pool: template.Parameters.WorkforceUserPoolId?.AllowedValues?.[0], client: template.Parameters.WorkforceUserPoolClientId?.AllowedValues?.[0] },
  ];
  if (!Array.isArray(routes?.Items) || routes.Items.length < 30
    || routes.Items.some(row => typeof row.RouteKey !== 'string' || row.RouteKey.includes('/programs')
      || row.RouteKey.includes('$default') || row.RouteKey.includes('{proxy+}'))) reject('routes');
  if (!Array.isArray(authorizers?.Items) || expected.some(({ pool, client }) => !authorizers.Items.some(a =>
    a.AuthorizerType === 'JWT' && a.JwtConfiguration?.Issuer === `https://cognito-idp.${region}.amazonaws.com/${pool}`
      && a.JwtConfiguration?.Audience?.length === 1 && a.JwtConfiguration.Audience[0] === client))) reject('authorizers');
  const row = database?.records?.[0]?.map(field);
  if (!row || row.length !== 15 || row[0] !== 'clinical_core_qualification' || row[1] !== 112
    || row[2] !== ledgerSha256 || row[3] !== false || row[4] !== 0 || row[5] !== false || row[6] !== false
    || row[7] !== qualificationFunctionSha256 || row[8] !== assignmentFunctionSha256 || row[9] !== 0
    || row.slice(10).some(count => count !== 1)) reject('database');
  return { contract: 'qualification-program-api-preflight/1', account, region, database: row[0],
    sourceCommit, programRouteVacant: true, reviewedBoundaryInstalledButDisabled: true,
    qualificationSubjects: 0, designatedFictionalAccountsBound: true, billing: 'blocked', phiAllowed: false,
    templateSha256: sha(JSON.stringify(template)), bundleSha256,
    changeSetReady: false, reason: 'requires_reviewed_subjects_and_separate_deployment_review' };
}

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

const databaseSql = `select current_database(),
  (select count(*)::int from clinical_core.schema_migrations),
  (select encode(sha256(convert_to(string_agg(version||':'||sha256,E'\\n' order by version),'UTF8')),'hex')
    from clinical_core.schema_migrations),
  (select enabled from clinical_core.program_qualification_boundary),
  (select count(*)::int from clinical_core.program_qualification_subjects),
  (select enabled from clinical_core.production_program_activation),
  (select enabled from clinical_core.program_consumer_boundary_activation),
  (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p
    where p.oid=to_regprocedure('clinical_private.program_qualification_open()')),
  (select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') from pg_proc p
    where p.oid=to_regprocedure('clinical_core.production_program_assignment_request(jsonb)')),
  (select count(*)::int from clinical_core.program_assignments),
  -- Qualification fixtures use production-shaped classification even though the
  -- account and fixture manifest prohibit real patient data.
  (select count(*)::int from clinical_core.organizations where id='a82dafa6-190f-4769-bb0a-89f4f318b5aa'
    and status='active' and data_classification='clinical_phi' and contains_phi=true),
  (select count(*)::int from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
    where i.identity_subject='a16b2580-9091-709c-26f5-543bc0f312a9' and i.identity_pool='consumer'
    and i.person_id='c6ae03bd-acde-4344-8d6d-95aa1d815ee1' and i.status='active' and i.production_bound
    and p.status='active' and p.data_classification='clinical_phi' and p.contains_phi=true),
  (select count(*)::int from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
    where i.identity_subject='815b1540-10d1-706c-53f9-6955699ac385' and i.identity_pool='consumer'
    and i.person_id='cb850e33-20a6-4339-b559-d36f65e8dba9' and i.status='active' and i.production_bound
    and p.status='active' and p.data_classification='clinical_phi' and p.contains_phi=true),
  (select count(*)::int from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
    where i.identity_subject='31db0500-60b1-70b4-9046-371730a55db5' and i.identity_pool='workforce'
    and i.person_id='da08c358-0091-406e-8a26-799ca366d822' and i.status='active' and i.production_bound
    and p.status='active' and p.data_classification='clinical_phi' and p.contains_phi=true),
  (select count(*)::int from clinical_core.organization_memberships where organization_id='a82dafa6-190f-4769-bb0a-89f4f318b5aa'
    and person_id='da08c358-0091-406e-8a26-799ca366d822' and role='practitioner' and status='active')`;

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only-fictional') reject('command');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const sourceClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
    { encoding: 'utf8', windowsHide: true }).trim();
  const template = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-successor.json', 'utf8'));
  const buildIdentity = JSON.parse(readFileSync('dist/aws-clinical-core/qualification-program/build-identity.json', 'utf8'));
  const bundleSha256 = sha(readFileSync('dist/aws-clinical-core/qualification-program/index.js'));
  const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', foundationName).Stacks?.[0];
  const f = map(foundation?.Outputs);
  const result = evaluateQualificationProgramPreflight({
    caller: aws('sts', 'get-caller-identity'), foundation,
    billing: aws('cloudformation', 'describe-stacks', '--stack-name', billingName).Stacks?.[0],
    routes: aws('apigatewayv2', 'get-routes', '--api-id', apiId),
    authorizers: aws('apigatewayv2', 'get-authorizers', '--api-id', apiId),
    database: aws('rds-data', 'execute-statement', '--resource-arn', f.DatabaseClusterArn,
      '--secret-arn', f.DatabaseSecretArn, '--database', 'clinical_core_qualification', '--sql', databaseSql),
    template, buildIdentity, sourceCommit, sourceClean, bundleSha256,
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error.message ?? 'qualification_program_preflight_failed'));
    process.exitCode = 1; });
}
