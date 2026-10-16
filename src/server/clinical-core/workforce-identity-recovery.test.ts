import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WORKFORCE_IDENTITY_RECOVERY_RELEASE, WORKFORCE_IDENTITY_RECOVERY_RELEASE_DECISIONS, replacementAssurance } from './workforce-identity-recovery';

describe('the recovery contract', () => {
  it('ships blocked and names the release decisions it waits for', () => {
    expect(WORKFORCE_IDENTITY_RECOVERY_RELEASE).toBe('blocked');
    expect(WORKFORCE_IDENTITY_RECOVERY_RELEASE_DECISIONS.join(' ')).toMatch(/verification method[\s\S]*roster[\s\S]*retention/);
  });

  it('attests an MFA-protected replacement only from the provider\'s own account record', () => {
    const subject = randomUUID();
    const user = { Enabled: true, UserStatus: 'CONFIRMED' as const, UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
      UserAttributes: [{ Name: 'sub', Value: subject }] };
    expect(replacementAssurance(user, subject)).toBe('mfa_totp_enrolled');
    for (const change of [{ Enabled: false }, { UserStatus: 'FORCE_CHANGE_PASSWORD' as const }, { UserMFASettingList: [] }, { PreferredMfaSetting: 'SMS_MFA' },
      { UserAttributes: [{ Name: 'sub', Value: randomUUID() }] }, { UserAttributes: [] }]) {
      expect(replacementAssurance({ ...user, ...change }, subject)).toBeNull();
    }
  });
});
