import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { embeddedQueryDiagnostic, observeEmbeddedQuery, type EmbeddedQueryDiagnostic } from './embeddedDatabaseDiagnostics';
import { applyProductionClinicalCoreMigrations, ProductionClinicalCoreMigrationError } from '../server/clinical-core/production-migrations';
import type { ClinicalCoreDatabase } from '../server/clinical-core/database';

it('records only the fixed event, statement digest and bounded SQLSTATE', () => {
  const sql = 'select fictional_sensitive_value';
  const error = Object.assign(new Error('private-message'), {
    code: '42501', detail: 'private-detail', query: sql, parameters: ['private-parameter'],
    hint: 'private-hint', stack: 'private-stack', SecretString: 'private-secret',
  });
  const diagnostic = embeddedQueryDiagnostic(sql, error);
  expect(diagnostic).toEqual({ event: 'embedded_database_query_failed',
    statementSha256: createHash('sha256').update(sql).digest('hex'), sqlState: '42501' });
  expect(Object.keys(diagnostic).sort()).toEqual(['event', 'sqlState', 'statementSha256']);
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-|fictional_sensitive_value/);
});

it('refuses malformed codes and never reads exception getters or inherited properties', () => {
  for (const code of ['private-token', '42501\nprivate', '42501\n', '4250', '425010', '42p01', 42501, null]) {
    expect(embeddedQueryDiagnostic('select 1', { code }).sqlState).toBeNull();
  }
  let reads = 0;
  const getter = Object.defineProperty({}, 'code', { get: () => { reads++; throw Error('private-getter'); } });
  expect(embeddedQueryDiagnostic('select 1', getter).sqlState).toBeNull();
  expect(embeddedQueryDiagnostic('select 1', Object.create({ code: '42501' })).sqlState).toBeNull();
  expect(reads).toBe(0);
});

it('unreadable exceptions produce no exception text and do not prevent a diagnostic', () => {
  const error = new Proxy({}, { getOwnPropertyDescriptor: () => { throw Error('private-proxy'); } });
  expect(embeddedQueryDiagnostic('select 1', error).sqlState).toBeNull();
  for (const other of [null, undefined, 'private-string', 7, true]) {
    expect(embeddedQueryDiagnostic('select 1', other).sqlState).toBeNull();
  }
});

it('a successful query keeps its exact result without emitting a failure', async () => {
  const result = { rows: [{ fictional: 1 }] }; let attempts = 0;
  const emitted: EmbeddedQueryDiagnostic[] = [];
  expect(await observeEmbeddedQuery('select 1', async () => { attempts++; return result; }, d => emitted.push(d))).toBe(result);
  expect(attempts).toBe(1); expect(emitted).toEqual([]);
});

it('a failed query emits once and rethrows the original error without retrying', async () => {
  const error = Object.assign(new Error('private-query-error'), { code: '42883' }); let attempts = 0;
  const emitted: EmbeddedQueryDiagnostic[] = [];
  await expect(observeEmbeddedQuery('select 1', async () => { attempts++; throw error; }, d => emitted.push(d))).rejects.toBe(error);
  expect(attempts).toBe(1); expect(emitted).toHaveLength(1); expect(emitted[0].sqlState).toBe('42883');
});

it('a failing diagnostic sink cannot replace the original query failure', async () => {
  const error = Object.assign(new Error('private-query-error'), { code: 'XX000' }); let attempts = 0;
  await expect(observeEmbeddedQuery('select 1', async () => { attempts++; throw error; }, () => { throw Error('private-log-error'); })).rejects.toBe(error);
  expect(attempts).toBe(1);
});

it('captures an actual embedded PostgreSQL permission failure without exposing the schema or statement', async () => {
  const pg = new PGlite(); const emitted: EmbeddedQueryDiagnostic[] = [];
  const sql = 'select value from diagnostic_private.records';
  try {
    await pg.exec('create role diagnostic_api nologin nosuperuser nobypassrls; create schema diagnostic_private; create table diagnostic_private.records(value text)');
    await expect(pg.transaction(async tx => {
      await tx.exec('set local role diagnostic_api');
      return observeEmbeddedQuery(sql, () => tx.query(sql), d => emitted.push(d));
    })).rejects.toMatchObject({ code: '42501' });
    expect(emitted).toEqual([{ event: 'embedded_database_query_failed',
      statementSha256: createHash('sha256').update(sql).digest('hex'), sqlState: '42501' }]);
    expect(JSON.stringify(emitted)).not.toMatch(/diagnostic_private|diagnostic_api|permission denied|select value/);
  } finally {
    await pg.close();
  }
});

it('the real migration runner remains opaque and fails closed while the test records the SQLSTATE', async () => {
  const sql = 'select 1'; const error = Object.assign(new Error('private-database-error'), { code: '42501' });
  const emitted: EmbeddedQueryDiagnostic[] = [];
  const database: ClinicalCoreDatabase = { transaction: async work => work({ query: async statement => {
    return observeEmbeddedQuery(statement, async () => {
      if (statement === sql) throw error;
      return { rows: [] } as never;
    }, d => emitted.push(d));
  } }) };
  await expect(applyProductionClinicalCoreMigrations(database, [{
    version: '20261011000000', name: 'fictional_diagnostic', sql,
    sha256: createHash('sha256').update(sql).digest('hex'),
  }])).rejects.toEqual(new ProductionClinicalCoreMigrationError('migration_failed', '20261011000000', 1));
  expect(emitted).toEqual([embeddedQueryDiagnostic(sql, error)]);
  expect(JSON.stringify(emitted)).not.toContain('private-database-error');
});
