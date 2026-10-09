import { describe, it, expect, vi } from "vitest";
import { createEncounterRecordingOperations, RecordingAuthorityError } from "./encounter-recording-operations";
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
const id = "11111111-1111-4111-8111-111111111111";
const context: ProductionClinicalRequestContext = { actorPersonId: id, organizationId: id, identityPool: "workforce",
  identitySubject: "fictional-subject", purpose: "clinical_data", environment: "production-clinical",
  dataClassification: "clinical_phi", containsPhi: true, realPatientData: true, productionBound: true };
const request = { action: "addParticipant", encounterId: id, commandId: id, kind: "patient", displayName: "Fictional", canSelfConsent: true };
describe("typed recording database operations", () => {
  it("refuses unsupported commands and context before opening a transaction", async () => {
    const transaction = vi.fn(), operations = createEncounterRecordingOperations({ transaction });
    for (const input of [{ ...request, sql: "select anything" }, { ...request, organizationId: id }, { action: "beginCapture" }])
      await expect(operations(context, input)).rejects.toMatchObject({ code: "request_invalid" });
    await expect(operations({ ...context, identityPool: "consumer" }, request)).rejects.toMatchObject({ code: "recording_access_refused" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("validates database response shape instead of leaking extra fields, raw tokens or SQL errors", async () => {
    for (const data of [null, "bad-json", {}, { participantId: id, captureToken: "must-not-escape" }]) {
      const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ data }] });
      const database: ClinicalCoreDatabase = { transaction: work => work({ query } as ClinicalCoreTransaction) };
      await expect(createEncounterRecordingOperations(database)(context, request)).rejects.toMatchObject({ code: "service_unavailable" });
    }
    for (const [failure, expected] of [[new Error("secret patient SQL"), "service_unavailable"],
      [new ClinicalCoreDatabaseRejection("conflict"), "conflict"], [new ClinicalCoreDatabaseRejection("identity_refused"), "recording_access_refused"],
      [new ClinicalCoreDatabaseRejection("consent_required"), "recording_consent_required"]] as const) {
      const database: ClinicalCoreDatabase = { transaction: async () => { throw failure; } };
      const result = await createEncounterRecordingOperations(database)(context, request).catch(error => error);
      expect(result).toBeInstanceOf(RecordingAuthorityError);
      if (!(result instanceof RecordingAuthorityError)) throw new Error("expected sanitized recording error");
      expect(result.message).toBe(expected);
    }
  });
});
