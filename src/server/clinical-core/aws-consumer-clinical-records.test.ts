import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase } from "./database";
import type { ProductionClinicalRequestContext, SyntheticRequestContext } from "./aws-identity-consent";
import {
  ConsumerClinicalError,
  canonicalPayload,
  createAwsConsumerClinicalRecordsAdapter,
  createAwsProductionConsumerClinicalRecordsAdapter,
} from "./aws-consumer-clinical-records";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const RECORD = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "66666666-6666-4666-8666-666666666666";

function context(purpose: "clinical_data" | "consent_management" = "clinical_data"): SyntheticRequestContext {
  return {
    actorPersonId: PERSON, organizationId: ORG, identityPool: "consumer",
    identitySubject: "synthetic-subject-001", purpose,
    environment: "synthetic-staging", dataClassification: "synthetic_only",
    containsPhi: false, realPatientData: false,
  };
}

function productionContext(): ProductionClinicalRequestContext {
  return {
    actorPersonId: PERSON, organizationId: ORG, identityPool: "consumer",
    identitySubject: "production-subject-001", purpose: "clinical_data",
    environment: "production-clinical", dataClassification: "clinical_phi",
    containsPhi: true, realPatientData: true, productionBound: true,
  };
}

function database() {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const db: ClinicalCoreDatabase = {
    async transaction(work) {
      return work({
        async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
          calls.push({ sql, parameters });
          if (sql.includes("record_consumer_clinical_version")) return { rows: [{
            version_id: VERSION_ID, stable_record_id: RECORD, record_key: RECORD,
            resource_version: "2026-08-21T01:02:03.000Z", received_at: "2026-08-21T01:02:04.000Z", duplicate: false,
          }] as unknown as Row[] };
          if (sql.includes("list_consumer_clinical_records")) return { rows: [{
            version_id: VERSION_ID, stable_record_id: RECORD, record_key: RECORD,
            resource_version: "1", payload: '{"name":"Synthetic protocol"}',
            payload_sha256: "a".repeat(64), deleted: false, received_at: "2026-08-21T01:02:04.000Z",
          }] as unknown as Row[] };
          if (sql.includes("list_consumer_consent_history")) return { rows: [{
            scope: "nutrition", status: "granted", recorded_at: "2026-08-21T01:02:04.000Z",
            version: 1, method: "patient_app", representative_authority: "self",
          }] as unknown as Row[] };
          if (sql.includes("submit_privacy_request")) return { rows: [{
            request_id: VERSION_ID, kind: "export", status: "submitted", detail: null,
            submitted_at: "2026-08-21T01:02:04.000Z", resolved_at: null,
          }] as unknown as Row[] };
          return { rows: [] };
        },
      });
    },
  };
  return { db, calls };
}

