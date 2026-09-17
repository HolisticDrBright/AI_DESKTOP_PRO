if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-clinical-state is server-only.");
}

import { createHash } from "node:crypto";
import {labSpecimenTransferSchema,labSpecimenReceiptSchema,labSpecimenRecordSchema,specimenContent,type LabSpecimenTransfer,type LabSpecimenReceipt,type LabSpecimenRecord} from "../../contracts/labSpecimenTransfer";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import {
  ClinicalCoreAdapterError,
  type ClinicalRequestContext,
  type ProductionClinicalRequestContext,
  type SyntheticRequestContext,
} from "./aws-identity-consent";

export type LabResultImport = {
  schemaVersion: "lab-result/1";
  provider: "alp_patient_sync";
  providerEventId: string;
  connectionId: string;
  resourceVersion: string;
  occurredAt: string;
  source: {
    system: "ai_longevity_pro_v2";
    recordType: "lab_panels";
    panelId: string;
    markerId: string;
  };
  panel: { name: string; collectedAt: string; sourceLabel?: string };
  result: {
    name: string;
    value: number;
    unit?: string;
    sourceStatus?: "low" | "normal" | "high" | "critical" | "optimal" | "unknown";
    referenceRange?: { min?: number; max?: number };
  };
};

export type LabImportResult = {
  eventId: string;
  state: "review_pending" | "conflict" | "accepted" | "rejected";
  duplicate: boolean;
  receipt?: { version: "lab-import-receipt/1"; connectionId: string; providerEventId: string; resourceVersion: string; payloadSha256: string };
};

export type LabReviewResult = {
  eventId: string;
  state: "accepted" | "rejected";
  observationId?: string;
  duplicate: boolean;
};

export interface AwsClinicalStateAdapter<Context extends ClinicalRequestContext> {
  getConsumerConnection(context: Context): Promise<{
    connectionId: string;
    patientRecordId: string;
    state: "verified" | "paused";
    verifiedAt: string;
    labResultsImportConsent: "granted" | "revoked" | "not_granted";
  } | null>;
  importLabResult(context: Context, payload: LabResultImport): Promise<LabImportResult>;
  importLabSpecimenContext?(context:Context,payload:LabSpecimenTransfer):Promise<LabSpecimenReceipt>;
  getLabSpecimenContext?(context:Context,eventId:string):Promise<LabSpecimenRecord|null>;
  reviewLabResult(context: Context, input: {
    eventId: string;
    decision: "accept" | "reject";
    note?: string;
  }): Promise<LabReviewResult>;
  listLabImports(context: Context, state: LabImportResult["state"]): Promise<Record<string, unknown>[]>;
  listPatientLabObservations(context: Context, patientRecordId: string): Promise<Record<string, unknown>[]>;
  listDesktopPatients?(context: Context, patientRecordId?: string): Promise<Record<string, unknown>[]>;
  listDesktopLabDocuments?(context: Context, patientRecordId: string): Promise<Record<string, unknown>[]>;
}

export type AwsSyntheticClinicalStateAdapter = AwsClinicalStateAdapter<SyntheticRequestContext>;
export type AwsProductionClinicalStateAdapter = AwsClinicalStateAdapter<ProductionClinicalRequestContext>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const EVENT_ID = /^[A-Za-z0-9:_-]{8,160}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

export function createAwsSyntheticClinicalStateAdapter(database: ClinicalCoreDatabase): AwsSyntheticClinicalStateAdapter {
  return createAwsClinicalStateAdapter(database, "synthetic");
}

export function createAwsProductionClinicalStateAdapter(database: ClinicalCoreDatabase): AwsProductionClinicalStateAdapter {
  return createAwsClinicalStateAdapter(database, "production");
}

