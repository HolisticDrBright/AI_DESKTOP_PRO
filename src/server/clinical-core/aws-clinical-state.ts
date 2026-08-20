if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-clinical-state is server-only.");
}

import { createHash } from "node:crypto";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import { ClinicalCoreAdapterError, type SyntheticRequestContext } from "./aws-identity-consent";

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
};

export type LabReviewResult = {
  eventId: string;
  state: "accepted" | "rejected";
  observationId?: string;
  duplicate: boolean;
};

export interface AwsSyntheticClinicalStateAdapter {
  getConsumerConnection(context: SyntheticRequestContext): Promise<{
    connectionId: string;
    patientRecordId: string;
    state: "verified" | "paused";
    verifiedAt: string;
    labResultsImportConsent: "granted" | "revoked" | "not_granted";
  } | null>;
  importLabResult(context: SyntheticRequestContext, payload: LabResultImport): Promise<LabImportResult>;
  reviewLabResult(context: SyntheticRequestContext, input: {
    eventId: string;
    decision: "accept" | "reject";
    note?: string;
  }): Promise<LabReviewResult>;
  listLabImports(context: SyntheticRequestContext, state: LabImportResult["state"]): Promise<Record<string, unknown>[]>;
  listPatientLabObservations(context: SyntheticRequestContext, patientRecordId: string): Promise<Record<string, unknown>[]>;
  listDesktopPatients?(context: SyntheticRequestContext, patientRecordId?: string): Promise<Record<string, unknown>[]>;
  listDesktopLabDocuments?(context: SyntheticRequestContext, patientRecordId: string): Promise<Record<string, unknown>[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const EVENT_ID = /^[A-Za-z0-9:_-]{8,160}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

export function createAwsSyntheticClinicalStateAdapter(database: ClinicalCoreDatabase): AwsSyntheticClinicalStateAdapter {
  return {
    async getConsumerConnection(context) {
      assertContext(context, "consumer");
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
      assertContext(context, "consumer");
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
        "select * from clinical_core.record_lab_import($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17)",
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
      return { eventId: row.event_id, state: row.state, duplicate: row.duplicate };
    },

    async reviewLabResult(context, input) {
      assertContext(context, "workforce");
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
      assertContext(context, "workforce");
      if (!["review_pending", "conflict", "accepted", "rejected"].includes(state)) {
        throw new ClinicalStateError("request_invalid");
      }
      return run(database, context, async (tx) => (await tx.query(
        "select * from clinical_core.list_lab_imports($1)", [state],
      )).rows, "clinical_state_refused");
    },

    async listPatientLabObservations(context, patientRecordId) {
      assertContext(context);
      if (!UUID.test(patientRecordId)) throw new ClinicalStateError("request_invalid");
      return run(database, context, async (tx) => (await tx.query(
        "select * from clinical_core.list_patient_lab_observations($1)", [clinicalUuid(patientRecordId)],
      )).rows, "clinical_state_refused");
    },
    async listDesktopPatients(context, patientRecordId) {
      assertContext(context, "workforce");
      if (patientRecordId !== undefined && !UUID.test(patientRecordId)) throw new ClinicalStateError("request_invalid");
      return run(database, context, async (tx) => (await tx.query(
        `select id, organization_id, synthetic_record_key as mrn,
           'Synthetic'::text as first_name, synthetic_record_key as last_name,
           null::date as date_of_birth, null::text as sex, status
         from clinical_core.patient_records
         where organization_id=$1 and ($2::uuid is null or id=$2)
         order by synthetic_record_key, id limit 1000`,
        [clinicalUuid(context.organizationId), patientRecordId ? clinicalUuid(patientRecordId) : null],
      )).rows, "clinical_state_refused");
    },
    async listDesktopLabDocuments(context, patientRecordId) {
      assertContext(context, "workforce");
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
  constructor(readonly category: "request_invalid" | "clinical_state_refused" | "database_unavailable") {
    super(category);
    this.name = "ClinicalStateError";
  }
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

function assertContext(context: SyntheticRequestContext, pool?: "workforce" | "consumer") {
  if (context.purpose !== "clinical_data" || context.environment !== "synthetic-staging"
    || context.dataClassification !== "synthetic_only" || context.containsPhi !== false
    || context.realPatientData !== false || (pool && context.identityPool !== pool)
    || !UUID.test(context.actorPersonId) || !UUID.test(context.organizationId)) {
    throw new ClinicalStateError("clinical_state_refused");
  }
}

async function run<T>(
  database: ClinicalCoreDatabase,
  context: SyntheticRequestContext,
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
