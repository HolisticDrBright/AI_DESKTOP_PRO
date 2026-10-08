/** Creates a reviewable, unexecuted code-only change set. Never updates the stack or database. */
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P, normalizedText, sha256, careSourceSnapshot, careMobileBinding, refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {verifyCareUploadPreparation} from './upload-synthetic-care-release.mjs';
import {SYNTHETIC_MEMBER_PROFILE, observeSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
export function careCodeChangeInputs(source, prepared, parameters, manifest, artifact) {
  const expected = structuredClone(source);
  for (const name of P.absentRoutes) delete expected.Resources[name];
  expected.Outputs.RoutesEnabled.Value = '51';
  const names = Object.keys(source.Parameters).sort(), supplied = parameters?.map(p => p.ParameterKey).sort();
  if (canonical(prepared) !== canonical(expected) || canonical(names) !== canonical(supplied)
    || parameters.some(p => canonical(p) !== canonical(p.ParameterKey === 'LambdaCodeKey'
      ? {ParameterKey: 'LambdaCodeKey', ParameterValue: manifest.key} : {ParameterKey: p.ParameterKey, UsePreviousValue: true}))
    || artifact?.bucket !== P.bucket || artifact.key !== manifest.key || artifact.sha256 !== manifest.zipSha256
    || artifact.bytes !== manifest.zipBytes || artifact.exactVersionReadbackVerified !== true
    || artifact.encryption !== 'aws:kms' || artifact.kmsKeyArn !== P.keyArn
    || typeof artifact.versionId !== 'string' || !artifact.versionId || artifact.versionId === 'null'
    || artifact.versionId.length > 1024) fail('code_change_inputs');
  expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion = artifact.versionId;
  return {template: expected, parameters: structuredClone(parameters)};
}
export function verifyCareCodeChangeSet(set, actualTemplate, input, binding) {
  return verifyCareCodeChangeSetState(set, actualTemplate, input, binding, 'AVAILABLE');
}
/** Separate observation profile. It never admits execution and never relabels
 * an executed service response as an available proposal. */
export function verifyExecutedCareCodeChangeSet(set, actualTemplate, input, binding) {
  return verifyCareCodeChangeSetState(set, actualTemplate, input, binding, 'EXECUTE_COMPLETE');
}
function verifyCareCodeChangeSetState(set, actualTemplate, input, binding, executionStatus) {
  if (set?.StackId !== binding.stackId || set.StackName !== P.stack || set.ChangeSetName !== binding.name
    || set.ChangeSetId !== binding.id || !binding.id?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${binding.name}/`)
    || set.Status !== 'CREATE_COMPLETE' || set.ExecutionStatus !== executionStatus || set.ParentChangeSetId
    || set.IncludeNestedStacks === true || set.DeploymentMode || set.ImportExistingResources === true
    || canonical(set.Capabilities) !== canonical(['CAPABILITY_IAM']) || set.NextToken
    || canonical(actualTemplate) !== canonical(input.template)) fail('code_change_set');
  const expected = {ClinicalApiId: P.apiId, DatabaseName: P.database, DatabaseClusterArn: P.cluster, DatabaseSecretArn: '****',
    ConsumerUserPoolId: P.consumerPool, ConsumerUserPoolClientId: P.consumerClient, WorkforceUserPoolId: P.workforcePool,
    WorkforceUserPoolClientId: P.workforceClient, ClinicalCoreKeyArn: P.keyArn, LambdaCodeBucket: P.bucket,
    LambdaCodeKey: input.parameters.find(p => p.ParameterKey === 'LambdaCodeKey').ParameterValue};
  if (!Array.isArray(set.Parameters) || set.Parameters.length !== 11 || new Set(set.Parameters.map(p => p.ParameterKey)).size !== 11
    || set.Parameters.some(p => !Object.hasOwn(expected, p.ParameterKey) || typeof p.ParameterValue !== 'string'
      || p.ParameterValue !== expected[p.ParameterKey])) fail('code_change_parameters');
  const change = set.Changes?.[0]?.ResourceChange;
  if (set.Changes?.length !== 1 || set.Changes[0].Type !== 'Resource' || change?.Action !== 'Modify'
    || change.LogicalResourceId !== 'IdentityApiFunction' || change.PhysicalResourceId !== P.functionName
    || change.ResourceType !== 'AWS::Lambda::Function' || change.Replacement !== 'False'
    || canonical(change.Scope) !== canonical(['Properties']) || !change.Details?.length
    || change.Details.some(d => d.Target?.Attribute !== 'Properties' || d.Target.Name !== 'Code'
      || d.Target.RequiresRecreation !== 'Never'
      || !['DirectModification', 'ParameterReference'].includes(d.ChangeSource)
      || d.ChangeSource === 'ParameterReference' && d.CausingEntity !== 'LambdaCodeKey')) fail('code_change_resources');
}
const aws = args => {
  try {return JSON.parse(execFileSync('aws', [...args, '--profile', SYNTHETIC_MEMBER_PROFILE, '--region', P.region, '--output', 'json'],
    {encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}));}
  catch {fail('code_change_aws_failed_or_unconfirmed');}
};
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--v2-root' || args[2] !== '--candidate' || args[4] !== '--prepare-code-change-only'
    || args[1].startsWith('--') || args[3].startsWith('--')) fail('arguments');
  const root = process.cwd(), mobileRoot = resolve(args[1]), dir = resolve(args[3]);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'artifact-manifest.json'), 'utf8'));
  // Fresh full target observation, real handler rebuild and exact S3-version download.
  const upload = JSON.parse(execFileSync(process.execPath, [resolve(root, 'scripts/upload-synthetic-care-release.mjs'),
    '--v2-root', mobileRoot, '--candidate', dir, '--upload-fictional-code-only'],
  {encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}));
  const plan = JSON.parse(readFileSync(resolve(upload.preparation, 'preparation.json'), 'utf8'));
  verifyCareUploadPreparation(plan, manifest); observeSyntheticMemberIdentity();
  const source = JSON.parse(normalizedText(root, 'infra/aws-clinical-core/identity-api-extension.json'));
  const input = careCodeChangeInputs(source, JSON.parse(readFileSync(resolve(upload.preparation, 'template.json'), 'utf8')),
    JSON.parse(readFileSync(resolve(upload.preparation, 'parameters.json'), 'utf8')), manifest, upload.artifact);
  const unchanged = () => {
    if (canonical(careSourceSnapshot(root, 'desktop')) !== canonical(manifest.desktop)
      || canonical(careMobileBinding(mobileRoot, root)) !== canonical(manifest.mobile)) fail('source_changed');
  };
  unchanged();
  const digest = sha256(canonical({input, desktop: manifest.desktop, mobile: manifest.mobile}));
  const name = `care-release-${digest.slice(0, 32)}`, out = resolve(dir, 'change-sets', digest);
  mkdirSync(out, {recursive: true});
  for (const [file, data] of [['template.json', input.template], ['parameters.json', input.parameters]]) {
    const bytes = JSON.stringify(data, null, 2) + '\n', path = resolve(out, file);
    try {writeFileSync(path, bytes, {flag: 'wx'});} catch {if (readFileSync(path, 'utf8') !== bytes) fail('code_change_collision');}
  }
  const created = aws(['cloudformation', 'create-change-set', '--stack-name', plan.stackId, '--change-set-name', name,
    '--change-set-type', 'UPDATE', '--client-token', digest, '--capabilities', 'CAPABILITY_IAM',
    '--description', `Fictional code-only release ${manifest.desktop.commit}; PHI off; no schema changes`,
    '--template-body', `file://${resolve(out, 'template.json').replaceAll('\\', '/')}`,
    '--parameters', `file://${resolve(out, 'parameters.json').replaceAll('\\', '/')}`]);
  if (created.StackId !== plan.stackId || !created.Id?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${name}/`)) fail('created_change_set');
  console.log(JSON.stringify({pendingChangeSetId: created.Id, deployed: false, schemaChanged: false, phiAllowed: false}));
  let set;
  for (let n = 0; n < 20; n++) {
    set = aws(['cloudformation', 'describe-change-set', '--stack-name', plan.stackId, '--change-set-name', created.Id, '--include-property-values']);
    if (set.Status !== 'CREATE_PENDING' && set.Status !== 'CREATE_IN_PROGRESS') break;
    await new Promise(done => setTimeout(done, 2000));
  }
  const raw = aws(['cloudformation', 'get-template', '--stack-name', plan.stackId, '--change-set-name', created.Id, '--template-stage', 'Original']).TemplateBody;
  verifyCareCodeChangeSet(set, typeof raw === 'string' ? JSON.parse(raw) : raw, input, {stackId: plan.stackId, name, id: created.Id});
  unchanged();
  const report = {contract: 'synthetic-care-code-change/1', observedAt: new Date().toISOString(), execution: 'synthetic-staging',
    account: P.account, region: P.region, desktop: manifest.desktop, mobile: manifest.mobile, artifact: upload.artifact,
    stackId: plan.stackId, changeSetId: created.Id, changeSetName: name, templateSha256: sha256(canonical(input.template)),
    changeSetCreated: true, verifiedChange: 'existing Lambda code only; exact S3 version; route-count annotation',
    changeSetExecutionStatus: set.ExecutionStatus, deployed: false, schemaChanged: false, rollbackRehearsed: false,
    hostedAcceptance: false, phiAllowed: false, paidMobileBuildStarted: false};
  writeFileSync(resolve(out, 'review.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({directory: out, ...report}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(error.message?.startsWith('synthetic_care_release_refused:') ? error.message
    : 'synthetic_care_release_refused:code_change_failed_or_unconfirmed'); process.exitCode = 1;});
}
