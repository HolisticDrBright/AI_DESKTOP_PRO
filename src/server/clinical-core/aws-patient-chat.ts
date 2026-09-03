if (typeof window !== "undefined") throw new Error("clinical-core/aws-patient-chat is server-only.");

import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { ClinicalRequestContext } from "./aws-identity-consent";

export class PatientChatError extends Error {
  constructor(readonly category: "chat_refused" | "request_invalid" | "not_found" | "database_unavailable") {
    super(category);
    this.name = "PatientChatError";
  }
}

export interface PatientChatAdapter<Context extends ClinicalRequestContext> {
  request(context: Context, request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createAwsPatientChatAdapter<Context extends ClinicalRequestContext>(
  database: ClinicalCoreDatabase,
): PatientChatAdapter<Context> {
  return {
    request: (context, request) => run(database, context, async (tx) => {
      const result = await tx.query<{ data: unknown }>(
        "select clinical_core.patient_chat_request($1::jsonb) as data",
        [JSON.stringify(request)],
      );
      const raw = result.rows[0]?.data;
      let data: unknown = raw;
      if (typeof raw === "string") {
        try { data = JSON.parse(raw); } catch { throw new PatientChatError("database_unavailable"); }
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new PatientChatError("database_unavailable");
      return data as Record<string, unknown>;
    }),
  };
}

async function run<T>(database: ClinicalCoreDatabase, context: ClinicalRequestContext,
  work: (tx: ClinicalCoreTransaction) => Promise<T>): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        { kind: "uuid", value: context.actorPersonId },
        { kind: "uuid", value: context.organizationId },
        context.identityPool, context.identitySubject, context.purpose, context.environment,
        context.dataClassification,
      ]);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof PatientChatError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) {
      const message = error.message;
      if (/not_found|candidate_not_found/.test(message)) throw new PatientChatError("not_found");
      if (/invalid/.test(message)) throw new PatientChatError("request_invalid");
      throw new PatientChatError("chat_refused");
    }
    throw new PatientChatError("database_unavailable");
  }
}
