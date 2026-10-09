import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { bindCareConnectionDatabase, type CareConnectionFunctionBinding } from './care-connections-database-binding';

const sql = readFileSync('infra/aws-clinical-core/production-migrations/20261006020000_production_care_connections.sql', 'utf8').replace(/\r\n?/g, '\n');
const functions = (): CareConnectionFunctionBinding[] => [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
  .map(([, name, body]) => ({ name, bodySha256: createHash('sha256').update(body).digest('hex'), apiExecute: name.startsWith('clinical_core.') }));

describe('connection metadata admission, fictional transport only', () => {
  it.each(['missing', 'duplicate', 'foreign', 'digest', 'privilege'])('refuses %s compiled binding before database work', fault => {
    const rows = functions();
    if (fault === 'missing') rows.pop();
    if (fault === 'duplicate') rows[0] = { ...rows[1] };
    if (fault === 'foreign') rows[0].name = 'clinical_core.other_function';
    if (fault === 'digest') rows[0].bodySha256 = 'bad';
    if (fault === 'privilege') rows[0].apiExecute = true;
    const database = { transaction: vi.fn() } as ClinicalCoreDatabase;
    expect(() => bindCareConnectionDatabase(database, rows)).toThrow('care_connection_contract_binding_invalid');
    expect(database.transaction).not.toHaveBeenCalled();
  });
  it.each([false, null, undefined])('refuses absent or negative verification before invoking business work: %s', async valid => {
    const query = vi.fn(async () => ({ rows: valid === undefined ? [] : [{ valid }] })) as ClinicalCoreTransaction['query'];
    const database: ClinicalCoreDatabase = { transaction: work => work({ query }) };
    const business = vi.fn();
    await expect(bindCareConnectionDatabase(database, functions()).transaction(business)).rejects.toThrow('service_unavailable');
    expect(business).not.toHaveBeenCalled();
  });
  it('captures the compiled binding before asynchronous work, and checks before every transaction', async () => {
    const rows = functions(), original = rows.map(f => ({ ...f }));
    const query = vi.fn(async () => ({ rows: [{ valid: true }] })) as ClinicalCoreTransaction['query'];
    const database: ClinicalCoreDatabase = { transaction: work => work({ query }) };
    const bound = bindCareConnectionDatabase(database, rows);
    rows[0].bodySha256 = 'f'.repeat(64); rows.splice(1);
    const work = vi.fn(async () => 'business');
    expect(await bound.transaction(work)).toBe('business');
    expect(await bound.transaction(work)).toBe('business');
    expect(query).toHaveBeenCalledTimes(2);
    for (const [, args] of vi.mocked(query).mock.calls) {
      const expected = JSON.parse(args![0] as string) as { schema: string; name: string; sha256: string }[];
      expect(expected).toHaveLength(7);
      for (const f of original) expect(expected.find(e => e.schema + '.' + e.name === f.name)?.sha256).toBe(f.bodySha256);
    }
  });
});
