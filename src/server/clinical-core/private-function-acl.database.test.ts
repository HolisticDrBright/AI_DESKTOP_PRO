import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let db: PGlite;

beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as {
    manifest: { migrations: Array<{ file: string }> };
    files: Record<string, string>;
  };
  expect(artifact.manifest.migrations).toHaveLength(106);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of artifact.manifest.migrations) await db.exec(artifact.files[migration.file]!);
}, 180_000);

afterAll(async () => { await db?.close(); });

describe('production private-function ACL audit', () => {
  it('closes the twenty default PUBLIC grants without changing internal clinical entry points', async () => {
    const query = `select p.oid::regprocedure::text as signature,
      p.prosecdef as definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clinical_private' and has_schema_privilege('clinical_core_api',n.oid,'usage')
      and has_function_privilege('clinical_core_api',p.oid,'execute')
      and exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE') order by 1`;
    const before = (await db.query<{ signature: string; definer: boolean }>(query)).rows;
    expect(before).toHaveLength(20);
    expect(before.find(row => row.signature.startsWith('clinical_private.move_entitlement('))?.definer).toBe(true);
    await expect(db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.move_entitlement('00000000-0000-0000-0000-000000000001'::uuid,'reserve',1,'test',null,null,'00000000-0000-0000-0000-000000000001'::uuid)");
    })).rejects.toThrow(/entitlement_move_invalid/);

    const candidate = readFileSync('infra/aws-clinical-core/source-candidates/clinical-private-public-execute-closure.sql', 'utf8');
    await db.exec("create function clinical_private.unexpected_acl_probe() returns integer language sql as $$ select 1 $$");
    await expect(db.exec(candidate)).rejects.toThrow(/private_function_acl_parent_mismatch/);
    await db.exec('drop function clinical_private.unexpected_acl_probe()');
    await db.exec(candidate);
    expect((await db.query(query)).rows).toEqual([]);
    const apiCanMove = await db.query<{ allowed: boolean }>(
      "select has_function_privilege('clinical_core_api','clinical_private.move_entitlement(uuid,text,integer,text,uuid,text,uuid)','execute') as allowed");
    expect(apiCanMove.rows[0]?.allowed).toBe(false);
    await expect(db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.move_entitlement('00000000-0000-0000-0000-000000000001'::uuid,'reserve',1,'test',null,null,'00000000-0000-0000-0000-000000000001'::uuid)");
    })).rejects.toThrow(/permission denied/);
    await expect(db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query('select clinical_core.invoke_plan_operation(null,null)');
    })).rejects.toThrow(/plan_arguments_invalid/);
  });
});
