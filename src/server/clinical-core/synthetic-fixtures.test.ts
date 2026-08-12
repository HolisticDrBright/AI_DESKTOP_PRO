import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase } from "./database";
import { provisionSyntheticAcceptanceFixtures, validateSyntheticAcceptanceManifest } from "./synthetic-fixtures";

const MANIFEST = {
  schemaVersion: "aws-clinical-core-synthetic-acceptance/1",
  environment: "synthetic-staging",
  dataClassification: "synthetic_only",
  containsPhi: false,
  awsAccountId: "123456789012",
  awsRegion: "us-east-2",
  reviewedAt: "2026-08-11T20:00:00Z",
  fixture: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationLabel: "Synthetic acceptance clinic",
    workforcePersonId: "22222222-2222-4222-8222-222222222222",
    workforceSubject: "workforce-sub-0001",
    consumerPersonId: "33333333-3333-4333-8333-333333333333",
    consumerSubject: "consumer-sub-0001",
    patientRecordId: "44444444-4444-4444-8444-444444444444",
    consentArtifactId: "55555555-5555-4555-8555-555555555555",
    consentArtifactSha256: "a".repeat(64),
  },
} as const;

describe("synthetic acceptance fixture boundary", () => {
  test("accepts only the bounded synthetic manifest", () => {
    expect(validateSyntheticAcceptanceManifest(MANIFEST)).toEqual(MANIFEST);
    expect(() => validateSyntheticAcceptanceManifest({ ...MANIFEST, containsPhi: true })).toThrow(/manifest_invalid/);
    expect(() => validateSyntheticAcceptanceManifest({ ...MANIFEST, email: "synthetic@example.test" })).toThrow(/manifest_invalid/);
    expect(() => validateSyntheticAcceptanceManifest({ ...MANIFEST, fixture: { ...MANIFEST.fixture, consumerSubject: MANIFEST.fixture.workforceSubject } })).toThrow(/manifest_invalid/);
  });

  test("provisions the minimum seven records transactionally and checks every identity", async () => {
    const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const database: ClinicalCoreDatabase = {
      transaction: async (work) => work({
        query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
          queries.push({ sql, parameters });
          return { rows: sql.startsWith("select count") ? [{ count: 1 } as unknown as Row] : [] };
        },
      }),
    };
    await expect(provisionSyntheticAcceptanceFixtures(database, MANIFEST)).resolves.toEqual({ provisioned: true, records: 8 });
    expect(queries.filter((query) => query.sql.startsWith("insert into")).length).toBe(8);
    expect(JSON.stringify(queries)).not.toMatch(/email|password|token|patientName/i);
  });

  test("refuses a pre-existing record that does not match the reviewed fixture", async () => {
    const database: ClinicalCoreDatabase = {
      transaction: async (work) => work({
        query: async <Row extends Record<string, unknown>>() => ({ rows: [{ count: 0 } as unknown as Row] }),
      }),
    };
    await expect(provisionSyntheticAcceptanceFixtures(database, MANIFEST)).rejects.toMatchObject({ category: "fixture_mismatch" });
  });
});
