import { expect, it } from 'vitest';
import { fictionalMappingFailure } from './inventory-qualification-identity-mapping-cli';
import { RdsDataDatabaseError } from './rds-data-database';

it('mapping failure names its fixed stage but never serializes exception content or provider detail', () => {
  for (const error of [new TypeError('private-token-and-contact'), new Error('private-token-and-contact'),
    Object.assign(new Error('private-token-and-contact'), { name: 'private-token-and-contact', SecretString: 'private-token-and-contact' })]) {
    const result = fictionalMappingFailure(error, 'mapping', true);
    expect(result).toMatchObject({ failureStage: 'mapping', writeAdmitted: true, automaticWriteRetry: false, acceptance: false, phiAllowed: false, activation: 'blocked' });
    expect(JSON.stringify(result)).not.toContain('private-token-and-contact');
    expect(Object.keys(result)).not.toContain('message');
    expect(Object.keys(result)).not.toContain('stack');
  }
  expect(fictionalMappingFailure(new TypeError('private'), 'mapping', true).errorClass).toBe('TypeError');
});

it('known database failures retain only the bounded classification and never count as completed writes', () => {
  for (const category of ['configuration_invalid', 'transaction_failed', 'query_failed'] as const) {
    expect(fictionalMappingFailure(new RdsDataDatabaseError(category), 'mapping', true)).toMatchObject({
      category: `fictional_mapping_database_${category}`, errorClass: 'RdsDataDatabaseError',
      automaticWriteRetry: false, acceptance: false, phiAllowed: false,
    });
  }
});
