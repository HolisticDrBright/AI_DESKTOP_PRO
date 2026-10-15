import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

let db: PGlite;

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    "scripts/build-aws-production-clinical-core.mjs", "--json",
  ], { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe("production clinical catalog versus standalone catalog reader", () => {
  it("keeps the production API role off direct catalog tables and exposes no standalone label-version table", async () => {
    const { rows } = await db.query<{
      productTable: string | null;
      standaloneLabelTable: string | null;
      directProductRead: boolean;
    }>(`select
      to_regclass('clinical_reference.catalog_product_versions')::text as "productTable",
      to_regclass('clinical_reference.product_label_versions')::text as "standaloneLabelTable",
      has_table_privilege('clinical_core_api', 'clinical_reference.catalog_product_versions', 'SELECT') as "directProductRead"`);
    expect(rows[0]).toEqual({
      productTable: "clinical_reference.catalog_product_versions",
      standaloneLabelTable: null,
      directProductRead: false,
    });
    // The standalone reader selects both tables directly. It cannot be used against this
    // production artifact merely by registering the current-membership function. A separate
    // reviewed production projection, or an exact schema transition, remains release-blocking.
  });
});
