import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Exercise the shipped entry point, not only its shared validation helper.
// No inherited AWS profile, token, secret or user configuration is passed to it.
const fixtureEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  PHI_ALLOWED: 'false', CONFIRM_QUALIFICATION_TARGET: 'true',
  AWS_REGION: 'us-east-2', AWS_EC2_METADATA_DISABLED: 'true',
  EXPECTED_AWS_ACCOUNT_ID: '588966314750',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  QUALIFICATION_DATABASE_NAME: 'clinical_core_qualification', STAGING_DATABASE_NAME: 'clinical_core',
};

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-aws-qualification-target-operator.mjs'], { timeout: 30000, stdio: 'pipe' });
}, 40000);

describe('qualification fixture operator direct invocation', () => {
  it('pins both STS and RDS credentials to the synthetic member profile', () => {
    const source = readFileSync('src/server/clinical-core/qualification-target-operator.ts', 'utf8');
    expect(source).toContain('const profile = "ai-synthetic-member"');
    expect(source).toContain('assertQualificationOperatorIdentity(identity, configuration.expectedAccountId)');
    expect(source).toContain('credentials: fromIni({ profile })');
  });
  for (const [name, override, refusal] of [
    ['PHI enabled', { PHI_ALLOWED: 'true' }, 'activation_boundary_refused'],
    ['unconfirmed write', { CONFIRM_QUALIFICATION_TARGET: 'false' }, 'activation_boundary_refused'],
    ['staging database', { QUALIFICATION_DATABASE_NAME: 'clinical_core' }, 'qualification_name_refused'],
    ['foreign secret account', { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional' }, 'account_boundary_refused'],
    ['foreign secret region', { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:588966314750:secret:fictional' }, 'configuration_refused'],
    ['foreign client region', { AWS_REGION: 'us-west-2' }, 'configuration_refused'],
  ] as const) {
    it(`refuses ${name} before loading a manifest or accessing AWS`, () => {
      const result = spawnSync(process.execPath, ['dist/aws-clinical-core/qualification-target-operator/index.cjs', 'fixtures'], {
        env: { ...fixtureEnvironment, ...override }, encoding: 'utf8', timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr.trim()).toBe(refusal);
    });
  }
});
