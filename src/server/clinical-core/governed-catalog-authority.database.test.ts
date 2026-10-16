import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createAwsGovernedCatalogApiHandler, type CatalogApiEvent } from "./aws-governed-catalog-api";
import { loadGovernedCatalogMigrations } from "./catalog-migrations";
import { classifyDatabaseRejection } from "./rds-data-database";
import type { ClinicalCoreDatabase } from "./database";

/**
 * The governed catalog read Program Studio makes (POST /api/live/programs/catalog), for the four onboarding cases, on
 * each host it can reach: the real HTTP handler and the real readers over the real SQL (embedded engine, not hosted
 * acceptance). The Desktop route chooses the host from the runtime, not from the authority mode: the synthetic,
 * PHI-disabled host reads `/catalog/products`; every other runtime reads `/catalog/reference` on the production host.
 *
 * - synthetic-staging: the catalog database holds reference rows and nothing else — no clinic, no membership. The
 *   handler checks the token's shape, so an already-issued token reads the reference catalog until it expires,
 *   whatever has happened to the clinic or the membership since.
 * - production-clinical: the reader binds the current membership of the subject in the selected clinic (the BLOCKED
 *   current-membership setter) in the same transaction as the projection; a suspended or archived clinic, a removed
 *   membership, a foreign clinic and an already-issued token all refuse on the next request.
 *
 * Errors pass through the production adapter's own classification, as the RDS Data API database does.
 * Fictional rows only.
 */
const workforceIssuer = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce";
const workforceAudience = "workforceclient1234567890";
const configuration = {
  workforceIssuer, workforceAudience,
  consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer",
  consumerAudience: "consumerclient12345678901",
};
const unwrap = (value: unknown) => value && typeof value === "object" && "kind" in value && value.kind === "uuid" && "value" in value ? value.value : value;
/** The production dispatch in front of a real engine: a SQL error is classified as the RDS adapter classifies it. */
function databaseFor(pg: PGlite): ClinicalCoreDatabase {
  return { transaction: async work => {
    try {
      return await pg.transaction(async tx => {
        await tx.exec("set local role clinical_core_api");
        return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) as never });
      });
    } catch (error) {
      throw classifyDatabaseRejection({ name: "DatabaseErrorException", message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error;
    }
  } };
}
const status = (response: { statusCode: number; body: string }) => [response.statusCode, JSON.parse(response.body).error ?? "ok"];

describe("synthetic-staging: the deployed reference catalog re-reads nothing after the token is issued", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite({ extensions: { pgcrypto } });
    for (const migration of loadGovernedCatalogMigrations()) await pg.exec(migration.sql);
  }, 120_000);
  afterAll(async () => { await pg?.close(); });

  const syntheticEvent = (organization: string): CatalogApiEvent => ({
    routeKey: "GET /clinical-core/workforce/catalog/products",
    headers: { "x-alp-selected-organization-id": organization },
    requestContext: { accountId: "588966314750", authorizer: { jwt: { claims: {
      iss: workforceIssuer, aud: workforceAudience, token_use: "id", sub: "workforce:fictional-subject-0001",
      "custom:person_id": randomUUID(), "custom:organization_id": organization, "custom:synthetic_attested": "true",
    } } } },
  });

  it("an already-issued token naming a clinic that is suspended, archived or has no membership row: admitted until it expires", async () => {
    const { rows } = await pg.query<{ organizations: string | null; memberships: string | null }>(
      "select to_regclass('clinical_core.organizations')::text as organizations, to_regclass('clinical_core.organization_memberships')::text as memberships");
    // Nothing to re-read: the catalog database has no clinic and no membership.
    expect(rows[0]).toEqual({ organizations: null, memberships: null });
    const handler = createAwsGovernedCatalogApiHandler({ database: databaseFor(pg), configuration: { ...configuration, environment: "synthetic-staging" } });
    const answer = await handler(syntheticEvent(randomUUID()));
    expect(status(answer)).toEqual([200, "ok"]);
    expect(JSON.parse(answer.body)).toMatchObject({ environment: "synthetic-staging", dataClassification: "reference_only", phiAllowed: false });
  });

  it("control: a token without the synthetic claims is refused", async () => {
    const handler = createAwsGovernedCatalogApiHandler({ database: databaseFor(pg), configuration: { ...configuration, environment: "synthetic-staging" } });
    const event = syntheticEvent(randomUUID());
    delete event.requestContext!.authorizer!.jwt!.claims!["custom:organization_id"];
    expect(status(await handler(event))).toEqual([403, "identity_refused"]);
  });
});

