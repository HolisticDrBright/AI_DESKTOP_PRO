import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { careConnectionRequest, parseCareConnectionResponse, type CareConnectionRequest } from './careConnections';
const id = randomUUID(), artifactId = randomUUID();
const request: CareConnectionRequest = { action: 'grant', connectionId: id, scope: 'messaging', artifactId,
  contentSha256: 'a'.repeat(64), expectedVersion: 2 };
const result = { connectionId: id, scope: 'messaging', status: 'granted', version: 3, alreadyApplied: false };
describe('connection consent response correlation', () => {
  it('accepts only the exact successor or an already-applied version in the admitted interval', () => {
    expect(parseCareConnectionResponse(request, result)).toEqual(result);
    for (const version of [2, 3]) expect(parseCareConnectionResponse(request, { ...result, version, alreadyApplied: true })).toMatchObject({ version });
  });
  it.each([{ connectionId: randomUUID() }, { scope: 'wearables' }, { status: 'revoked' }, { version: 1 },
    { version: 4 }, { version: 2 }, { extra: true }])('rejects a mismatched result %j', changed => {
    expect(() => parseCareConnectionResponse(request, { ...result, ...changed })).toThrow();
  });
  it('does not mistake a zero-version no-op for a recorded withdrawal', () => {
    const withdrawal: CareConnectionRequest = { action: 'withdraw', connectionId: id, scope: 'messaging', expectedVersion: 0 };
    const noOp = { ...result, status: 'not_granted', version: 0, alreadyApplied: true };
    expect(parseCareConnectionResponse(withdrawal, noOp)).toEqual(noOp);
    expect(() => parseCareConnectionResponse(withdrawal, { ...noOp, alreadyApplied: false })).toThrow();
    expect(() => parseCareConnectionResponse(withdrawal, { ...noOp, version: 1 })).toThrow();
    expect(() => parseCareConnectionResponse({ ...withdrawal, expectedVersion: 1 }, { ...noOp, version: 1 })).toThrow();
  });
  it('normalizes a displayed code while refusing legacy, ambiguous or overlong codes', () => {
    expect(careConnectionRequest.parse({ action: 'claim', token: 'abcd-efgh-jklmn' })).toEqual({ action: 'claim', token: 'ABCDEFGHJKLMN' });
    for (const token of ['ABCDEFGHIJKLM', 'ABCDEFGHIJ', 'A'.repeat(25), 'ABCDEFGHJKLM0'])
      expect(careConnectionRequest.safeParse({ action: 'claim', token }).success).toBe(false);
  });
});