describe("AWS consumer clinical record adapter", () => {
  test("writes an immutable, hashed clinical version through the governed function", async () => {
    const fixture = database();
    const result = await createAwsConsumerClinicalRecordsAdapter(fixture.db).recordVersion(context(), {
      connectionId: CONNECTION, stableRecordId: RECORD, collection: "protocols",
      recordKey: RECORD, resourceVersion: "2026-08-21T01:02:03.000Z",
      idempotencyKey: "protocol:synthetic:0001",
      payload: {
        id: "protocol_local_1", status: "active", name: "Synthetic protocol",
        start_date: "2026-08-21", version: 1, supplements_json: [],
        peptides_json: [], lifestyle_tasks_json: [],
      }, deleted: false,
    });
    expect(result).toMatchObject({ versionId: VERSION_ID, stableRecordId: RECORD, duplicate: false });
    const write = fixture.calls.find((call) => call.sql.includes("record_consumer_clinical_version"))!;
    expect(write.parameters.at(-2)).toMatch(/^[0-9a-f]{64}$/);
    expect(write.parameters).not.toContain("synthetic-subject-001");
  });

  test("accepts bounded patient-reported health intake without account identifiers", async () => {
    const fixture = database();
    await expect(createAwsConsumerClinicalRecordsAdapter(fixture.db).recordVersion(context(), {
      connectionId: CONNECTION, stableRecordId: RECORD, collection: "clinical_intakes",
      recordKey: "current", resourceVersion: "intake-v1",
      idempotencyKey: "intake:synthetic:0001",
      payload: {
        id: "intake_local_1",
        chiefComplaint: { id: "chief_1", description: "Synthetic fatigue", onset: "chronic",
          duration: "3 months", severity: 4, betterWith: [], worseWith: [],
          previousDiagnoses: [], previousTreatments: [], timestamp: "2026-08-25T10:00:00.000Z" },
        associatedSymptoms: [], energyLevel: 4, sleepQuality: 5, digestiveFunction: 5,
        stressPerception: 6, temperatureSensitivity: "normal",
        createdAt: "2026-08-25T10:00:00.000Z", updatedAt: "2026-08-25T10:00:00.000Z",
      }, deleted: false,
    })).resolves.toMatchObject({ versionId: VERSION_ID });
    expect(fixture.calls.some((call) => call.sql.includes("record_consumer_clinical_version"))).toBe(true);
  });

  test("refuses identity fields in generic health-profile payloads", async () => {
    const fixture = database();
    await expect(createAwsConsumerClinicalRecordsAdapter(fixture.db).recordVersion(context(), {
      connectionId: CONNECTION, stableRecordId: RECORD, collection: "wellness_profiles",
      recordKey: "current", resourceVersion: "profile-v1",
      idempotencyKey: "profile:synthetic:0001",
      payload: { id: "profile_1", goals: [], onboardingCompleted: true, role: "patient",
        email: "synthetic@example.invalid" }, deleted: false,
    })).rejects.toMatchObject({ category: "request_invalid" });
    expect(fixture.calls).toHaveLength(0);
  });

  test("returns only bounded, current record payloads", async () => {
    const fixture = database();
    const rows = await createAwsConsumerClinicalRecordsAdapter(fixture.db).listRecords(context(), {
      connectionId: CONNECTION, collection: "protocols", limit: 100,
    });
    expect(rows).toEqual([expect.objectContaining({ payload: { name: "Synthetic protocol" }, deleted: false })]);
    expect(fixture.calls.find((call) => call.sql.includes("list_consumer_clinical_records"))?.parameters.at(-1)).toBe(100);
  });

  test("refuses credentials, excessive depth, and real-data posture before the database", async () => {
    expect(() => canonicalPayload({ password: "do-not-store" })).toThrow(ConsumerClinicalError);
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let index = 0; index < 10; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => canonicalPayload(tooDeep)).toThrow(ConsumerClinicalError);
    const fixture = database();
    const unsafe = { ...context(), containsPhi: true, realPatientData: true } as unknown as SyntheticRequestContext;
    await expect(createAwsConsumerClinicalRecordsAdapter(fixture.db).listRecords(unsafe, {
      connectionId: CONNECTION, collection: "protocols", limit: 100,
    })).rejects.toMatchObject({ category: "clinical_record_refused" });
    expect(fixture.calls).toHaveLength(0);
  });

  test("lists consent history and submits patient privacy requests", async () => {
    const fixture = database();
    const service = createAwsConsumerClinicalRecordsAdapter(fixture.db);
    await expect(service.listConsentHistory(context("consent_management"), CONNECTION))
      .resolves.toEqual([expect.objectContaining({ scope: "nutrition", status: "granted" })]);
    await expect(service.submitPrivacyRequest(context("consent_management"), {
      connectionId: CONNECTION, kind: "export",
    })).resolves.toEqual(expect.objectContaining({ requestId: VERSION_ID, status: "submitted" }));
  });
});

describe("AWS production consumer clinical record adapter", () => {
  test("sets the production PHI context before listing governed records", async () => {
    const fixture = database();
    await expect(createAwsProductionConsumerClinicalRecordsAdapter(fixture.db).listRecords(productionContext(), {
      connectionId: CONNECTION, collection: "protocols", limit: 100,
    })).resolves.toHaveLength(1);
    expect(fixture.calls[0]!.parameters.slice(4)).toEqual(["clinical_data", "production-clinical", "clinical_phi"]);
  });
});