function createAwsClinicalStateAdapter<Context extends ClinicalRequestContext>(
  database: ClinicalCoreDatabase,
  boundary: "synthetic" | "production",
): AwsClinicalStateAdapter<Context> {
  return {
    async getConsumerConnection(context) {
      assertContext(context, boundary, "consumer");
      const rows = await run(database, context, async (tx) => (await tx.query<{
        connection_id: string;
        patient_record_id: string;
        state: "verified" | "paused";
        verified_at: string;
        lab_results_import_consent: "granted" | "revoked" | "not_granted";
      }>("select * from clinical_core.get_consumer_connection()" )).rows, "clinical_state_refused");
      const row = rows[0];
      return row ? {
        connectionId: row.connection_id,
        patientRecordId: row.patient_record_id,
        state: row.state,
        verifiedAt: row.verified_at,
        labResultsImportConsent: row.lab_results_import_consent,
      } : null;
    },
    async importLabResult(context, payload) {
      assertContext(context, boundary, "consumer");
      payload = structuredClone(payload);
      validateLabImport(payload);
      const canonicalPayload = JSON.stringify({
        schemaVersion: payload.schemaVersion,
        source: payload.source,
        panel: {
          name: payload.panel.name,
          collectedAt: payload.panel.collectedAt,
          ...(payload.panel.sourceLabel ? { sourceLabel: payload.panel.sourceLabel } : {}),
        },
        result: {
          name: payload.result.name,
          value: payload.result.value,
          ...(payload.result.unit ? { unit: payload.result.unit } : {}),
          ...(payload.result.sourceStatus ? { sourceStatus: payload.result.sourceStatus } : {}),
          ...(payload.result.referenceRange ? { referenceRange: payload.result.referenceRange } : {}),
        },
      });
      const row = await run(database, context, async (tx) => first(await tx.query<{
        event_id: string;
        state: LabImportResult["state"];
        duplicate: boolean;
      }>(
        "select * from clinical_core.record_lab_import($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12::numeric,$13::numeric,$14,$15::timestamptz,$16::timestamptz,$17)",
        [
          clinicalUuid(payload.connectionId), payload.provider, payload.providerEventId,
          payload.source.panelId, payload.source.markerId, payload.resourceVersion,
          payload.panel.name, payload.panel.sourceLabel ?? "", payload.result.name,
          payload.result.value, payload.result.unit ?? "", payload.result.referenceRange?.min ?? null,
          payload.result.referenceRange?.max ?? null, payload.result.sourceStatus ?? "",
          new Date(payload.panel.collectedAt).toISOString(), new Date(payload.occurredAt).toISOString(),
          createHash("sha256").update(canonicalPayload).digest("hex"),
        ],
      )), "clinical_state_refused");
      if (!UUID.test(row.event_id) || !["review_pending", "conflict", "accepted", "rejected"].includes(row.state)
        || typeof row.duplicate !== "boolean") throw new ClinicalStateError("database_unavailable");
      return { eventId: row.event_id, state: row.state, duplicate: row.duplicate,
        receipt: { version: "lab-import-receipt/1", connectionId: payload.connectionId, providerEventId: payload.providerEventId,
          resourceVersion: payload.resourceVersion, payloadSha256: createHash("sha256").update(canonicalPayload).digest("hex") } };
    },

    async importLabSpecimenContext(context,input) {
      assertContext(context,boundary,"consumer");
      const parsed=labSpecimenTransferSchema.safeParse(input);
      if(!parsed.success)throw new ClinicalStateError("request_invalid");
      const payload=parsed.data,content=specimenContent(payload),hash=createHash("sha256").update(content).digest("hex");
      const row=await run(database,context,async tx=>{
        try{return first(await tx.query("select * from clinical_core.record_lab_specimen_context($1)",[content]));}
        catch(error){
          if(error instanceof ClinicalCoreDatabaseRejection){
            if(error.category==='conflict')throw new ClinicalStateError('specimen_context_conflict');
            if(error.category==='consent_required')throw new ClinicalStateError('specimen_consent_required');
            if(error.category==='request_invalid')throw new ClinicalStateError('request_invalid');
          }
          throw error;
        }
      },"clinical_state_refused");
      const receipt=labSpecimenReceiptSchema.safeParse({version:"lab-specimen-receipt/1",
        contextId:row.context_id,labEventId:row.lab_event_id,requestId:row.request_id,revision:row.revision,
        payloadSha256:row.payload_sha256,receivedAt:specimenTimestamp(row.received_at),duplicate:row.duplicate});
      if(!receipt.success||receipt.data.labEventId!==payload.labEventId||receipt.data.requestId!==payload.requestId
        ||receipt.data.payloadSha256!==hash||receipt.data.revision!==payload.expectedRevision+1)throw new ClinicalStateError("database_unavailable");
      return receipt.data;
    },
    async getLabSpecimenContext(context,eventId) {
      assertContext(context,boundary);
      if(!UUID.test(eventId))throw new ClinicalStateError("request_invalid");
      return run(database,context,async tx=>{
        const rows=(await tx.query(`select id,lab_event_id,revision,context,received_at,payload_sha256,lab_payload_sha256
          from clinical_core.lab_specimen_context_versions where organization_id=$1 and lab_event_id=$2
          order by revision desc limit 1`,[clinicalUuid(context.organizationId),clinicalUuid(eventId)])).rows;
        if(!rows[0])return null;
        let raw=rows[0].context;
        if(typeof raw==="string"){try{raw=JSON.parse(raw);}catch{throw new ClinicalStateError("database_unavailable");}}
        const row=rows[0];
        const parsed=labSpecimenRecordSchema.safeParse({version:'lab-specimen-record/1',contextId:row.id,
          labEventId:row.lab_event_id,revision:row.revision,payloadSha256:row.payload_sha256,
          labPayloadSha256:row.lab_payload_sha256,receivedAt:specimenTimestamp(row.received_at),context:raw});
        if(!parsed.success||parsed.data.labEventId!==eventId)throw new ClinicalStateError("database_unavailable");
        return parsed.data;
      },"clinical_state_refused");
    },
    async reviewLabResult(context, input) {
      assertContext(context, boundary, "workforce");
      if (!UUID.test(input.eventId) || !["accept", "reject"].includes(input.decision)
        || (input.note !== undefined && (input.note.trim().length === 0 || input.note.length > 500))) {
        throw new ClinicalStateError("request_invalid");
      }
      const row = await run(database, context, async (tx) => first(await tx.query<{
        event_id: string;
        state: "accepted" | "rejected";
        observation_id: string | null;
        duplicate: boolean;
      }>("select * from clinical_core.review_lab_import($1,$2,$3)", [
        clinicalUuid(input.eventId), input.decision, input.note ?? null,
      ])), "clinical_state_refused");
      return {
        eventId: row.event_id,
        state: row.state,
        ...(row.observation_id ? { observationId: row.observation_id } : {}),
        duplicate: row.duplicate,
      };
    },

    async listLabImports(context, state) {
      assertContext(context, boundary, "workforce");
      if (!["review_pending", "conflict", "accepted", "rejected"].includes(state)) {
        throw new ClinicalStateError("request_invalid");
      }
      return run(database, context, async (tx) => (await tx.query(
        "select * from clinical_core.list_lab_imports($1)", [state],
      )).rows, "clinical_state_refused");
    },

    async listPatientLabObservations(context, patientRecordId) {
      assertContext(context, boundary);
      if (!UUID.test(patientRecordId)) throw new ClinicalStateError("request_invalid");
      return run(database, context, async (tx) => (await tx.query(
        "select * from clinical_core.list_patient_lab_observations($1)", [clinicalUuid(patientRecordId)],
      )).rows, "clinical_state_refused");
    },
    async listDesktopPatients(context, patientRecordId) {
      assertContext(context, boundary, "workforce");
      if (patientRecordId !== undefined && !UUID.test(patientRecordId)) throw new ClinicalStateError("request_invalid");
      const sql = boundary === "synthetic"
        ? `select id, organization_id, synthetic_record_key as mrn,
             'Synthetic'::text as first_name, synthetic_record_key as last_name,
             null::date as date_of_birth, null::text as sex, status
           from clinical_core.patient_records
           where organization_id=$1 and ($2::uuid is null or id=$2)
           order by synthetic_record_key, id limit 1000`
        : `select id, organization_id, mrn, first_name, last_name, date_of_birth, sex, status
           from clinical_core.patient_records
           where organization_id=$1 and deleted_at is null and ($2::uuid is null or id=$2)
           order by last_name, first_name, id limit 1000`;
      return run(database, context, async (tx) => (await tx.query(
        sql,
        [clinicalUuid(context.organizationId), patientRecordId ? clinicalUuid(patientRecordId) : null],
      )).rows, "clinical_state_refused");
    },
    async listDesktopLabDocuments(context, patientRecordId) {
      assertContext(context, boundary, "workforce");
      if (!UUID.test(patientRecordId)) throw new ClinicalStateError("request_invalid");
      return run(database, context, async (tx) => (await tx.query(
        `select id, 'AI Longevity Pro import'::text as file_name,
           coalesce(source_label,'AI Longevity Pro') as lab_company,
           panel_name, collected_at::date as lab_date, received_at as created_at
         from clinical_core.lab_import_events
         where organization_id=$1 and patient_record_id=$2 and state='accepted'
         order by received_at desc, id limit 100`,
        [clinicalUuid(context.organizationId), clinicalUuid(patientRecordId)],
      )).rows, "clinical_state_refused");
    },
  };
}

