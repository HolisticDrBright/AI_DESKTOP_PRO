import { execFileSync } from 'node:child_process';

export const SYNTHETIC_ACCOUNT = '588966314750';
export const SYNTHETIC_REGION = 'us-east-2';
export const SYNTHETIC_MEMBER_PROFILE = 'ai-synthetic-member';

export function assertSyntheticMemberIdentity(identity) {
  if (identity?.Account !== SYNTHETIC_ACCOUNT || typeof identity.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(identity.Arn)) {
    throw new Error('synthetic_member_principal_refused');
  }
}

export function observeSyntheticMemberIdentity(run = execFileSync) {
  let identity;
  try {
    identity = JSON.parse(run('aws', ['sts', 'get-caller-identity', '--profile', SYNTHETIC_MEMBER_PROFILE,
      '--region', SYNTHETIC_REGION, '--output', 'json'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  } catch {
    throw new Error('synthetic_member_principal_refused');
  }
  assertSyntheticMemberIdentity(identity);
  return identity;
}
