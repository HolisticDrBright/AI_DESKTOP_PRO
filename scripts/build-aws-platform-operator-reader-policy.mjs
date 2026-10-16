// Unattached, exact-pool Cognito read policy for a future reviewed fictional operator API host.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ref = name => ({ Ref: name });
const sha = value => createHash('sha256').update(value).digest('hex');
export const EXACT_OPERATOR_POOL_ARN = '^arn:aws:cognito-idp:us-east-2:588966314750:userpool/us-east-2_[A-Za-z0-9]{9}$';

export function buildPlatformOperatorReaderPolicy(...options) {
  if (options.length) throw Error('platform_operator_reader_build_options_refused');
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Unattached Cognito read policy for fictional qualification operator pool only.',
    Metadata: { PlatformOperatorReader: { Contract: 'platform-operator-reader/1',
      Account: '588966314750', Region: 'us-east-2', Activation: 'blocked', ContainsPhi: false,
      Attached: false, OperatorApiDeployed: false, Acceptance: false } },
    Parameters: {
      OperatorPoolArn: { Type: 'String', AllowedPattern: EXACT_OPERATOR_POOL_ARN },
      SourceCommit: { Type: 'String', AllowedPattern: '^[a-f0-9]{40}$' },
      TemplateSha256: { Type: 'String', AllowedPattern: '^[a-f0-9]{64}$' },
    },
    Conditions: { SyntheticAccountAndRegion: { 'Fn::And': [
      { 'Fn::Equals': [ref('AWS::AccountId'), '588966314750'] },
      { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] },
    ] } },
    Resources: {
      OperatorPoolReader: { Type: 'AWS::IAM::ManagedPolicy', Condition: 'SyntheticAccountAndRegion',
        DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
          Description: 'Read only the exact fictional operator Cognito pool; no attachment is created.',
          PolicyDocument: { Version: '2012-10-17', Statement: [{
            Sid: 'ReadCurrentOperatorPoolAndUser', Effect: 'Allow',
            Action: ['cognito-idp:DescribeUserPool', 'cognito-idp:AdminGetUser'],
            Resource: ref('OperatorPoolArn'),
          }] },
        } },
    },
    Outputs: {
      ReaderPolicyArn: { Value: ref('OperatorPoolReader'), Condition: 'SyntheticAccountAndRegion' },
      SourceCommit: { Value: ref('SourceCommit'), Condition: 'SyntheticAccountAndRegion' },
      TemplateSha256: { Value: ref('TemplateSha256'), Condition: 'SyntheticAccountAndRegion' },
      Attached: { Value: 'false', Condition: 'SyntheticAccountAndRegion' },
      PhiAllowed: { Value: 'false', Condition: 'SyntheticAccountAndRegion' },
      Activation: { Value: 'blocked', Condition: 'SyntheticAccountAndRegion' },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('platform_operator_reader_build_argument_refused');
  const git = args => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000,
    windowsHide: true })).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('platform_operator_reader_clean_source_required');
  const template = JSON.stringify(buildPlatformOperatorReaderPolicy(), null, 2) + '\n';
  const directory = resolve(root, 'dist/aws-clinical-core/platform-operator-reader-policy');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'template.json'), template);
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({
    contract: 'platform-operator-reader-build/1', sourceCommit, account: '588966314750', region: 'us-east-2',
    templateSha256: sha(template), resources: 1, attached: false, deployed: false,
    operatorApiDeployed: false, phiAllowed: false, activation: 'blocked', acceptance: false,
  }, null, 2) + '\n');
  if (git(['rev-parse', 'HEAD']) !== sourceCommit || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('platform_operator_reader_source_changed');
  console.log('Built unattached fictional operator-pool reader policy; no AWS call or grant.');
}