export class ClinicalStateError extends Error {
  constructor(readonly category: "request_invalid" | "clinical_state_refused" | "database_unavailable" | "specimen_context_conflict" | "specimen_consent_required") {
    super(category);
    this.name = "ClinicalStateError";
  }
}

function specimenTimestamp(value:unknown):string {
  const date=value instanceof Date?value:typeof value==="string"?new Date(value):null;
  if(!date||!Number.isFinite(date.getTime()))throw new ClinicalStateError("database_unavailable");
  return date.toISOString();
}

function validateLabImport(payload: LabResultImport) {
  const collectedAt = new Date(payload.panel.collectedAt);
  const occurredAt = new Date(payload.occurredAt);
  const range = payload.result.referenceRange;
  if (payload.schemaVersion !== "lab-result/1" || payload.provider !== "alp_patient_sync"
    || payload.source.system !== "ai_longevity_pro_v2" || payload.source.recordType !== "lab_panels"
    || !UUID.test(payload.connectionId) || !EVENT_ID.test(payload.providerEventId)
    || !EXTERNAL_ID.test(payload.source.panelId) || !EXTERNAL_ID.test(payload.source.markerId)
    || !VERSION.test(payload.resourceVersion)
    || !bounded(payload.panel.name, 1, 200) || !bounded(payload.result.name, 1, 200)
    || (payload.panel.sourceLabel !== undefined && !bounded(payload.panel.sourceLabel, 1, 200))
    || (payload.result.unit !== undefined && !bounded(payload.result.unit, 1, 80))
    || !Number.isFinite(payload.result.value)
    || (range?.min !== undefined && !Number.isFinite(range.min))
    || (range?.max !== undefined && !Number.isFinite(range.max))
    || (range?.min !== undefined && range?.max !== undefined && range.min > range.max)
    || !Number.isFinite(collectedAt.getTime()) || !Number.isFinite(occurredAt.getTime())) {
    throw new ClinicalStateError("request_invalid");
  }
}

