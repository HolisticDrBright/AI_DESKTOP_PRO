import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase } from "./database";
import { ClinicalStateError, createAwsSyntheticClinicalStateAdapter, type LabResultImport } from "./aws-clinical-state";
import type { SyntheticRequestContext } from "./aws-identity-consent";

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

function database() {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const db: ClinicalCoreDatabase = {
    async transaction(work) {
      return work({
        async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
          calls.push({ sql, parameters });
          if (sql.includes("record_lab_import")) {
            return { rows: [{ event_id: EVENT, state: "review_pending", duplicate: false }] as unknown as Row[] };
          }
          if (sql.includes("review_lab_import")) {
            return { rows: [{ event_id: EVENT, state: "accepted", observation_id: EVENT, duplicate: false }] as unknown as Row[] };
          }
          return { rows: [] };
        },
      });
    },
  };
  return { db, calls };
}

describe("AWS synthetic clinical state adapter", () => {
  test("imports a minimum-necessary marker through the governed SQL function", async () => {
    const fixture = database();
    const result = await createAwsSyntheticClinicalStateAdapter(fixture.db).importLabResult(context(), payload());
    expect(result).toEqual({ eventId: EVENT, state: "review_pending", duplicate: false });
    expect(fixture.calls[0]!.sql).toContain("set_request_context");
    const call = fixture.calls.find((entry) => entry.sql.includes("record_lab_import"))!;
    expect(call.parameters).toContain("alp_patient_sync");
    expect(call.parameters.at(-1)).toMatch(/^[0-9a-f]{64}$/);
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
