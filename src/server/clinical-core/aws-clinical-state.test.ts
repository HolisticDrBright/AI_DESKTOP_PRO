import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase } from "./database";
import {
  ClinicalStateError,
  createAwsProductionClinicalStateAdapter,
  createAwsSyntheticClinicalStateAdapter,
  type LabResultImport,
} from "./aws-clinical-state";
import type { ProductionClinicalRequestContext, SyntheticRequestContext } from "./aws-identity-consent";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";

function context(pool: "consumer" | "workforce" = "consumer"): SyntheticRequestContext {
  return {
    actorPersonId: PERSON,
    organizationId: ORG,
    identityPool: pool,
    identitySubject: "synthetic-subject-001",
    purpose: "clinical_data",
    environment: "synthetic-staging",
    dataClassification: "synthetic_only",
    containsPhi: false,
    realPatientData: false,
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

function payload(): LabResultImport {
  return {
    schemaVersion: "lab-result/1",
    provider: "alp_patient_sync",
    providerEventId: "lab:event:0001",
    connectionId: CONNECTION,
    resourceVersion: "1",
    occurredAt: "2026-08-19T12:00:00.000Z",
    source: { system: "ai_longevity_pro_v2", recordType: "lab_panels", panelId: "panel_001", markerId: "marker_001" },
    panel: { name: "Synthetic metabolic panel", collectedAt: "2026-08-18T12:00:00.000Z", sourceLabel: "Synthetic Lab" },
    result: { name: "Synthetic glucose", value: 91, unit: "mg/dL", sourceStatus: "normal", referenceRange: { min: 70, max: 99 } },
  };
}

function database(state = "review_pending", duplicate = false) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const db: ClinicalCoreDatabase = {
    async transaction(work) {
      return work({
        async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
          calls.push({ sql, parameters });
          if (sql.includes("record_lab_import")) {
            return { rows: [{ event_id: EVENT, state, duplicate }] as unknown as Row[] };
          }
          if (sql.includes("review_lab_import")) {
            return { rows: [{ event_id: EVENT, state: "accepted", observation_id: EVENT, duplicate: false }] as unknown as Row[] };
          }
          if (sql.includes("get_consumer_connection")) {
            return { rows: [{
              connection_id: CONNECTION, patient_record_id: EVENT, state: "verified",
              verified_at: "2026-08-20T00:00:00.000Z", lab_results_import_consent: "granted",
            }] as unknown as Row[] };
          }
          return { rows: [] };
        },
      });
    },
  };
  return { db, calls };
}

