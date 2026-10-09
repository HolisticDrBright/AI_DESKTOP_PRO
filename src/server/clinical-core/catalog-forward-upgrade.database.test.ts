import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyClinicalCoreMigrations, loadClinicalCoreMigrations } from './migrations';
import { applyGovernedCatalogMigrations } from './catalog-migrations';
import { careErasurePreservation } from './care-erasure-schema-upgrade';
import type { ClinicalCoreDatabase } from './database';

it('derives exact source policy descriptors and current table metadata from the real registered artifacts', async () => {
  const pg = new PGlite({ extensions: { pgcrypto } });
  const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, args = []) => tx.query(sql, [...args]) })) };
  try {
    const core = loadClinicalCoreMigrations();
    await applyClinicalCoreMigrations(database, core);
    const alias = core.find(m => m.version === '20260821049700')!;
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', ['20260902230000', alias.name, alias.sha256]);
    await applyGovernedCatalogMigrations(database);
    const tables = (await pg.query(careErasurePreservation.tableQuery)).rows;
    const policy = async () => (await pg.query<{ expression: string }>(`select polname name,polcmd::text command,polpermissive permissive,
      array(select r.rolname::text from pg_roles r where r.oid=any(p.polroles) order by r.rolname) roles,
      pg_get_expr(polqual,polrelid) expression,pg_get_expr(polwithcheck,polrelid) with_check
      from pg_policy p where polrelid='commercial_reference.affiliate_offer_versions'::regclass order by polname`)).rows;
    expect(tables).toHaveLength(89);
    expect(createHash('sha256').update(JSON.stringify(tables)).digest('hex')).toBe('b2f51c806ce1ddf0c7d7a1bb745136c4f468e01403f3f3de489ccd1d67b90a56');
    expect(await policy()).toMatchObject([{ roles: ['clinical_core_api'], command: 'r', permissive: true, with_check: null }]);
    await pg.exec(readFileSync('infra/aws-clinical-core/source-candidates/catalog-offer-current-product.sql', 'utf8'));
    const successor = await policy();
    expect(successor).toHaveLength(1);
    expect(successor[0]?.expression).toContain('v.version = p.active_version');
    expect(successor[0]?.expression).toContain("v.product_type = 'supplement'::text");
    expect(successor[0]?.expression).toContain("v.access_tier = 'open'::text");
    expect(core).toHaveLength(47);
  } finally { await pg.close(); }
}, 60000);
