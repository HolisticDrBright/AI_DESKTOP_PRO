import { describe, expect, test, vi } from 'vitest';
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { createCareErasureOperatorClient } from './care-erasure-operator-client';
const begin = () => new BeginTransactionCommand({ resourceArn: 'fictional', secretArn: 'fictional' });
const statement = () => new ExecuteStatementCommand({ resourceArn: 'fictional', secretArn: 'fictional', sql: 'private fictional payload' });
describe('bounded erasure operator diagnostics', () => {
  test('failure records only a fixed phase and typed category, not arbitrary message, SQL or metadata', async () => {
    for (const [name, reason] of [['DatabaseResumingException', 'database_resuming'], ['AccessDeniedException', 'access_denied'],
      ['ExpiredTokenException', 'token_expired'], ['CredentialsProviderError', 'credentials_unavailable'], ['TimeoutError', 'timeout'],
      ['unknown-private-token', 'unknown'], ['__proto__', 'unknown']]) {
      const error = Object.assign(new Error('private bearer credential health SQL'), { name, $metadata: { private: 'secret' } });
      const send = vi.fn(async () => { throw error; }), operator = createCareErasureOperatorClient({ send });
      await expect(operator.client.send(begin())).rejects.toBe(error);
      expect(operator.failure()).toBe(`begin_${reason}`); expect(send).toHaveBeenCalledTimes(1);
    }
  });
  test('timeout or ambiguous network failure is observed once, never replayed', async () => {
    for (const [code, reason] of [['ECONNRESET', 'connection_reset'], ['ETIMEDOUT', 'timeout'], ['SECRET', 'unknown']]) {
      const error = Object.assign(new Error('private'), { code }), send = vi.fn(async () => { throw error; });
      const operator = createCareErasureOperatorClient({ send });
      await expect(operator.client.send(statement())).rejects.toBe(error);
      expect(operator.failure()).toBe(`statement_${reason}`); expect(send).toHaveBeenCalledTimes(1);
    }
  });
  test('successful resume clears its failure and a later failed commit is the authoritative failure', async () => {
    let calls = 0;
    const operator = createCareErasureOperatorClient({ send: async () => {
      if (++calls === 1) throw Object.assign(new Error('private'), { name: 'DatabaseResumingException' });
      if (calls === 3) throw Object.assign(new Error('private'), { name: 'TimeoutError' });
      return {};
    } });
    await expect(operator.client.send(begin())).rejects.toThrow(); expect(operator.failure()).toBe('begin_database_resuming');
    await operator.client.send(begin()); expect(operator.failure()).toBeUndefined();
    await expect(operator.client.send(new CommitTransactionCommand({ resourceArn: 'fictional', secretArn: 'fictional', transactionId: 'fictional' }))).rejects.toThrow();
    expect(operator.failure()).toBe('commit_timeout');
    await operator.client.send(new RollbackTransactionCommand({ resourceArn: 'fictional', secretArn: 'fictional', transactionId: 'fictional' }));
    expect(operator.failure()).toBe('commit_timeout');
  });
  test('cleanup denial cannot mask the original statement failure', async () => {
    const operator = createCareErasureOperatorClient({ send: async () => { throw Object.assign(new Error('private'), { name: 'AccessDeniedException' }); } });
    await expect(operator.client.send(statement())).rejects.toThrow();
    await expect(operator.client.send(new RollbackTransactionCommand({ resourceArn: 'fictional', secretArn: 'fictional', transactionId: 'fictional' }))).rejects.toThrow();
    expect(operator.failure()).toBe('statement_access_denied');
  });
});