function bounded(value: string, min: number, max: number): boolean {
  return value.trim().length >= min && value.length <= max;
}

function assertContext(
  context: ClinicalRequestContext,
  boundary: "synthetic" | "production",
  pool?: "workforce" | "consumer",
) {
  const boundaryMatches = boundary === "synthetic"
    ? context.environment === "synthetic-staging" && context.dataClassification === "synthetic_only"
      && context.containsPhi === false && context.realPatientData === false
    : context.environment === "production-clinical" && context.dataClassification === "clinical_phi"
      && context.containsPhi === true && context.realPatientData === true
      && "productionBound" in context && context.productionBound === true;
  if (context.purpose !== "clinical_data" || !boundaryMatches || (pool && context.identityPool !== pool)
    || !UUID.test(context.actorPersonId) || !UUID.test(context.organizationId)) {
    throw new ClinicalStateError("clinical_state_refused");
  }
}

async function run<T>(
  database: ClinicalCoreDatabase,
  context: ClinicalRequestContext,
  work: (tx: ClinicalCoreTransaction) => Promise<T>,
  operationRefusal: ClinicalStateError["category"],
): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
        context.identitySubject, context.purpose, context.environment, context.dataClassification,
      ]);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof ClinicalStateError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) throw new ClinicalStateError(operationRefusal);
    if (error instanceof ClinicalCoreAdapterError) throw error;
    throw new ClinicalStateError("database_unavailable");
  }
}

function first<Row extends Record<string, unknown>>(result: { rows: Row[] }): Row {
  const row = result.rows[0];
  if (!row) throw new ClinicalStateError("clinical_state_refused");
  return row;
}
