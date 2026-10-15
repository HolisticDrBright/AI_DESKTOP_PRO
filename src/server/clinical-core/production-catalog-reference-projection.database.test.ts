import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

let db: PGlite;
const clinic = randomUUID();
const foreignClinic = randomUUID();
const staff = randomUUID();
const subject = randomUUID();
const batch = randomUUID();
const labels = [randomUUID(), randomUUID(), randomUUID()];
const products = ["prd_catalog_alpha", "prd_catalog_beta", "prd_catalog_gamma"];

async function page(cursor: string | null = null, limit = 50, selectedClinic = clinic) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role clinical_core_api");
    await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [subject, selectedClinic]);
    const { rows } = await tx.query<{ result: {
      contractVersion: string;
      audience: string;
      products: Array<Record<string, unknown>>;
      nextCursor: string | null;
    } }>("select clinical_core.list_current_catalog_reference($1,$2) as result", [cursor, limit]);
    return rows[0]!.result;
  });
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    "scripts/build-aws-production-clinical-core.mjs", "--json",
  ], { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const candidate of [
    "workforce-current-membership-context.sql",
    "production-catalog-source-verification.sql",
    "production-catalog-reference-projection.sql",
  ]) await db.exec(readFileSync(`infra/aws-clinical-core/source-candidates/${candidate}`, "utf8"));

  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC'),($2,'FOREIGN CLINIC')",
    [clinic, foreignClinic]);
  await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)",
    [staff, `subject_${staff.replaceAll("-", "")}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",
    [staff, subject]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",
    [clinic, staff]);
  await db.query(`insert into clinical_reference.catalog_import_batches
    (id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
    values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`,
  [batch, `fixture-${batch}`, "d".repeat(64)]);
  for (const [index, id] of products.entries()) {
    await db.query(`insert into clinical_reference.catalog_products
      (stable_id,review_status,active_version,environment)
      values($1,'approved',1,'production-clinical')`, [id]);
    await db.query(`insert into clinical_reference.catalog_product_versions
      (id,product_stable_id,version,display_name,product_type,access_tier,
       declared_restricted,direct_order_allowed,label_sha256,content_sha256,
       clinical_payload,source_refs,review_status,import_batch_id)
      values($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'{}','["fictional-source"]','approved',$10)`, [
      labels[index], id, `FICTIONAL ${index}`, index === 1 ? "other" : "supplement",
      index === 1 ? "blocked" : "open", index === 1, index !== 1,
      "b".repeat(64), "a".repeat(64), batch,
    ]);
  }
  await db.query(`insert into clinical_reference.product_label_verifications
    (product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)`, [
    labels[0], staff, JSON.stringify({
      contract: "production-catalog-ingredient-release/1",
      productId: products[0], productVersion: 1,
      productContentSha256: "a".repeat(64), labelVersionId: labels[0],
      labelSha256: "b".repeat(64), completeness: "complete",
      sourceVerification: "V", ingredientKeys: ["magnesium_glycinate"],
      sourceRefs: ["fictional-source"],
    }),
  ]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe("blocked production workforce catalog reference projection", () => {
  it("returns exact current versions and source state without commerce or fabricated labels", async () => {
    const result = await page();
    expect(result.contractVersion).toBe("production-catalog-reference/1");
    expect(result.audience).toBe("workforce");
    expect(result.nextCursor).toBeNull();
    expect(result.products).toHaveLength(3);
    expect(result.products[0]).toMatchObject({
      productId: products[0], productVersion: 1, labelVersionId: labels[0],
      labelSha256: "b".repeat(64), sourceVerified: true,
    });
    expect(result.products[1]).toMatchObject({
      productId: products[1], productType: "other", accessTier: "blocked",
      declaredRestricted: true, sourceVerified: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/destinationUrl|purchaseUrl|affiliateUrl|trackingMetadata/);
  });

  it("uses bounded keyset pages and refuses invalid cursors or limits", async () => {
    const first = await page(null, 1);
    expect(first.products.map((item) => item.productId)).toEqual([products[0]]);
    expect(first.nextCursor).toBe(products[0]);
    const second = await page(first.nextCursor, 1);
    expect(second.products.map((item) => item.productId)).toEqual([products[1]]);
    expect(second.nextCursor).toBe(products[1]);
    await expect(page(null, 101)).rejects.toThrow(/catalog_page_invalid/);
    await expect(page("prd_bad' OR true", 1)).rejects.toThrow(/catalog_page_invalid/);
  });

  it("excludes every product when its import batch is no longer successful", async () => {
    await db.query("update clinical_reference.catalog_import_batches set status='failed' where id=$1", [batch]);
    try { expect((await page()).products).toEqual([]); }
    finally { await db.query("update clinical_reference.catalog_import_batches set status='succeeded' where id=$1", [batch]); }
  });

  it("requires a current clinic member, not a stale token or foreign clinic", async () => {
    await expect(page(null, 50, foreignClinic)).rejects.toThrow(/workforce_membership_refused/);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'staff')",
      [foreignClinic, staff]);
    expect((await page(null, 50, foreignClinic)).products).toHaveLength(3);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",
      [foreignClinic, staff]);
    await expect(page(null, 50, foreignClinic)).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",
      [clinic, staff]);
    try { await expect(page()).rejects.toThrow(/workforce_membership_refused/); }
    finally {
      await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2",
        [clinic, staff]);
    }
  });

  it("grants only the exact projection, not direct catalog tables or the private proof helper", async () => {
    const { rows } = await db.query<{ projection: boolean; products: boolean; helper: boolean; publicGrant: boolean }>(`select
      has_function_privilege('clinical_core_api','clinical_core.list_current_catalog_reference(text,integer)','EXECUTE') as projection,
      has_table_privilege('clinical_core_api','clinical_reference.catalog_product_versions','SELECT') as products,
      has_function_privilege('clinical_core_api','clinical_private.current_catalog_source_v(uuid)','EXECUTE') as helper,
      exists(select 1 from information_schema.routine_privileges
        where routine_schema='clinical_core' and routine_name='list_current_catalog_reference'
          and grantee='PUBLIC' and privilege_type='EXECUTE') as "publicGrant"`);
    expect(rows[0]).toEqual({ projection: true, products: false, helper: false, publicGrant: false });
    await expect(db.transaction(async (tx) => {
      await tx.exec("set local role clinical_core_api");
      await tx.query("select clinical_core.list_current_catalog_reference(null,1)");
    })).rejects.toThrow();
  });
});
