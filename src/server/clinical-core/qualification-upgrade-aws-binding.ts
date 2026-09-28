import { assertQualificationConfiguration } from './qualification-target';
import { EXPORT_RECOVERY_UPGRADE, QualificationUpgradeError, type QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
export const QUALIFICATION_UPGRADE_AWS = Object.freeze({ profile: 'ai-synthetic-staging', region: 'us-east-2', account: '588966314750', foundation: 'ai-clinical-core-qualification-foundation' });
function reject(): never { throw new QualificationUpgradeError('boundary_refused'); }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : reject();
/** Observations must come from STS and DescribeStacks in the CLI, not a caller manifest. */
export function qualificationUpgradeFromAws(callerValue: unknown, responseValue: unknown): QualificationUpgradeConfiguration {
  const { account, region, foundation } = QUALIFICATION_UPGRADE_AWS;
  if (object(callerValue).Account !== account) reject();
  const stacks = object(responseValue).Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1) reject();
  const stack = object(stacks[0]);
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(String(stack.StackStatus)) || typeof stack.StackId !== 'string'
    || !stack.StackId.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${foundation}/`)) reject();
  const values = stack.Outputs;
  if (!Array.isArray(values)) reject();
  const outputs = new Map<string, string>();
  for (const value of values) {
    const v = object(value);
    if (typeof v.OutputKey !== 'string' || typeof v.OutputValue !== 'string' || outputs.has(v.OutputKey)) reject();
    outputs.set(v.OutputKey, v.OutputValue);
  }
  if (outputs.get('PhiAllowed') !== 'false' || outputs.get('Activation') !== 'blocked' || outputs.get('QualificationExecution') !== 'disabled'
    || outputs.get('DatabaseName') !== 'clinical_core_qualification') reject();
  const result: QualificationUpgradeConfiguration = { clusterArn: outputs.get('DatabaseClusterArn') ?? '', secretArn: outputs.get('DatabaseSecretArn') ?? '',
    qualificationDatabaseName: outputs.get('DatabaseName') ?? '', stagingDatabaseName: 'clinical_core', expectedAccountId: account, region,
    phiAllowed: false, activation: 'blocked', fromReleaseSha256: EXPORT_RECOVERY_UPGRADE.from, toReleaseSha256: EXPORT_RECOVERY_UPGRADE.to };
  try { assertQualificationConfiguration(result, region); } catch { reject(); }
  return result;
}
