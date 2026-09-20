import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { execFileSync } from "node:child_process";
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";
import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";
import { provisionRecordingAcceptanceEncounter } from "./recording-acceptance-fixture";

// The acceptance encounter fixture against the executable production SQL: the fixture tenant rows the synthetic manifest
// names (organization, practitioner identity and membership, patient record), then the encounter the recording run needs,
// started as the fixture practitioner and reused on repeat.
let db: PGlite;
const manifest: SyntheticAcceptanceManifest = {
  schemaVersion: "aws-clinical-core-synthetic-acceptance/1", environment: "synthetic-staging", dataClassification: "synthetic_only", containsPhi: false,
  awsAccountId: "123456789012", awsRegion: "us-east-2", reviewedAt: "2026-08-11T20:00:00Z",
  fixture: { organizationId: "11111111-1111-4111-8111-111111111111", organizationLabel: "Synthetic acceptance clinic", workforcePersonId: "22222222-2222-4222-8222-222222222222", workforceSubject: "workforce-sub-0001",
    consumerPersonId: "33333333-3333-4333-8333-333333333333", consumerSubject: "consumer-sub-0001", patientRecordId: "44444444-4444-4444-8444-444444444444",
    consentArtifactId: "55555555-5555-4555-8555-555555555555", consentArtifactSha256: "a".repeat(64), labConsentArtifactId: "99999999-9999-4999-8999-999999999999", labConsentArtifactSha256: "b".repeat(64),
    protocolConsentArtifactId: "12121212-1212-4121-8121-121212121212", protocolConsentArtifactSha256: "c".repeat(64), nutritionConsentArtifactId: "13131313-1313-4131-8131-131313131313", nutritionConsentArtifactSha256: "d".repeat(64),
    symptomsConsentArtifactId: "14141414-1414-4141-8141-141414141414", symptomsConsentArtifactSha256: "e".repeat(64), formsConsentArtifactId: "15151515-1515-4151-8151-151515151515", formsConsentArtifactSha256: "f".repeat(64),
    syncProviderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", isolationOrganizationId: "66666666-6666-4666-8666-666666666666", isolationOrganizationLabel: "Synthetic acceptance isolation clinic",
    isolationWorkforcePersonId: "77777777-7777-4777-8777-777777777777", isolationWorkforceSubject: "isolation-workforce-sub-0001" },
};
// The administrative path: no API role switch, the same parameter unwrapping the RDS Data adapter performs.
const admin: ClinicalCoreDatabase = { transaction: async (work) => db.transaction(async (tx) => work({ query: async (sql: string, args: readonly unknown[] = []) =>
  tx.query(sql, args.map((v) => (typeof v === "object" && v !== null && "kind" in v && v.kind === "uuid" && "value" in v ? v.value : v))) } as unknown as ClinicalCoreTransaction)) } as ClinicalCoreDatabase;
beforeAll(async () => {
  const { manifest: built, files } = JSON.parse(execFileSync(process.execPath, ["scripts/build-aws-production-clinical-core.mjs", "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  db = new PGlite({ extensions: { pgcrypto } }); for (const m of built.migrations) await db.exec(files[m.file]);
  const f = manifest.fixture;
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [f.organizationId]);
  await db.query("insert into clinical_core.persons(id,subject_key) values($1,$2)", [f.workforcePersonId, "subject_" + f.workforcePersonId.replaceAll("-", "")]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [f.workforcePersonId, f.workforceSubject]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [f.organizationId, f.workforcePersonId]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')", [f.patientRecordId, f.organizationId, "patient_" + f.patientRecordId.replaceAll("-", "")]);
}, 60000);
afterAll(async () => { await db?.close(); });
describe("recording acceptance encounter fixture", () => {
  it("starts one telehealth encounter for the fixture patient as the fixture practitioner and reuses it on the next run", async () => {
    const first = await provisionRecordingAcceptanceEncounter(admin, manifest);
    expect(first.reused).toBe(false); expect(first.encounterId).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await db.query<{ organization_id: string; patient_record_id: string; practitioner_person_id: string; visit_type: string; status: string }>(
      "select organization_id::text organization_id,patient_record_id::text patient_record_id,practitioner_person_id::text practitioner_person_id,visit_type,status from clinical_core.encounters where id=$1", [first.encounterId])).rows[0];
    expect(row).toEqual({ organization_id: manifest.fixture.organizationId, patient_record_id: manifest.fixture.patientRecordId, practitioner_person_id: manifest.fixture.workforcePersonId, visit_type: "telehealth", status: "in_progress" });
    const second = await provisionRecordingAcceptanceEncounter(admin, manifest);
    expect(second).toEqual({ encounterId: first.encounterId, reused: true });
    expect((await db.query<{ n: number }>("select count(*)::int n from clinical_core.encounters")).rows[0].n).toBe(1);
    // Closing the encounter ends reuse: the next run starts a fresh one rather than recording into a completed encounter.
    await db.query("update clinical_core.encounters set status='completed',ended_at=clock_timestamp() where id=$1", [first.encounterId]);
    const third = await provisionRecordingAcceptanceEncounter(admin, manifest);
    expect(third.reused).toBe(false); expect(third.encounterId).not.toBe(first.encounterId);
  });
  it("refuses a manifest outside the synthetic boundary before touching the database", async () => {
    await expect(provisionRecordingAcceptanceEncounter(admin, { ...manifest, containsPhi: true as unknown as false })).rejects.toThrow("fixture_boundary_refused");
    await expect(provisionRecordingAcceptanceEncounter(admin, { ...manifest, environment: "production-clinical" as unknown as "synthetic-staging" })).rejects.toThrow("fixture_boundary_refused");
  });
});
