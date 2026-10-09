if (typeof window !== "undefined") throw new Error("encounter-recording-operations is server-only");

import { recordingAuthorityRequestSchema, recordingWorkspaceSchema, recordingConsentReleaseSchema,
  recordingParticipantReceiptSchema, recordingConsentReceiptSchema, recordingWithdrawalReceiptSchema } from "@/contracts/encounterRecordingAuthority";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from "./database";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import type { z } from "zod";

export class RecordingAuthorityError extends Error {
  constructor(readonly code: "reauth_required" | "recording_access_refused" | "recording_consent_required" | "request_invalid" | "conflict" | "service_unavailable") {
    super(code); this.name = "RecordingAuthorityError";
  }
}
/** Fixed SQL commands only. No raw SQL, actor, organization or provider may be
 * selected by a request. Capture/transport operations are deliberately absent. */
export function createEncounterRecordingOperations(database: ClinicalCoreDatabase) {
  return async (context: ProductionClinicalRequestContext, input: unknown): Promise<unknown> => {
    if (context.identityPool !== "workforce" || context.purpose !== "clinical_data"
      || context.environment !== "production-clinical" || context.dataClassification !== "clinical_phi"
      || context.productionBound !== true || context.containsPhi !== true || context.realPatientData !== true)
      throw new RecordingAuthorityError("recording_access_refused");
    const parsed = recordingAuthorityRequestSchema.safeParse(input);
    if (!parsed.success) throw new RecordingAuthorityError("request_invalid");
    const r = parsed.data;
    try {
      return await database.transaction(async tx => {
        await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
          clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
          context.identitySubject, context.purpose, context.environment, context.dataClassification,
        ]);
        const query = async (sql: string, parameters: unknown[], schema: z.ZodType) => {
          const result = await tx.query<{ data: unknown }>(sql, parameters);
          const raw = result.rows[0]?.data;
          let data: unknown = raw;
          if (typeof raw === "string") { try { data = JSON.parse(raw); } catch { throw new RecordingAuthorityError("service_unavailable"); } }
          const output = schema.safeParse(data);
          if (!output.success) throw new RecordingAuthorityError("service_unavailable");
          return output.data;
        };
        switch (r.action) {
          case "workspace": return query("select clinical_private.get_encounter_recording_workspace($1,$2,$3) as data",
            [clinicalUuid(r.encounterId), r.locale, r.jurisdiction], recordingWorkspaceSchema);
          case "readConsentRelease": return query("select clinical_private.read_encounter_recording_consent_release($1,$2) as data",
            [clinicalUuid(r.encounterId), clinicalUuid(r.releaseId)], recordingConsentReleaseSchema);
          case "addParticipant": return query("select jsonb_build_object('participantId',clinical_private.add_encounter_recording_participant($1,$2,$3,$4,$5)) as data",
            [clinicalUuid(r.encounterId), r.kind, r.displayName, r.canSelfConsent, clinicalUuid(r.commandId)], recordingParticipantReceiptSchema);
          case "grantConsent": return query("select jsonb_build_object('consentId',clinical_private.grant_encounter_recording_consent($1,$2,$3,$4,$5,$6)) as data",
            [clinicalUuid(r.participantId), clinicalUuid(r.releaseId), clinicalUuid(r.commandId), r.method, r.acknowledgment,
              r.representativeAuthorityId === null ? null : clinicalUuid(r.representativeAuthorityId)], recordingConsentReceiptSchema);
          case "withdrawConsent":
            await tx.query("select clinical_private.withdraw_encounter_recording_consent($1,$2)", [clinicalUuid(r.consentId), r.reason]);
            return recordingWithdrawalReceiptSchema.parse({ withdrawn: true });
        }
      });
    } catch (error) {
      if (error instanceof RecordingAuthorityError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        if (error.category === "conflict" || error.category === "request_invalid") throw new RecordingAuthorityError(error.category);
        if (error.category === "consent_required") throw new RecordingAuthorityError("recording_consent_required");
        throw new RecordingAuthorityError("recording_access_refused");
      }
      throw new RecordingAuthorityError("service_unavailable");
    }
  };
}
