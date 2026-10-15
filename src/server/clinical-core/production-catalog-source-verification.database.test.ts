import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

let db: PGlite;
const reviewer = randomUUID();
const batch = randomUUID();
const productVersion = randomUUID();
const product = `prd_catalog_${randomUUID().replaceAll("-", "")}`;
const proof = () => ({
  contract: "production-catalog-ingredient-release/1",
  productId: product,
  productVersion: 1,
  productContentSha256: "a".repeat(64),
  labelVersionId: productVersion,
  labelSha256: "b".repeat(64),
  completeness: "complete",
  sourceVerification: "V",
  ingredientKeys: ["magnesium_glycinate"],
  sourceRefs: ["fictional-source"],
});

async function record(note: unknown, seconds = 0) {
  await db.query(`insert into clinical_reference.product_label_verifications
    (product_version_id,reviewer_person_id,verification_note,verified_at)
    values($1,$2,$3,clock_timestamp()+$4::integer*interval '1 second')`,
  [productVersion, reviewer, typeof note === "string" ? note : JSON.stringify(note), seconds]);
}

async function sourceV(): Promise<boolean> {
  const result = await db.query<{ eligible: boolean }>(
    "select clinical_private.current_catalog_source_v($1) as eligible", [productVersion],
  );
  return result.rows[0]!.eligible;
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    "scripts/build-aws-production-clinical-core.mjs", "--json",
  ], { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync("infra/aws-clinical-core/source-candidates/production-catalog-source-verification.sql", "utf8"));
  await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)",
    [reviewer, `subject_${reviewer.replaceAll("-", "")}`]);
  await db.query(`insert into clinical_reference.catalog_import_batches
    (id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
    values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`,
  [batch, `fixture-${batch}`, "d".repeat(64)]);
  await db.query(`insert into clinical_reference.catalog_products
    (stable_id,review_status,active_version,environment)
    values($1,'approved',1,'production-clinical')`, [product]);
  await db.query(`insert into clinical_reference.catalog_product_versions
    (id,product_stable_id,version,display_name,product_type,access_tier,direct_order_allowed,
     label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
    values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}',
           '["fictional-source"]','approved',$5)`,
  [productVersion, product, "b".repeat(64), "a".repeat(64), batch]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe("unregistered production catalog source-V helper", () => {
  it("requires an exact current V proof bound to the product and label bytes", async () => {
    expect(await sourceV()).toBe(false);
    await record(proof());
    expect(await sourceV()).toBe(true);
    await record({ ...proof(), labelSha256: "c".repeat(64) }, 5);
    expect(await sourceV()).toBe(false);
  });

  it("refuses omitted, null, extra and mistyped proof fields", async () => {
    const { labelSha256: _omitted, ...missingLabel } = proof();
    await record(missingLabel, 6);
    expect(await sourceV()).toBe(false);
    await record({ ...proof(), labelSha256: null }, 7);
    expect(await sourceV()).toBe(false);
    await record({ ...proof(), unreviewed: true }, 8);
    expect(await sourceV()).toBe(false);
    await record({ ...proof(), productVersion: "1" }, 9);
    expect(await sourceV()).toBe(false);
  });

  it("withholds malformed, R, duplicate-source and later withdrawal events", async () => {
    await record("not-json", 10);
    expect(await sourceV()).toBe(false);
    await record({ ...proof(), sourceVerification: "R" }, 15);
    expect(await sourceV()).toBe(false);
    await record({ ...proof(), sourceRefs: ["fictional-source", "fictional-source"] }, 20);
    expect(await sourceV()).toBe(false);
    await record(proof(), 25);
    expect(await sourceV()).toBe(true);
    await record({ contract: "production-catalog-ingredient-withdrawal/1" }, 30);
    expect(await sourceV()).toBe(false);
  });

  it("withholds a source proof after the reviewer or import batch is disabled", async () => {
    await record(proof(), 35);
    expect(await sourceV()).toBe(true);
    await db.query("update clinical_core.persons set status='disabled' where id=$1", [reviewer]);
    expect(await sourceV()).toBe(false);
    await db.query("update clinical_core.persons set status='active' where id=$1", [reviewer]);
    await db.query("update clinical_reference.catalog_import_batches set status='failed' where id=$1", [batch]);
    expect(await sourceV()).toBe(false);
  });

  it("grants neither the public nor the API role direct use of this internal helper", async () => {
    const { rows } = await db.query<{ api: boolean; publicGrant: boolean }>(`select
      has_function_privilege('clinical_core_api',
        'clinical_private.current_catalog_source_v(uuid)','EXECUTE') as api,
      exists(select 1 from information_schema.routine_privileges
        where routine_schema='clinical_private' and routine_name='current_catalog_source_v'
          and grantee='PUBLIC' and privilege_type='EXECUTE') as "publicGrant"`);
    expect(rows[0]).toEqual({ api: false, publicGrant: false });
  });
});
