import { canonicalPayload, CONSUMER_CLINICAL_COLLECTIONS, validateCollectionPayload, type ConsumerClinicalCollection } from "./aws-consumer-clinical-records";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OWNED_STORAGE_SCOPES = ["forms_checkins","symptoms_adherence","nutrition","protocols_supplements","wearables","reproductive_health"] as const;
export type OwnedStorageScope = typeof OWNED_STORAGE_SCOPES[number];
export type OwnedRecordWrite = {
  collection: ConsumerClinicalCollection; recordId: string; expectedRevision: number;
  requestId: string; payload: Record<string, unknown>; deleted: boolean; consentRevision: number;
};
type WriteResult = { recordId: string; revision: number; duplicate: boolean; receivedAt: string };
export type OwnedRecord = { recordId: string; revision: number; payload: Record<string, unknown>; receivedAt: string };
export class OwnedStorageError extends Error {
  constructor(readonly code: "request_invalid" | "owner_required" | "storage_unavailable" | "consent_required" | "conflict") { super(code); }
}

/** Internal production adapter, not an activation switch. The public workload
 * must independently verify rollout/PHI policy before calling it. No clinic
 * connection, recipient ID, or caller-selected owner is accepted in requests. */
export function createOwnedConsumerRecordsAdapter(database: ClinicalCoreDatabase) {
  const run = <T>(context: ProductionClinicalRequestContext, purpose: "clinical_data" | "consent_management", work: (tx: ClinicalCoreTransaction) => Promise<T>) => {
    if (context.identityPool !== "consumer" || context.purpose !== purpose
      || context.environment !== "production-clinical" || context.dataClassification !== "clinical_phi"
      || context.containsPhi !== true || context.realPatientData !== true || context.productionBound !== true
      || !UUID.test(context.actorPersonId) || !UUID.test(context.organizationId)
      || !/^[A-Za-z0-9:_-]{8,128}$/.test(context.identitySubject)) throw new OwnedStorageError("owner_required");
    return database.transaction(async tx => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
        context.identitySubject, context.purpose, context.environment, context.dataClassification,
      ]);
      return work(tx);
    }).catch(error => {
      if (error instanceof OwnedStorageError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        if (error.category === "identity_refused") throw new OwnedStorageError("owner_required");
        if (["consent_required","conflict","request_invalid"].includes(error.category)) {
          throw new OwnedStorageError(error.category as "consent_required" | "conflict" | "request_invalid");
        }
      }
      throw new OwnedStorageError("storage_unavailable");
    });
  };
  return {
    async write(context: ProductionClinicalRequestContext, input: OwnedRecordWrite): Promise<WriteResult> {
      exactKeys(input,["collection","recordId","expectedRevision","requestId","payload","deleted","consentRevision"]);
      collection(input.collection);
      if (!UUID.test(input.recordId) || !UUID.test(input.requestId) || !revision(input.expectedRevision,0)
        || !revision(input.consentRevision,1) || typeof input.deleted !== "boolean"
        || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) invalid();
      let payload: string;
      try {
        if (!input.deleted) validateCollectionPayload(input.collection,input.payload);
        payload = canonicalPayload(input.payload);
      } catch { invalid(); }
      if (input.deleted && payload !== "{}") invalid();
      return run(context,"clinical_data",async tx => {
        const result = await tx.query<{ result: unknown }>("select clinical_core.write_owned_consumer_record($1,$2,$3,$4,$5::jsonb,$6,$7) as result", [
          input.collection,clinicalUuid(input.recordId),input.expectedRevision,clinicalUuid(input.requestId),payload,input.deleted,input.consentRevision,
        ]);
        const value = object(result.rows[0]?.result);
        if (value.recordId !== input.recordId || !revision(value.revision,1) || typeof value.duplicate !== "boolean" || !date(value.receivedAt)) unavailable();
        return { recordId: value.recordId as string, revision: value.revision as number, duplicate: value.duplicate as boolean, receivedAt: value.receivedAt as string };
      });
    },
    async list(context: ProductionClinicalRequestContext, input: {
      collection: ConsumerClinicalCollection; limit: number; after?: { receivedAt: string; recordId: string };
    }): Promise<OwnedRecord[]> {
      exactKeys(input,["collection","limit","after"]);
      collection(input.collection);
      if (!Number.isInteger(input.limit) || input.limit<1 || input.limit>100) invalid();
      if (input.after) {
        exactKeys(input.after,["receivedAt","recordId"]);
        if (!date(input.after.receivedAt) || !UUID.test(input.after.recordId)) invalid();
      }
      return run(context,"clinical_data",async tx => {
        const result = await tx.query<{ result: unknown }>("select clinical_core.list_owned_consumer_records($1,$2,$3::timestamptz,$4) as result", [
          input.collection,input.limit,input.after?.receivedAt ?? null,input.after ? clinicalUuid(input.after.recordId) : null,
        ]);
        const data = parsed(result.rows[0]?.result);
        if (!Array.isArray(data) || data.length>input.limit) unavailable();
        return (data as unknown[]).map(row => {
          const value = object(row);
          if (typeof value.recordId !== "string" || !UUID.test(value.recordId) || !revision(value.revision,1) || !date(value.receivedAt)) unavailable();
          const payload = object(value.payload);
          try { canonicalPayload(payload); validateCollectionPayload(input.collection,payload); } catch { unavailable(); }
          return { recordId: value.recordId as string,revision: value.revision as number,payload,receivedAt: value.receivedAt as string };
        });
      });
    },
    async setConsent(context: ProductionClinicalRequestContext, input: {
      scope: OwnedStorageScope; status: "granted" | "revoked"; releaseVersion?: string; expectedRevision: number;
    }) {
      exactKeys(input,["scope","status","releaseVersion","expectedRevision"]);
      if (!OWNED_STORAGE_SCOPES.includes(input.scope) || !["granted","revoked"].includes(input.status)
        || !revision(input.expectedRevision,0) || (input.status === "granted" && !/^[A-Za-z0-9._/-]{1,80}$/.test(input.releaseVersion ?? ""))) invalid();
      return run(context,"consent_management",async tx => {
        const result = await tx.query<{ result: unknown }>("select clinical_core.set_owned_consumer_consent($1,$2,$3,$4) as result", [input.scope,input.status,input.releaseVersion ?? null,input.expectedRevision]);
        const value = object(result.rows[0]?.result);
        if (value.scope !== input.scope || value.status !== input.status || value.revision !== input.expectedRevision+1 || typeof value.releaseVersion !== "string") unavailable();
        return { scope: input.scope,status: input.status,revision: value.revision as number,releaseVersion: value.releaseVersion as string };
      });
    },
  };
}
function invalid(): never { throw new OwnedStorageError("request_invalid"); }
function unavailable(): never { throw new OwnedStorageError("storage_unavailable"); }
function revision(value: unknown,min: number) { return typeof value === "number" && Number.isSafeInteger(value) && value>=min && value<2_147_483_647; }
function date(value: unknown) { return typeof value === "string" && value.length<=40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
function collection(value: ConsumerClinicalCollection) { if (!CONSUMER_CLINICAL_COLLECTIONS.includes(value)) invalid(); }
function exactKeys(value: object,allowed: string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); }
function parsed(value: unknown): unknown { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { unavailable(); } }
function object(value: unknown): Record<string, unknown> { const data = parsed(value); if (!data || typeof data !== "object" || Array.isArray(data)) unavailable(); return data as Record<string,unknown>; }
