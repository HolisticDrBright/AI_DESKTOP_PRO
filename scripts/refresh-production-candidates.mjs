// Refresh existing private readiness services without deleting the running service.
// No credentials, clinical records, PHI activation, or public ingress are introduced.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectStack(stack) {
  const outputs = Object.fromEntries(stack.Outputs.map(x => [x.OutputKey, x.OutputValue]));
  const parameters = Object.fromEntries(stack.Parameters.map(x => [x.ParameterKey, x.ParameterValue]));
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus)) throw Error('Stack is not stable');
  if (outputs.PhiAllowed !== 'false' || outputs.WorkloadMode !== 'readiness_only' || parameters.DeployService !== 'true') throw Error('Only an existing PHI-disabled readiness service can be refreshed');
  for (const key of ['ImageTag', 'SourceVersion']) if (!/^[a-f0-9]{40}$/.test(parameters[key] ?? '')) throw Error(`Invalid ${key}`);
  return { outputs, parameters };
}

export function replacementParameters(stack, source) {
  inspectStack(stack);
  if (!/^[a-f0-9]{40}$/.test(source)) throw Error('Full source SHA required');
  return stack.Parameters.map(x => ['SourceVersion', 'ImageTag'].includes(x.ParameterKey)
    ? { ParameterKey: x.ParameterKey, ParameterValue: source }
    : { ParameterKey: x.ParameterKey, UsePreviousValue: true });
}

