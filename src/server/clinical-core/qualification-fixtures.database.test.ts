import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";
import type { ClinicalCoreMigration } from "./migrations";
import { applyProductionClinicalCoreMigrations } from "./production-migrations";
import { provisionQualificationFixtures } from "./qualification-fixtures";
import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";

// The production-shaped fixtures go into a database whose ledger equals the built artifact, after the production apply
// (which requires an empty clinical dataset) and never into one whose history differs.
let db: PGlite;
let migrations: ClinicalCoreMigration[];
const manifest: SyntheticAcceptanceManifest = {
  schemaVersion: "aws-clinical-core-synthetic-acceptance/1", environment: "synthetic-staging", dataClassification: "synthetic_only", containsPhi: false,
  awsAccountId: "123456789012", awsRegion: "us-east-2", reviewedAt: "2026-09-21T00:00:00Z",
  fixture: { organizationId: "11111111-1111-4111-8111-111111111111", organizationLabel: "Fictional qualification clinic", workforcePersonId: "22222222-2222-4222-8222-222222222222", workforceSubject: "workforce-sub-00000001",
    consumerPersonId: "33333333-3333-4333-8333-333333333333", consumerSubject: "consumer-sub-00000001", patientRecordId: "44444444-4444-4444-8444-444444444444",
    consentArtifactId: "55555555-5555-4555-8555-555555555555", consentArtifactSha256: "a".repeat(64), labConsentArtifactId: "99999999-9999-4999-8999-999999999999", labConsentArtifactSha256: "b".repeat(64),
    protocolConsentArtifactId: "12121212-1212-4121-8121-121212121212", protocolConsentArtifactSha256: "c".repeat(64), nutritionConsentArtifactId: "13131313-1313-4131-8131-131313131313", nutritionConsentArtifactSha256: "d".repeat(64),
    symptomsConsentArtifactId: "14141414-1414-4141-8141-141414141414", symptomsConsentArtifactSha256: "e".repeat(64), formsConsentArtifactId: "15151515-1515-4151-8151-151515151515", formsConsentArtifactSha256: "f".repeat(64),
    syncProviderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", isolationOrganizationId: "66666666-6666-4666-8666-666666666666", isolationOrganizationLabel: "Fictional qualification isolation clinic",
    isolationWorkforcePersonId: "77777777-7777-4777-8777-777777777777", isolationWorkforceSubject: "isolation-workforce-sub-0001" },
};
const unwrap = (v: unknown) => (typeof v === "object" && v !== null && "kind" in v && (v as { kind: string }).kind === "uuid" && "value" in v ? (v as { value: string }).value : v);
const admin = (pg: PGlite): ClinicalCoreDatabase => ({ transaction: async (work) => pg.transaction(async (tx) => work({ query: async (sql: string, args: readonly unknown[] = []) => tx.query(sql, args.map(unwrap)) } as unknown as ClinicalCoreTransaction)) } as ClinicalCoreDatabase);
const target = { qualificationDatabaseName: "clinical_core_qualification", stagingDatabaseName: "clinical_core" };
const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int n from ${table}`)).rows[0].n;

beforeAll(async () => {
  const { manifest: built, files } = JSON.parse(execFileSync(process.execPath, ["scripts/build-aws-production-clinical-core.mjs", "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  migrations = built.migrations.map((m: { version: string; file: string }) => ({ version: m.version, name: m.file.replace(/^\d+_/, "").replace(/\.sql$/, ""), sha256: createHash("sha256").update(files[m.file]).digest("hex"), sql: files[m.file] }));
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create extension if not exists pgcrypto");
  const applied = await applyProductionClinicalCoreMigrations(admin(db), migrations);
  // The real artifact through the real apply: the verification pins (table and contract counts) hold here, not in a mock.
  expect(applied.applied.length).toBe(101); expect(applied.clinicalRowCount).toBe(0); expect(applied.tableCount).toBe(123); expect(applied.contractCount).toBe(81);
}, 120000);
afterAll(async () => { await db?.close(); });

describe("qualification fixtures", () => {
  it("provisions fictional production-shaped rows once, idempotently, with the consumer's verified connection and every consent granted", async () => {
    const first = await provisionQualificationFixtures(admin(db), manifest, migrations, target);
    expect(first.provisioned).toBe(true); expect(first.inserted).toBe(25);
    expect(first.fixture).toMatchObject({ organizationId: manifest.fixture.organizationId, consumerPersonId: manifest.fixture.consumerPersonId, patientRecordId: manifest.fixture.patientRecordId, isolationOrganizationId: manifest.fixture.isolationOrganizationId });
    expect(first.fixture.patientConnectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.artifactReleaseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await count("clinical_core.organizations")).toBe(2); expect(await count("clinical_core.persons")).toBe(3); expect(await count("clinical_core.identities")).toBe(3);
    expect(await count("clinical_core.organization_memberships")).toBe(2); expect(await count("clinical_core.patient_records")).toBe(1); expect(await count("clinical_core.patient_connections")).toBe(1);
    expect(await count("clinical_core.consent_artifacts")).toBe(6); expect(await count("clinical_core.consent_grants")).toBe(6); expect(await count("clinical_core.sync_providers")).toBe(1);
    const consumer = (await db.query<{ identity_pool: string; production_bound: boolean; status: string }>("select identity_pool,production_bound,status from clinical_core.identities where identity_subject=$1", [manifest.fixture.consumerSubject])).rows[0];
    expect(consumer).toEqual({ identity_pool: "consumer", production_bound: true, status: "active" });
    const scopes = (await db.query<{ scope: string }>("select scope from clinical_core.consent_grants where connection_id=$1 and status='granted' order by scope", [first.fixture.patientConnectionId])).rows.map((r) => r.scope);
    expect(scopes).toEqual(["forms_checkins", "lab_results_import", "nutrition", "programs", "protocols_supplements", "symptoms_adherence"]);
    // No fictional row carries a real name, contact or clinical value: labels, keys and the literal placeholder name only.
    const person = (await db.query<{ subject_key: string }>("select subject_key from clinical_core.persons where id=$1", [manifest.fixture.consumerPersonId])).rows[0];
    expect(person.subject_key).toMatch(/^subject_qualification_consumer_[0-9a-f]{12}$/);
    const patient = (await db.query<{ first_name: string; last_name: string; email: string | null; mrn: string | null }>("select first_name,last_name,email,mrn from clinical_core.patient_records where id=$1", [manifest.fixture.patientRecordId])).rows[0];
    expect(patient).toEqual({ first_name: "Fictional", last_name: "Qualification", email: null, mrn: null });
    const second = await provisionQualificationFixtures(admin(db), manifest, migrations, target);
    expect(second.inserted).toBe(0); expect(second.fixture).toEqual(first.fixture);
    expect(await count("clinical_core.consent_grants")).toBe(6); expect(await count("clinical_core.patient_connections")).toBe(1);
  });
  it("refuses a manifest outside the synthetic boundary, a staging-named target and a ledger that differs from the artifact, before writing", async () => {
    await expect(provisionQualificationFixtures(admin(db), { ...manifest, containsPhi: true as unknown as false }, migrations, target)).rejects.toThrow("fixture_boundary_refused");
    await expect(provisionQualificationFixtures(admin(db), manifest, migrations, { qualificationDatabaseName: "clinical_core", stagingDatabaseName: "clinical_core" })).rejects.toThrow("fixture_boundary_refused");
    // A newer artifact the target has not applied, and a target whose history the artifact does not know.
    await expect(provisionQualificationFixtures(admin(db), manifest, [...migrations, { version: "20260930000000", name: "later", sha256: "0".repeat(64), sql: "select 1" }], target)).rejects.toThrow("qualification_schema_incomplete");
    await expect(provisionQualificationFixtures(admin(db), manifest, migrations.slice(0, 99), target)).rejects.toThrow("qualification_schema_incomplete");
    await expect(provisionQualificationFixtures(admin(db), manifest, [], target)).rejects.toThrow("qualification_schema_incomplete");
    expect(await count("clinical_core.organizations")).toBe(2);
  });
  it("refuses a database without the production ledger, which is what the populated synthetic-staging database is", async () => {
    const other = new PGlite({ extensions: { pgcrypto } });
    try {
      await other.exec("create schema clinical_core; create table clinical_core.schema_migrations(version text primary key, name text not null, sha256 text not null, applied_at timestamptz not null default clock_timestamp())");
      await other.query("insert into clinical_core.schema_migrations(version,name,sha256) values($1,'synthetic',$2)", ["20260904090000", "1".repeat(64)]);
      await expect(provisionQualificationFixtures(admin(other), manifest, migrations, target)).rejects.toThrow("qualification_schema_incomplete");
      expect((await other.query<{ n: number }>("select count(*)::int n from information_schema.tables where table_schema='clinical_core'")).rows[0].n).toBe(1);
    } finally { await other.close(); }
  });
});