describe("AWS synthetic clinical state adapter", () => {
  test("matches the V2 lab journal golden content hash for a one-sided reported range", async () => {
    const fixture = database(), input = payload();
    input.source = { system: "ai_longevity_pro_v2", recordType: "lab_panels", panelId: `panel_${"a".repeat(32)}`, markerId: `marker_${"b".repeat(32)}` };
    input.panel = { name: "Synthetic panel", collectedAt: "2026-09-17T02:00:00.000Z", sourceLabel: "Fixture" };
    input.result = { name: "Synthetic glucose", value: 91, unit: "mg/dL", sourceStatus: "normal", referenceRange: { max: 99 } };
    const result = await createAwsSyntheticClinicalStateAdapter(fixture.db).importLabResult(context(), input);
    expect(result.receipt?.payloadSha256).toBe("49317fbd0fe49f2f52df24960aa3e59ad50fa0fff741a4c4d5c5b6e917d76a24");
  });
  test.each(["review_pending", "accepted", "rejected", "conflict"])("binds %s duplicate receipts to the exact submitted and persisted hash", async state => {
    const fixture = database(state, true), input = payload();
    const receipt = await createAwsSyntheticClinicalStateAdapter(fixture.db).importLabResult(context(), input);
    expect(receipt).toMatchObject({ state, duplicate: true, receipt: { connectionId: input.connectionId,
      providerEventId: input.providerEventId, resourceVersion: input.resourceVersion } });
    expect(receipt.receipt?.payloadSha256).toBe(fixture.calls.find(c => c.sql.includes("record_lab_import"))!.parameters.at(-1));
  });
  test("freezes receipt provenance before asynchronous database work", async () => {
    const fixture = database(), input = payload();
    const db: ClinicalCoreDatabase = { transaction: async work => {
      input.providerEventId = "lab:changed:001"; input.resourceVersion = "changed"; input.result.value = 199;
      return fixture.db.transaction(work);
    } };
    const result = await createAwsSyntheticClinicalStateAdapter(db).importLabResult(context(), input);
    expect(result.receipt).toMatchObject({ providerEventId: "lab:event:0001", resourceVersion: "1" });
    expect(fixture.calls.find(c => c.sql.includes("record_lab_import"))!.parameters[9]).toBe(91);
  });
  test("refuses malformed database outcome rather than issuing an acknowledgment", async () => {
    await expect(createAwsSyntheticClinicalStateAdapter(database("invented").db).importLabResult(context(), payload()))
      .rejects.toMatchObject({ category: "database_unavailable" });
  });
  test("imports a minimum-necessary marker through the governed SQL function", async () => {
    const fixture = database();
    const result = await createAwsSyntheticClinicalStateAdapter(fixture.db).importLabResult(context(), payload());
    expect(result).toMatchObject({ eventId: EVENT, state: "review_pending", duplicate: false,
      receipt: { version: "lab-import-receipt/1", connectionId: CONNECTION, providerEventId: "lab:event:0001", resourceVersion: "1" } });
    expect(fixture.calls[0]!.sql).toContain("set_request_context");
    const call = fixture.calls.find((entry) => entry.sql.includes("record_lab_import"))!;
    expect(call.sql).toContain("$10::numeric");
    expect(call.sql).toContain("$12::numeric");
    expect(call.sql).toContain("$13::numeric");
    expect(call.parameters).toContain("alp_patient_sync");
    expect(call.parameters.at(-1)).toMatch(/^[0-9a-f]{64}$/);
    expect(result.receipt?.payloadSha256).toBe(call.parameters.at(-1));
    expect(JSON.stringify(call.parameters)).not.toContain("interpretation");
  });

  test("refuses real-data posture before touching the database", async () => {
    const fixture = database();
    const unsafe = { ...context(), containsPhi: true, realPatientData: true } as unknown as SyntheticRequestContext;
    await expect(createAwsSyntheticClinicalStateAdapter(fixture.db).importLabResult(unsafe, payload()))
      .rejects.toEqual(expect.objectContaining({ category: "clinical_state_refused" }));
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects malformed or non-finite result data", async () => {
    const fixture = database();
    const malformed = payload();
    malformed.result.value = Number.NaN;
    await expect(createAwsSyntheticClinicalStateAdapter(fixture.db).importLabResult(context(), malformed))
      .rejects.toBeInstanceOf(ClinicalStateError);
    expect(fixture.calls).toHaveLength(0);
  });

  test("requires workforce context for clinical review", async () => {
    const fixture = database();
    const service = createAwsSyntheticClinicalStateAdapter(fixture.db);
    await expect(service.reviewLabResult(context("consumer"), { eventId: EVENT, decision: "accept" }))
      .rejects.toEqual(expect.objectContaining({ category: "clinical_state_refused" }));
    await expect(service.reviewLabResult(context("workforce"), { eventId: EVENT, decision: "accept" }))
      .resolves.toMatchObject({ state: "accepted", observationId: EVENT });
  });

  test("provides tenant-bound synthetic patient and imported-document reads for Desktop", async () => {
    const fixture = database();
    const service = createAwsSyntheticClinicalStateAdapter(fixture.db);
    await service.listDesktopPatients!(context("workforce"), EVENT);
    await service.listDesktopLabDocuments!(context("workforce"), EVENT);
    const patientRead = fixture.calls.find((entry) => entry.sql.includes("from clinical_core.patient_records"))!;
    const documentRead = fixture.calls.find((entry) => entry.sql.includes("from clinical_core.lab_import_events"))!;
    expect(patientRead.sql).toContain("organization_id=$1");
    expect(documentRead.sql).toContain("organization_id=$1 and patient_record_id=$2");
    expect(documentRead.sql).toContain("state='accepted'");
    expect(patientRead.parameters[0]).toMatchObject({ kind: "uuid", value: ORG });
    expect(documentRead.parameters[1]).toMatchObject({ kind: "uuid", value: EVENT });
  });
});

describe("AWS production clinical state adapter", () => {
  test("sets the production PHI context for the consumer connection read", async () => {
    const fixture = database();
    await expect(createAwsProductionClinicalStateAdapter(fixture.db).getConsumerConnection(productionContext()))
      .resolves.toMatchObject({ connectionId: CONNECTION, state: "verified" });
    expect(fixture.calls[0]!.parameters.slice(4)).toEqual(["clinical_data", "production-clinical", "clinical_phi"]);
  });
});
