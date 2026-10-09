import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { catalogLockFixtureSql as sql } from './catalog-lock-admission';
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`create schema clinical_reference;
    create table clinical_reference.knowledge_sources(stable_id text primary key,
      review_status text default 'needs_review',active_version int,environment text,
      contains_phi boolean default false,data_classification text default 'reference_only',
      created_at timestamptz default clock_timestamp(),updated_at timestamptz default clock_timestamp());
    create table clinical_reference.knowledge_source_versions(source_stable_id text references clinical_reference.knowledge_sources(stable_id));`);
}, 30000);
afterAll(async () => { await pg?.close(); });
async function fixture() {
  const stableId = 'src_syn_catalog_lock_' + randomBytes(16).toString('hex');
  const { original, changed } = (await pg.query<{ original: string; changed: string }>(sql.create, [stableId])).rows[0];
  return { stableId, original, changed };
}
describe('exact fixture SQL on local PostgreSQL, not a two-session or hosted claim', () => {
  it('creates only an unapproved reference row and deletes exactly the admitted changed successor', async () => {
    const f = await fixture();
    expect(JSON.parse(f.original)).toMatchObject({ review_status: 'needs_review', active_version: null,
      environment: 'synthetic-staging', contains_phi: false, data_classification: 'reference_only' });
    const updated = await pg.query<{ changed: string }>(sql.update, [f.stableId, f.original]);
    expect(updated.rows).toEqual([{ changed: f.changed }]);
    expect((await pg.query(sql.update, [f.stableId, f.original])).rows).toEqual([]);
    expect((await pg.query(sql.remove, [f.stableId, f.original, f.changed])).rows).toEqual([{ stable_id: f.stableId }]);
  });
  it('can remove an original fixture after an aborted competing writer', async () => {
    const f = await fixture();
    expect((await pg.query(sql.remove, [f.stableId, f.original, f.changed])).rows).toEqual([{ stable_id: f.stableId }]);
  });
  for (const change of ["review_status='approved',active_version=1", "active_version=1", "environment='production-clinical'",
    "contains_phi=true", "data_classification='clinical'", "updated_at=updated_at+interval '2 seconds'"]) {
    it(`cannot update or remove a fixture after outside change: ${change}`, async () => {
      const f = await fixture(); await pg.query(`update clinical_reference.knowledge_sources set ${change} where stable_id=$1`, [f.stableId]);
      expect((await pg.query(sql.update, [f.stableId, f.original])).rows).toEqual([]);
      expect((await pg.query(sql.remove, [f.stableId, f.original, f.changed])).rows).toEqual([]);
    });
  }
  it('cannot erase a fixture referenced by a version, even if its original bytes match', async () => {
    const f = await fixture(); await pg.query('insert into clinical_reference.knowledge_source_versions values($1)', [f.stableId]);
    expect((await pg.query(sql.remove, [f.stableId, f.original, f.changed])).rows).toEqual([]);
  });
});
