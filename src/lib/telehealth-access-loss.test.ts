import { describe, expect, it } from 'vitest';
import { AdapterError } from '@/adapters/errors';
import { telehealthAccessLost } from './telehealth-access-loss';

describe('telehealth opened-data authorization loss', () => {
  it.each(['unauthenticated', 'forbidden', 'not_found'] as const)('drops opened data for %s', code => {
    expect(telehealthAccessLost(new AdapterError(code))).toBe(true);
  });
  it.each(['invalid', 'conflict', 'unavailable', 'unknown'] as const)('does not interpret %s as a new permission', code => {
    expect(telehealthAccessLost(new AdapterError(code))).toBe(false);
  });
  it('does not trust a server or SDK error object claiming an adapter code', () => {
    expect(telehealthAccessLost({ code: 'forbidden' })).toBe(false);
  });
});
