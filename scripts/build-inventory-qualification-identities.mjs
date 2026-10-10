// New private fixture pools only. Never edits or imports shared staging pools,
// provisions users, authorizes an API, seeds reviews, or enables production.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const IDENTITY_ACCOUNT = '588966314750', IDENTITY_REGION = 'us-east-2';
const root = fileURLToPath(new URL('../', import.meta.url));
const ref = name => ({ Ref: name });
const sub = value => ({ 'Fn::Sub': value });
const out = Value => ({ Value, Condition: 'SyntheticAccountAndRegion' });
const sha = value => createHash('sha256').update(value).digest('hex');
export function buildInventoryQualificationIdentities(...options) {
  if (options.length) throw Error('inventory_identity_build_options_refused');
  const Resources = {}, Outputs = {};
  for (const role of ['Consumer', 'Workforce']) {
    const workforce = role === 'Workforce', pool = `${role}Pool`, client = `${role}Client`;
    Resources[pool] = { Type: 'AWS::Cognito::UserPool', Condition: 'SyntheticAccountAndRegion',
      DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
        UserPoolName: `alp-inventory-qualification-${role.toLowerCase()}`,
        UserPoolTier: 'ESSENTIALS', DeletionProtection: 'ACTIVE',
        UsernameAttributes: ['email'], UsernameConfiguration: { CaseSensitive: false }, AutoVerifiedAttributes: ['email'],
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
        MfaConfiguration: workforce ? 'ON' : 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        Policies: { PasswordPolicy: { MinimumLength: workforce ? 14 : 12, RequireLowercase: true,
          RequireUppercase: true, RequireNumbers: true, RequireSymbols: true, TemporaryPasswordValidityDays: 1 },
          SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } },
        Schema: [['person_id', '36'], ['organization_id', '36'], ['synthetic_attested', '4'], ['production_bound', '4']]
          .map(([Name, length]) => ({ Name, AttributeDataType: 'String', Mutable: false, Required: false,
            DeveloperOnlyAttribute: false, StringAttributeConstraints: { MinLength: length, MaxLength: length } })),
        UserPoolTags: { Environment: 'synthetic-staging', DataClassification: 'synthetic_only', ContainsPhi: 'false',
          Purpose: 'isolated-inventory-qualification-identities' },
      } };
    Resources[client] = { Type: 'AWS::Cognito::UserPoolClient', Condition: 'SyntheticAccountAndRegion',
      DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
        UserPoolId: ref(pool), ClientName: `alp-inventory-qualification-${role.toLowerCase()}-public`, GenerateSecret: false,
        PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true, AccessTokenValidity: 15, IdTokenValidity: 15,
        RefreshTokenValidity: 12, TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'hours' },
        ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
        ReadAttributes: ['email', 'email_verified', 'custom:person_id', 'custom:organization_id', 'custom:synthetic_attested', 'custom:production_bound'],
        WriteAttributes: ['email'], SupportedIdentityProviders: ['COGNITO'], AllowedOAuthFlowsUserPoolClient: false,
        EnablePropagateAdditionalUserContextData: false,
      } };
    Outputs[`${role}PoolId`] = out(ref(pool));
    Outputs[`${role}Issuer`] = out(sub(`https://cognito-idp.\${AWS::Region}.amazonaws.com/\${${pool}}`));
    Outputs[`${role}Audience`] = out(ref(client));
  }
  return { AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Private fictional qualification identities only; no users, clinical routes, production activation or PHI.',
    Metadata: { QualificationIdentity: { Contract: 'inventory-qualification-identities/1', ContainsPhi: false,
      Activation: 'blocked', Execution: 'configuration_only', AccountsCreated: false, PhysicalLoginVerified: false,
      DatabaseAuthorityVerified: false, Acceptance: false, ExistingPoolsModified: false,
      Signup: 'administrator-only fictional fixtures; not the public Core registration plane' } },
    Parameters: { SourceCommit: { Type: 'String', AllowedPattern: '^[a-f0-9]{40}$' },
      TemplateSha256: { Type: 'String', AllowedPattern: '^[a-f0-9]{64}$' } },
    Conditions: { SyntheticAccountAndRegion: { 'Fn::And': [
      { 'Fn::Equals': [ref('AWS::AccountId'), IDENTITY_ACCOUNT] }, { 'Fn::Equals': [ref('AWS::Region'), IDENTITY_REGION] },
    ] } }, Resources, Outputs: { ...Outputs, SourceCommit: out(ref('SourceCommit')), TemplateSha256: out(ref('TemplateSha256')),
      PhiAllowed: out('false'), Activation: out('blocked'), Execution: out('configuration_only') } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('inventory_identity_build_argument_refused');
  const git = args => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true })).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('inventory_identity_clean_source_required');
  const template = JSON.stringify(buildInventoryQualificationIdentities(), null, 2) + '\n';
  const directory = resolve(root, 'dist/aws-clinical-core/inventory-qualification-identities');
  mkdirSync(directory, { recursive: true }); writeFileSync(resolve(directory, 'template.json'), template);
  await build({ absWorkingDir: root, entryPoints: ['src/server/clinical-core/inventory-qualification-identity-configuration-cli.ts'],
    outfile: resolve(directory, 'observe-configuration.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    minify: true, legalComments: 'none' });
  await build({ absWorkingDir: root, entryPoints: ['src/server/clinical-core/inventory-qualification-fixtures-cli.ts'],
    outfile: resolve(directory, 'provision-fictional-fixtures.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    minify: true, legalComments: 'none' });
  await build({ absWorkingDir: root, entryPoints: ['src/server/clinical-core/inventory-fixture-authentication-cli.ts'],
    outfile: resolve(directory, 'authenticate-fictional-fixtures.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    minify: true, legalComments: 'none' });
  if (git(['rev-parse', 'HEAD']) !== sourceCommit || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('inventory_identity_source_changed');
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({ contract: 'inventory-qualification-identities-build/1',
    sourceCommit, templateSha256: sha(template), configurationObserverSha256: sha(readFileSync(resolve(directory, 'observe-configuration.cjs'))),
    fixtureProvisionerSha256: sha(readFileSync(resolve(directory, 'provision-fictional-fixtures.cjs'))),
    fixtureAuthenticatorSha256: sha(readFileSync(resolve(directory, 'authenticate-fictional-fixtures.cjs'))),
    account: IDENTITY_ACCOUNT, region: IDENTITY_REGION,
    resources: 4, accountsCreated: false, deployed: false, physicalLoginVerified: false, databaseAuthorityVerified: false,
    acceptance: false, activation: 'blocked', phiAllowed: false }, null, 2) + '\n');
  console.log('Built isolated identity configuration from clean source; no AWS call, user creation, activation or login evidence.');
}
