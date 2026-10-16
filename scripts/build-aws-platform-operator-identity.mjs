// Separate fictional operator login. Building this artifact never creates a pool, user or clinical authority.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPERATOR_ACCOUNT = '588966314750';
export const OPERATOR_REGION = 'us-east-2';
const root = fileURLToPath(new URL('../', import.meta.url));
const ref = name => ({ Ref: name });
const getAtt = (name, attribute) => ({ 'Fn::GetAtt': [name, attribute] });
const sha = value => createHash('sha256').update(value).digest('hex');

export function buildPlatformOperatorIdentity(...options) {
  if (options.length) throw Error('platform_operator_identity_build_options_refused');
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Fictional qualification operator identity only; no users, API, registry, PHI or activation.',
    Metadata: { PlatformOperatorIdentity: {
      Contract: 'platform-operator-identity/1', Account: OPERATOR_ACCOUNT, Region: OPERATOR_REGION,
      ContainsPhi: false, Activation: 'blocked', Execution: 'configuration_only',
      UsersCreated: false, OperatorRegistered: false, ClinicalAccessGranted: false,
      ProductionEligible: false,
    } },
    Parameters: {
      SourceCommit: { Type: 'String', AllowedPattern: '^[a-f0-9]{40}$' },
      TemplateSha256: { Type: 'String', AllowedPattern: '^[a-f0-9]{64}$' },
    },
    Conditions: { SyntheticAccountAndRegion: { 'Fn::And': [
      { 'Fn::Equals': [ref('AWS::AccountId'), OPERATOR_ACCOUNT] },
      { 'Fn::Equals': [ref('AWS::Region'), OPERATOR_REGION] },
    ] } },
    Resources: {
      OperatorPool: {
        Type: 'AWS::Cognito::UserPool', Condition: 'SyntheticAccountAndRegion',
        DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
        Properties: {
          UserPoolName: 'alp-platform-operator-qualification', UserPoolTier: 'ESSENTIALS',
          DeletionProtection: 'ACTIVE', UsernameAttributes: ['email'],
          UsernameConfiguration: { CaseSensitive: false }, AutoVerifiedAttributes: ['email'],
          AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
          AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
          MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
          Policies: {
            PasswordPolicy: { MinimumLength: 14, RequireLowercase: true, RequireUppercase: true,
              RequireNumbers: true, RequireSymbols: true, TemporaryPasswordValidityDays: 1 },
            SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] },
          },
          UserPoolTags: { Environment: 'synthetic-staging', DataClassification: 'synthetic_only',
            ContainsPhi: 'false', Purpose: 'separate-platform-operator-identity' },
        },
      },
      OperatorClient: {
        Type: 'AWS::Cognito::UserPoolClient', Condition: 'SyntheticAccountAndRegion',
        DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
        Properties: {
          UserPoolId: ref('OperatorPool'), ClientName: 'alp-platform-operator-qualification-server',
          GenerateSecret: false, PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true,
          AccessTokenValidity: 15, IdTokenValidity: 15, RefreshTokenValidity: 1,
          TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
          ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH'],
          ReadAttributes: ['email', 'email_verified'], WriteAttributes: ['email'],
          SupportedIdentityProviders: ['COGNITO'], AllowedOAuthFlowsUserPoolClient: false,
          EnablePropagateAdditionalUserContextData: false,
        },
      },
    },
    Outputs: {
      OperatorPoolId: { Value: ref('OperatorPool'), Condition: 'SyntheticAccountAndRegion' },
      OperatorPoolArn: { Value: getAtt('OperatorPool', 'Arn'), Condition: 'SyntheticAccountAndRegion' },
      OperatorClientId: { Value: ref('OperatorClient'), Condition: 'SyntheticAccountAndRegion' },
      SourceCommit: { Value: ref('SourceCommit'), Condition: 'SyntheticAccountAndRegion' },
      TemplateSha256: { Value: ref('TemplateSha256'), Condition: 'SyntheticAccountAndRegion' },
      PhiAllowed: { Value: 'false', Condition: 'SyntheticAccountAndRegion' },
      Activation: { Value: 'blocked', Condition: 'SyntheticAccountAndRegion' },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('platform_operator_identity_build_argument_refused');
  const git = args => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000,
    windowsHide: true })).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('platform_operator_identity_clean_source_required');
  const template = JSON.stringify(buildPlatformOperatorIdentity(), null, 2) + '\n';
  const directory = resolve(root, 'dist/aws-clinical-core/platform-operator-identity');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'template.json'), template);
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({
    contract: 'platform-operator-identity-build/1', sourceCommit, account: OPERATOR_ACCOUNT,
    region: OPERATOR_REGION, templateSha256: sha(template), resources: 2,
    deployed: false, usersCreated: false, operatorRegistered: false,
    clinicalAccessGranted: false, phiAllowed: false, activation: 'blocked', acceptance: false,
  }, null, 2) + '\n');
  if (git(['rev-parse', 'HEAD']) !== sourceCommit || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('platform_operator_identity_source_changed');
  console.log('Built blocked fictional operator identity candidate; no AWS call or account creation.');
}