describe("production-clinical: the reference read binds the current membership in its own transaction", () => {
  let pg: PGlite;
  let clinic: string, foreignClinic: string, staff: string, subject: string;
  beforeAll(async () => {
    const { manifest, files } = JSON.parse(execFileSync(process.execPath, ["scripts/build-aws-production-clinical-core.mjs", "--json"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
    pg = new PGlite({ extensions: { pgcrypto } });
    for (const migration of manifest.migrations) await pg.exec(files[migration.file]);
    for (const candidate of ["workforce-current-membership-context.sql", "production-catalog-source-verification.sql", "production-catalog-reference-projection.sql"]) {
      await pg.exec(readFileSync(`infra/aws-clinical-core/source-candidates/${candidate}`, "utf8"));
    }
    const batch = randomUUID();
    await pg.query(`insert into clinical_reference.catalog_import_batches
      (id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
      values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`, [batch, `fixture-${batch}`, "d".repeat(64)]);
    await pg.query(`insert into clinical_reference.catalog_products (stable_id,review_status,active_version,environment)
      values('prd_authority_alpha','approved',1,'production-clinical')`);
    await pg.query(`insert into clinical_reference.catalog_product_versions
      (id,product_stable_id,version,display_name,product_type,access_tier,declared_restricted,direct_order_allowed,label_sha256,content_sha256,
       clinical_payload,source_refs,review_status,import_batch_id)
      values($1,'prd_authority_alpha',1,'FICTIONAL authority product','supplement','open',false,true,$2,$3,'{}','["fictional-source"]','approved',$4)`,
    [randomUUID(), "b".repeat(64), "a".repeat(64), batch]);
  }, 120_000);
  afterAll(async () => { await pg?.close(); });
  beforeEach(async () => {
    [clinic, foreignClinic, staff, subject] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC'),($2,'FICTIONAL FOREIGN CLINIC')", [clinic, foreignClinic]);
    await pg.query("insert into clinical_core.persons(id,subject_key) values($1,$2)", [staff, `subject_${staff.replaceAll("-", "")}`]);
    await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [staff, subject]);
    await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [clinic, staff]);
  });

  // The ID token is the same object on every request: an already-issued token whose claims never change.
  const tokenFor = (selected: string): CatalogApiEvent => ({
    routeKey: "GET /clinical-core/workforce/catalog/reference",
    headers: { "x-alp-selected-organization-id": selected },
    requestContext: { accountId: "173535830222", authorizer: { jwt: { claims: {
      iss: workforceIssuer, aud: workforceAudience, token_use: "id", sub: subject, email_verified: "true", "custom:synthetic_attested": "false",
    } } } },
  });
  const handler = () => createAwsGovernedCatalogApiHandler({ database: databaseFor(pg), configuration: { ...configuration, environment: "production-clinical" } });

  it("control: a current practitioner of an active clinic reads the reference catalog", async () => {
    const answer = await handler()(tokenFor(clinic));
    expect(status(answer)).toEqual([200, "ok"]);
    expect(JSON.parse(answer.body).data.products.map((product: { productId: string }) => product.productId)).toEqual(["prd_authority_alpha"]);
  });

  it.each(["suspended", "archived"])("a %s clinic: the same already-issued token is refused on the next read", async clinicStatus => {
    expect(status(await handler()(tokenFor(clinic)))).toEqual([200, "ok"]);
    await pg.query("update clinical_core.organizations set status=$2 where id=$1", [clinic, clinicStatus]);
    expect(status(await handler()(tokenFor(clinic)))).toEqual([403, "identity_refused"]);
  });

  it("a removed membership: the same already-issued token is refused on the next read", async () => {
    expect(status(await handler()(tokenFor(clinic)))).toEqual([200, "ok"]);
    await pg.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [clinic, staff]);
    expect(status(await handler()(tokenFor(clinic)))).toEqual([403, "identity_refused"]);
  });

  it("an unapproved account (identity, no membership) and a foreign clinic are refused", async () => {
    expect(status(await handler()(tokenFor(foreignClinic)))).toEqual([403, "identity_refused"]);
    await pg.query("delete from clinical_core.organization_memberships where organization_id=$1 and person_id=$2", [clinic, staff]);
    expect(status(await handler()(tokenFor(clinic)))).toEqual([403, "identity_refused"]);
  });
});