export function candidateBuildspec(spec, parameters, source) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw Error('Full source SHA required');
  let result = spec.replaceAll(parameters.SourceVersion, source).replaceAll(parameters.ImageTag, source);
  if (!result.includes(source) || !result.includes('PHI_ALLOWED=false') || !result.includes('production_not_activated') || !result.includes('Dockerfile.production')) throw Error('Required build/refusal checks absent');
  // CodeBuild runs post_build even when the build phase fails.
  result = result.replace(/^(\s*)- docker push /m, '$1- test "$CODEBUILD_BUILD_SUCCEEDING" = 1\n$1- docker push ');
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const desktop = resolve(option('--desktop') ?? '.');
  const v2 = option('--v2');
  if (!v2) throw Error('--v2 repository path is required');
  const execute = args.includes('--execute');
  const reportDir = resolve(option('--report-dir') ?? 'dist/commercial-release');
  const profile = option('--profile') ?? 'ai-production';
  const sourceRef = option('--ref') ?? 'main';
  const region = 'us-east-2';
  const run = (program, command, cwd) => execFileSync(program, command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
  const aws = command => JSON.parse(run('aws', [...command, '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager']));
  const pause = () => new Promise(r => setTimeout(r, 15000));
  run('git', ['check-ref-format', '--branch', sourceRef], desktop);
  const report = { schema: 'commercial-candidate-refresh/1', startedAt: new Date().toISOString(), account: '173535830222', phiAllowed: false, commercialReady: false, sourceRef, execute, candidates: [] };
  const save = () => { mkdirSync(reportDir, { recursive: true }); writeFileSync(join(reportDir, 'candidate-refresh.json'), JSON.stringify(report, null, 2) + '\n'); };
  if (aws(['sts', 'get-caller-identity']).Account !== report.account) throw Error('Wrong AWS account');
  const foundation = aws(['cloudformation', 'describe-stacks', '--stack-name', 'ai-longevity-production-clinical-foundation']).Stacks[0];
  const foundationOutputs = Object.fromEntries(foundation.Outputs.map(x => [x.OutputKey, x.OutputValue]));
  if (foundationOutputs.PhiAllowed !== 'false' || foundationOutputs.Environment !== 'production-clinical') throw Error('Foundation must remain PHI-disabled');

  // Resolve both complete inputs before any cloud mutation.
  for (const [name, repo] of [['ai-desktop-pro-production-readiness', desktop], ['ai-longevity-pro-v2-production-readiness', resolve(v2)]]) {
    const source = run('git', ['rev-parse', 'HEAD'], repo);
    const remote = run('git', ['ls-remote', 'origin', `refs/heads/${sourceRef}`], repo).split(/\s/)[0];
    if (source !== remote) throw Error(`${name}: local HEAD must match the published source ref`);
    const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', name]).Stacks[0];
    const { parameters, outputs } = inspectStack(stack);
    const project = aws(['codebuild', 'batch-get-projects', '--names', outputs.BuildProjectName]).projects[0];
    if (project.source.type !== 'NO_SOURCE') throw Error('Unexpected build source');
    const repositoryUri = outputs.ImageReference.slice(0, outputs.ImageReference.lastIndexOf(':'));
    const repository = repositoryUri.split('/').at(-1);
    const registry = aws(['ecr', 'describe-repositories', '--repository-names', repository]).repositories[0];
    if (registry.imageTagMutability !== 'IMMUTABLE') throw Error('Immutable ECR tags required');
    report.candidates.push({ name, repo, source, previousSource: parameters.SourceVersion, previousImage: parameters.ImageTag, repository, status: 'planned', stackId: stack.StackId });
    const candidate = report.candidates.at(-1);
    candidate.buildspec = candidateBuildspec(project.source.buildspec, parameters, source);
    candidate.parameters = replacementParameters(stack, source);
    candidate.archiveBucket = outputs.SourceArchiveBucketName;
    candidate.project = outputs.BuildProjectName;
    candidate.cluster = parameters.EcsClusterArn;
  }
  save();
  console.log(JSON.stringify({ execute, phiAllowed: false, candidates: report.candidates.map(({ name, source, previousSource }) => ({ name, source, previousSource })) }));
  if (!execute) return;
  try {
    for (const c of report.candidates) {
      // A successful immutable image can be reused after an interrupted run.
      const images = aws(['ecr', 'list-images', '--repository-name', c.repository]).imageIds;
      if (!images.some(x => x.imageTag === c.source)) {
        if (c.archiveBucket) {
          const archive = join(reportDir, `${c.source}.zip`);
          run('git', ['archive', '--format=zip', `--output=${archive}`, c.source], c.repo);
          run('aws', ['s3', 'cp', archive, `s3://${c.archiveBucket}/source/${c.source}.zip`, '--sse', 'aws:kms', '--sse-kms-key-id', foundationOutputs.ClinicalCoreKeyArn, '--only-show-errors', '--profile', profile, '--region', region]);
        }
        c.buildId = aws(['codebuild', 'start-build', '--project-name', c.project, '--buildspec-override', c.buildspec]).build.id;
        c.status = 'building'; save(); console.log(`${c.name}: building ${c.source}, existing service retained`);
        const deadline = Date.now() + 70 * 60 * 1000;
        while (true) {
          const build = aws(['codebuild', 'batch-get-builds', '--ids', c.buildId]).builds[0];
          if (build.buildStatus === 'SUCCEEDED') { c.buildStatus = build.buildStatus; break; }
          if (!['IN_PROGRESS', 'QUEUED'].includes(build.buildStatus) || Date.now() > deadline) throw Error(`${c.name}: build ${build.buildStatus}; service unchanged`);
          await pause();
        }
      }
      c.status = 'scanning'; save();
      const deadline = Date.now() + 15 * 60 * 1000;
      while (true) {
        const scan = aws(['ecr', 'describe-image-scan-findings', '--repository-name', c.repository, '--image-id', `imageTag=${c.source}`]);
        if (scan.imageScanStatus.status === 'COMPLETE') {
          const counts = scan.imageScanFindings.findingSeverityCounts ?? {};
          if ((counts.CRITICAL ?? 0) || (counts.HIGH ?? 0)) throw Error(`${c.name}: image has Critical/High findings; service unchanged`);
          c.imageDigest = scan.imageId.imageDigest;
          c.scan = { status: 'COMPLETE', counts }; break;
        }
        if (!['PENDING', 'IN_PROGRESS'].includes(scan.imageScanStatus.status) || Date.now() > deadline) throw Error(`${c.name}: scan not complete; service unchanged`);
        await pause();
      }
      // Re-read state to refuse concurrent changes before updating.
      const before = aws(['cloudformation', 'describe-stacks', '--stack-name', c.name]).Stacks[0];
      const { parameters } = inspectStack(before);
      if (parameters.ImageTag !== c.previousImage || parameters.SourceVersion !== c.previousSource) throw Error(`${c.name}: stack changed since preflight`);
      if (parameters.ImageTag !== c.source || parameters.SourceVersion !== c.source) {
        aws(['cloudformation', 'update-stack', '--stack-name', c.name, '--use-previous-template', '--capabilities', 'CAPABILITY_NAMED_IAM', '--parameters', JSON.stringify(c.parameters)]);
        c.status = 'deploying'; save(); console.log(`${c.name}: clean image verified; rolling replacement started`);
        const deadline = Date.now() + 35 * 60 * 1000;
        while (true) {
          const state = aws(['cloudformation', 'describe-stacks', '--stack-name', c.name]).Stacks[0];
          if (state.StackStatus === 'UPDATE_COMPLETE') break;
          if (!['UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'].includes(state.StackStatus) || Date.now() > deadline) throw Error(`${c.name}: deployment ${state.StackStatus}`);
          await pause();
        }
      }
      const live = aws(['cloudformation', 'describe-stacks', '--stack-name', c.name]).Stacks[0];
      if (inspectStack(live).parameters.ImageTag !== c.source) throw Error('Deployed source mismatch');
      const service = aws(['ecs', 'describe-services', '--cluster', c.cluster, '--services', c.name]).services[0];
      const taskArns = aws(['ecs', 'list-tasks', '--cluster', c.cluster, '--service-name', c.name]).taskArns;
      const tasks = aws(['ecs', 'describe-tasks', '--cluster', c.cluster, '--tasks', ...taskArns]).tasks;
      if (service.runningCount !== 1 || service.pendingCount !== 0 || tasks.length !== 1 || tasks[0].healthStatus !== 'HEALTHY' || tasks[0].containers[0].imageDigest !== c.imageDigest) throw Error(`${c.name}: running task digest/health mismatch`);
      c.status = 'verified'; c.taskHealth = tasks[0].healthStatus; c.finishedAt = new Date().toISOString();
      delete c.buildspec; delete c.parameters; save(); console.log(`${c.name}: exact image RUNNING/HEALTHY; PHI remains disabled`);
    }
    report.finishedAt = new Date().toISOString(); save();
  } catch (error) { report.error = error.message; save(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
