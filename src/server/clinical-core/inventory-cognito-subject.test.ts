import { expect, it } from 'vitest';
import { isInventoryCognitoSubject } from './inventory-cognito-subject';

it('accepts opaque Cognito subjects without UUID version/variant assumptions or case normalization', () => {
  for (const value of ['22222222-2222-7222-e222-222222222222', 'Opaque_Consumer_Subject_02',
    'issuer:opaque-subject-0001', '12345678', 'A'.repeat(128)]) expect(isInventoryCognitoSubject(value)).toBe(true);
});
it('refuses unsafe transport delimiters, option prefixes, control characters and unbounded values', () => {
  for (const value of [null, 123, {}, '', '1234567', 'A'.repeat(129), '--profile=production',
    'email@example.test', 'fixture,other-owner', 'sub/../../path', "subject';drop table", 'sub\\path',
    ' subject-001', 'subject-001 ', 'subject\n001', 'subject\u0000x', 'subject\u007fx', 'subject-𝟙']) {
    expect(isInventoryCognitoSubject(value)).toBe(false);
  }
});
