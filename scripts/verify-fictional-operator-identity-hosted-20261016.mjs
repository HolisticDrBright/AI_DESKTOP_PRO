/** Read-only post-deployment check for the exact fictional operator-login stack. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const account = '588966314750';
const region = 'us-east-2';
const profile = 'ai-synthetic-member';
const stackName = 'alp-platform-operator-identity-qualification';
const changeSetArn = 'arn:aws:cloudformation:us-east-2:588966314750:changeSet/prepare-operator-identity-286ebc87-20261016/127313f0-94c7-46b1-8d4a-a29ebbdb58ef';
const refuse = reason => { throw new Error(`fictional_operator_identity_refused:${reason}`); };

export function assessOperatorIdentity({ caller, stack, changeSet, resources, pool, mfa, client, users }) {
  if (caller?.Account !== account ||
      !caller.Arn?.startsWith(`arn:aws:sts::${account}:assumed-role/`)) refuse('account');
  if (stack?.StackName !== stackName || stack.StackStatus !== 'CREATE_COMPLETE' ||
      changeSet?.ChangeSetId !== changeSetArn || changeSet.ExecutionStatus !== 'EXECUTE_COMPLETE') {
    refuse('stack_or_change_set');
  }
  const entries = resources?.StackResources;
  if (!Array.isArray(entries) || entries.length !== 2 ||
      entries.some(row => row.ResourceStatus !== 'CREATE_COMPLETE') ||
      !entries.some(row => row.LogicalResourceId === 'OperatorPool' &&
        row.ResourceType === 'AWS::Cognito::UserPool' && row.PhysicalResourceId === pool?.Id) ||
      !entries.some(row => row.LogicalResourceId === 'OperatorClient' &&
        row.ResourceType === 'AWS::Cognito::UserPoolClient' && row.PhysicalResourceId === client?.ClientId)) {
    refuse('resources');
  }
  if (pool?.Name !== 'alp-platform-operator-qualification' ||
      pool.MfaConfiguration !== 'ON' ||
      mfa?.MfaConfiguration !== 'ON' ||
      mfa.SoftwareTokenMfaConfiguration?.Enabled !== true ||
      mfa.SmsMfaConfiguration?.Enabled === true ||
      mfa.EmailMfaConfiguration?.Enabled === true ||
      (Array.isArray(pool.EnabledMfas) &&
        pool.EnabledMfas.some(factor => factor !== 'SOFTWARE_TOKEN_MFA')) ||
      pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true ||
      pool.DeletionProtection !== 'ACTIVE' ||
      pool.UserPoolTier !== 'ESSENTIALS') refuse('pool_posture');
  if (client?.ClientName !== 'alp-platform-operator-qualification-server' ||
      client.UserPoolId !== pool.Id || client.ClientSecret ||
      JSON.stringify(client.ExplicitAuthFlows) !== JSON.stringify(['ALLOW_USER_PASSWORD_AUTH'])) {
    refuse('client_posture');
  }
  if (!Array.isArray(users?.Users) || users.Users.length !== 0) refuse('users_present');
  return {
    contract: 'fictional-operator-identity-hosted/1',
    account, region, stackName,
    poolCreated: true, clientCreated: true, mfaTotpRequired: true,
    selfSignupDisabled: true, usersCreated: false,
    clinicAccessVerified: false, phiAllowed: false,
    verdict: 'configuration_only_not_operator_sign_in_or_clinical_authority',
  };
}

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--fictional-read-only') refuse('command');
  const caller = aws('sts', 'get-caller-identity');
  if (caller.Account !== account || !caller.Arn?.startsWith(`arn:aws:sts::${account}:assumed-role/`)) {
    refuse('account');
  }
  const stack = aws('cloudformation', 'describe-stacks', '--stack-name', stackName).Stacks?.[0];
  const changeSet = aws('cloudformation', 'describe-change-set',
    '--change-set-name', changeSetArn, '--stack-name', stackName);
  const resources = aws('cloudformation', 'describe-stack-resources', '--stack-name', stackName);
  const poolId = resources.StackResources?.find(row => row.LogicalResourceId === 'OperatorPool')?.PhysicalResourceId;
  const clientId = resources.StackResources?.find(row => row.LogicalResourceId === 'OperatorClient')?.PhysicalResourceId;
  if (!poolId || !clientId) refuse('resources');
  const pool = aws('cognito-idp', 'describe-user-pool', '--user-pool-id', poolId).UserPool;
  // DescribeUserPool can omit EnabledMfas; GetUserPoolMfaConfig is the authority for enabled factors.
  const mfa = aws('cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', poolId);
  const client = aws('cognito-idp', 'describe-user-pool-client',
    '--user-pool-id', poolId, '--client-id', clientId).UserPoolClient;
  const users = aws('cognito-idp', 'list-users', '--user-pool-id', poolId, '--limit', '1');
  console.log(JSON.stringify(assessOperatorIdentity({
    caller, stack, changeSet, resources, pool, mfa, client, users,
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    const message = String(error?.message ?? '');
    console.error(/^fictional_operator_identity_refused:[a-z_]+$/.test(message)
      ? message : 'fictional_operator_identity_refused:aws_read_failed');
    process.exitCode = 1;
  }
}
