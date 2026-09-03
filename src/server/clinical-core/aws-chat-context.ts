if (typeof window !== "undefined") throw new Error("clinical-core/aws-chat-context is server-only.");

import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { ClinicalRequestContext } from "./aws-identity-consent";

export class ChatContextError extends Error {
  constructor(readonly category: "chat_context_refused" | "consent_required" | "database_unavailable") {
    super(category);
    this.name = "ChatContextError";
  }
}

export interface ChatContextAdapter<Context extends ClinicalRequestContext> {
  getContext(context: Context): Promise<Record<string, unknown>>;
}

export function createAwsChatContextAdapter<Context extends ClinicalRequestContext>(
  database: ClinicalCoreDatabase,
): ChatContextAdapter<Context> {
  return {
    getContext: (context) => run(database, context, async (tx) => {
      const result = await tx.query<{ data: unknown }>(
        "select clinical_core.get_patient_chat_context() as data",
      );
      const raw = result.rows[0]?.data;
      let data: unknown = raw;
      if (typeof raw === "string") {
        try { data = JSON.parse(raw); } catch { throw new ChatContextError("database_unavailable"); }
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ChatContextError("database_unavailable");
      }
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
    if (error instanceof ChatContextError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) throw new ChatContextError("chat_context_refused");
    throw new ChatContextError("database_unavailable");
  }
}
