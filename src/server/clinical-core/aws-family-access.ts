if (typeof window !== "undefined") throw new Error("clinical-core/aws-family-access is server-only.");

import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type { ClinicalRequestContext } from "./aws-identity-consent";

export const FAMILY_ACCESS_SCOPES = ["protocols_supplements", "laboratory_results", "medical_records"] as const;
export type FamilyAccessScope = (typeof FAMILY_ACCESS_SCOPES)[number];

export class FamilyAccessError extends Error {
  constructor(readonly category: "family_access_refused" | "invitation_invalid" | "conflict" | "database_unavailable") {
    super(category);
    this.name = "FamilyAccessError";
  }
}

export interface FamilyAccessAdapter<Context extends ClinicalRequestContext> {
  listPatientRequests(context: Context): Promise<Record<string, unknown>>;
  approve(context: Context, input: { relationshipId: string; expectedVersion: number; grantedScopes: FamilyAccessScope[]; consentVersion: string }): Promise<Record<string, unknown>>;
  claim(context: Context, input: { code: string; verifiedEmailSha256: string }): Promise<Record<string, unknown>>;
  listDelegated(context: Context): Promise<Record<string, unknown>>;
  readDelegated(context: Context, input: { relationshipId: string; scope: FamilyAccessScope }): Promise<Record<string, unknown>>;
  revoke(context: Context, input: { relationshipId: string; expectedVersion: number }): Promise<Record<string, unknown>>;
}

export function createAwsFamilyAccessAdapter<Context extends ClinicalRequestContext>(database: ClinicalCoreDatabase): FamilyAccessAdapter<Context> {
  return {
    listPatientRequests: (context) => run(database, context, (tx) => scalar(tx,
      "select clinical_core.list_my_patient_relationship_requests() as data", [])),
    approve: (context, input) => run(database, context, (tx) => scalar(tx,
      "select clinical_core.approve_patient_relationship($1,$2,$3::text[],$4) as data",
      [clinicalUuid(input.relationshipId), input.expectedVersion, `{${input.grantedScopes.join(",")}}`, input.consentVersion])),
    claim: (context, input) => run(database, context, (tx) => scalar(tx,
      "select clinical_core.claim_patient_relationship_invitation($1,$2) as data",
      [input.code, input.verifiedEmailSha256])),
    listDelegated: (context) => run(database, context, (tx) => scalar(tx,
      "select clinical_core.list_my_delegated_patient_access() as data", [])),
    readDelegated: (context, input) => run(database, context, (tx) => scalar(tx,
      "select clinical_core.get_delegated_patient_records($1,$2) as data",
      [clinicalUuid(input.relationshipId), input.scope])),
    revoke: (context, input) => run(database, context, (tx) => scalar(tx,
      "select clinical_core.revoke_my_patient_relationship($1,$2) as data",
      [clinicalUuid(input.relationshipId), input.expectedVersion])),
  };
}

async function scalar(tx: ClinicalCoreTransaction, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>> {
  const result = await tx.query<{ data: unknown }>(sql, params);
  const raw = result.rows[0]?.data;
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) as unknown; }
    catch { throw new FamilyAccessError("database_unavailable"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FamilyAccessError("database_unavailable");
  return value as Record<string, unknown>;
}

async function run<T>(database: ClinicalCoreDatabase, context: ClinicalRequestContext,
  work: (tx: ClinicalCoreTransaction) => Promise<T>): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
        context.identitySubject, context.purpose, context.environment, context.dataClassification,
      ]);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof FamilyAccessError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) {
      throw new FamilyAccessError("family_access_refused");
    }
    throw new FamilyAccessError("database_unavailable");
  }
}
