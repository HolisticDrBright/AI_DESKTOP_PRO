if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-consumer-clinical-records is server-only.");
}

import { createHash } from "node:crypto";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import type {
  ClinicalRequestContext,
  ProductionClinicalRequestContext,
  SyntheticRequestContext,
} from "./aws-identity-consent";

export const CONSUMER_CLINICAL_COLLECTIONS = [
  "protocols", "daily_adherence", "symptom_logs", "hormone_entries",
  "meal_logs", "subjective_rollups", "weekly_checkins",
  "wellness_profiles", "lifestyle_profiles", "contraindications",
  "questionnaire_responses", "clinical_intakes", "wearable_daily_records",
  "reproductive_profiles",
  "adverse_event_reports",
] as const;
export type ConsumerClinicalCollection = (typeof CONSUMER_CLINICAL_COLLECTIONS)[number];
export type PrivacyRequestKind = "export" | "correction" | "deletion";

export type ConsumerClinicalVersion = {
  versionId: string;
  stableRecordId: string;
  recordKey: string;
  resourceVersion: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  deleted: boolean;
  receivedAt: string;
  duplicate?: boolean;
};

export type ConsumerConsentHistory = {
  scope: string;
  status: "granted" | "revoked";
  recordedAt: string;
  version: number;
  method: string;
  representativeAuthority: string;
};

export type ConsumerPrivacyRequest = {
  requestId: string;
  kind: PrivacyRequestKind;
  status: "submitted" | "in_review" | "completed" | "rejected" | "cancelled";
  detail: string | null;
  submittedAt: string;
  resolvedAt: string | null;
};

export interface AwsClinicalRecordsAdapter<Context extends ClinicalRequestContext> {
  recordVersion(context: Context, input: {
    connectionId: string;
    stableRecordId: string;
    collection: ConsumerClinicalCollection;
    recordKey: string;
    resourceVersion: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    deleted: boolean;
  }): Promise<ConsumerClinicalVersion>;
  listRecords(context: Context, input: {
    connectionId: string;
    collection: ConsumerClinicalCollection;
    afterReceivedAt?: string;
    afterId?: string;
    limit: number;
  }): Promise<ConsumerClinicalVersion[]>;
  listConsentHistory(context: Context, connectionId: string): Promise<ConsumerConsentHistory[]>;
  submitPrivacyRequest(context: Context, input: {
    connectionId: string;
    kind: PrivacyRequestKind;
    detail?: string;
  }): Promise<ConsumerPrivacyRequest>;
  listPrivacyRequests(context: Context, connectionId: string): Promise<ConsumerPrivacyRequest[]>;
}

export type AwsConsumerClinicalRecordsAdapter = AwsClinicalRecordsAdapter<SyntheticRequestContext>;
export type AwsProductionConsumerClinicalRecordsAdapter = AwsClinicalRecordsAdapter<ProductionClinicalRequestContext>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_KEY = /^[A-Za-z0-9:_-]{1,160}$/;
const IDEMPOTENCY = /^[A-Za-z0-9:_-]{8,160}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const FORBIDDEN_KEYS = /^(authorization|cookie|password|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|secret|ssn|social[_-]?security[_-]?number|email|phone|date[_-]?of[_-]?birth)$/i;
const MAX_PAYLOAD_BYTES = 16_384;
const MAX_DEPTH = 8;
const COLLECTION_KEYS: Record<ConsumerClinicalCollection, { allowed: readonly string[]; required: readonly string[] }> = {
  protocols: {
    allowed: ["id","name","description","start_date","end_date","status","version","supplements_json","peptides_json","fasting_plan_json","lifestyle_tasks_json","generation_json"],
    required: ["id","name","start_date","status","version","supplements_json","peptides_json","lifestyle_tasks_json"],
  },
  daily_adherence: {
    allowed: ["id","date","protocol_id","completed_supplements","completed_peptides","completed_tasks","fasting_completed","notes","symptoms_json"],
    required: ["id","date","protocol_id","completed_supplements","completed_peptides","completed_tasks","fasting_completed"],
  },
  symptom_logs: {
    allowed: ["id","symptom_name","severity","logged_at","duration_minutes","notes"],
    required: ["id","symptom_name","logged_at"],
  },
  hormone_entries: {
    allowed: ["id","date","cycle_day","symptoms_json","notes","current_supplements_json"],
    required: ["id","date","symptoms_json"],
  },
  meal_logs: {
    allowed: ["id","meal_time","meal_type","calories","protein_g","carbs_g","fat_g","fiber_g","glycemic_load_estimate","inflammatory_load_estimate","food_quality_score","tags_json","notes"],
    required: ["id","meal_time","meal_type"],
  },
  subjective_rollups: {
    allowed: ["id","date","energy_avg","stress_avg","soreness_avg","mood_avg","digestion_avg","focus_avg","checkin_completion_score"],
    required: ["date"],
  },
  weekly_checkins: {
    allowed: ["id","date","weight","waistCircumference","restingHeartRate","sleepScore","wins","challenges","notes"],
    required: ["date"],
  },
  wellness_profiles: {
    allowed: ["id","height","weight","goals","onboardingCompleted","role"],
    required: ["id","goals","onboardingCompleted","role"],
  },
  lifestyle_profiles: {
    allowed: ["id","sleepHours","sleepQuality","stressLevel","dietType","cookingSkill","shoppingCadence","exerciseFrequency","exerciseTypes"],
    required: ["id","sleepHours","sleepQuality","stressLevel","dietType","exerciseFrequency","exerciseTypes"],
  },
  contraindications: {
    allowed: ["id","pregnant","pregnancyStatus","nursing","medications","allergies","conditions"],
    required: ["id","pregnant","pregnancyStatus","nursing","medications","allergies","conditions"],
  },
  questionnaire_responses: {
    allowed: ["id","questionId","categoryId","severity","timestamp"],
    required: ["id","questionId","categoryId","severity","timestamp"],
  },
  clinical_intakes: {
    allowed: ["id","chiefComplaint","associatedSymptoms","energyLevel","sleepQuality","digestiveFunction","stressPerception","temperatureSensitivity","painQuality","tcmDifferentiationResponses","createdAt","updatedAt"],
    required: ["id","chiefComplaint","associatedSymptoms","energyLevel","sleepQuality","digestiveFunction","stressPerception","temperatureSensitivity","createdAt","updatedAt"],
  },
  wearable_daily_records: {
    allowed: [
      "id","source","date","sleepDurationMinutes","sleepEfficiency","deepSleepMinutes","remSleepMinutes",
      "lightSleepMinutes","sleepLatencyMinutes","wakeAfterSleepOnset","awakenings","sleepScore","bedtime",
      "wakeTime","hrv","restingHr","avgHr","nighttimeHr","respiratoryRate","tempDeviation","skinTemp",
      "readinessScore","stressScoreDevice","steps","distanceKm","caloriesBurned","activeMinutes",
      "sedentaryMinutes","vo2Max","workoutMinutes","workoutType","trainingLoad","strainScore","weight",
      "bodyFatPercent","spo2","glucoseAvg","bloodPressureSystolic","bloodPressureDiastolic","cyclePhase",
      "cycleDayEstimate","hydrationMl","alcoholUnits","caffeineMg","caffeineLastTime","energyScore",
      "stressScoreSubjective","sorenessScore","moodScore","libidoScore","bowelScore","cravingsScore",
      "adherenceScore","subjectiveReadiness","symptomFlags","dataQualityScore",
    ],
    required: ["id","source","date","dataQualityScore"],
  },
  reproductive_profiles: {
    allowed: ["id","consent","stage","typicalCycleLength","cycleDay","postpartumWeeks","updatedAt"],
    required: ["id","consent","stage","updatedAt"],
  },
  adverse_event_reports: {
    allowed: ["id","event_type","symptom","severity","onset_at","suspected_product_id","suspected_product_name","actions_taken","notes","safety_answers"],
    required: ["id","event_type","symptom","severity","onset_at","actions_taken","safety_answers"],
  },
};

export function createAwsConsumerClinicalRecordsAdapter(database: ClinicalCoreDatabase): AwsConsumerClinicalRecordsAdapter {
  return createAwsClinicalRecordsAdapter(database, "synthetic");
}

export function createAwsProductionConsumerClinicalRecordsAdapter(
  database: ClinicalCoreDatabase,
): AwsProductionConsumerClinicalRecordsAdapter {
  return createAwsClinicalRecordsAdapter(database, "production");
}

function createAwsClinicalRecordsAdapter<Context extends ClinicalRequestContext>(
  database: ClinicalCoreDatabase,
  boundary: "synthetic" | "production",
): AwsClinicalRecordsAdapter<Context> {
  return {
    async recordVersion(context, input) {
      assertContext(context, boundary, "clinical_data");
      if (!UUID.test(input.connectionId) || !UUID.test(input.stableRecordId)
        || !CONSUMER_CLINICAL_COLLECTIONS.includes(input.collection)
        || !EXTERNAL_KEY.test(input.recordKey) || !VERSION.test(input.resourceVersion)
        || !IDEMPOTENCY.test(input.idempotencyKey) || typeof input.deleted !== "boolean") {
        throw new ConsumerClinicalError("request_invalid");
      }
      validateCollectionPayload(input.collection, input.payload);
      const canonical = canonicalPayload(input.payload);
      const sha256 = createHash("sha256").update(canonical).digest("hex");
      const row = await run(database, context, async (tx) => first(await tx.query<VersionRow>(
        "select * from clinical_core.record_consumer_clinical_version($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
        [clinicalUuid(input.connectionId), clinicalUuid(input.stableRecordId), input.collection,
          input.recordKey, input.resourceVersion, input.idempotencyKey, canonical, sha256, input.deleted],
      )));
      return versionFromRow(row, input.payload, sha256);
    },

    async listRecords(context, input) {
      assertContext(context, boundary, "clinical_data");
      if (!UUID.test(input.connectionId) || !CONSUMER_CLINICAL_COLLECTIONS.includes(input.collection)
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200
        || (input.afterId !== undefined && !UUID.test(input.afterId))
        || (input.afterReceivedAt !== undefined && !validDate(input.afterReceivedAt))
        || ((input.afterId === undefined) !== (input.afterReceivedAt === undefined))) {
        throw new ConsumerClinicalError("request_invalid");
      }
      const rows = await run(database, context, async (tx) => (await tx.query<VersionRow>(
        "select * from clinical_core.list_consumer_clinical_records($1,$2,$3::timestamptz,$4::uuid,$5::integer)",
        [clinicalUuid(input.connectionId), input.collection, input.afterReceivedAt ?? null,
          input.afterId ? clinicalUuid(input.afterId) : null, input.limit],
      )).rows);
      return rows.map((row) => versionFromRow(row));
    },

    async listConsentHistory(context, connectionId) {
      assertContext(context, boundary, "consent_management");
      if (!UUID.test(connectionId)) throw new ConsumerClinicalError("request_invalid");
      const rows = await run(database, context, async (tx) => (await tx.query<ConsentRow>(
        "select * from clinical_core.list_consumer_consent_history($1)", [clinicalUuid(connectionId)],
      )).rows);
      return rows.map((row) => ({
        scope: row.scope, status: row.status, recordedAt: row.recorded_at,
        version: row.version, method: row.method,
        representativeAuthority: row.representative_authority,
      }));
    },

    async submitPrivacyRequest(context, input) {
      assertContext(context, boundary, "consent_management");
      if (!UUID.test(input.connectionId) || !["export", "correction", "deletion"].includes(input.kind)
        || (input.detail !== undefined && (input.detail.trim().length < 1 || input.detail.length > 1000))) {
        throw new ConsumerClinicalError("request_invalid");
      }
      return privacyFromRow(await run(database, context, async (tx) => first(await tx.query<PrivacyRow>(
        "select * from clinical_core.submit_privacy_request($1,$2,$3)",
        [clinicalUuid(input.connectionId), input.kind, input.detail ?? null],
      ))));
    },

    async listPrivacyRequests(context, connectionId) {
      assertContext(context, boundary, "consent_management");
      if (!UUID.test(connectionId)) throw new ConsumerClinicalError("request_invalid");
      const rows = await run(database, context, async (tx) => (await tx.query<PrivacyRow>(
        "select * from clinical_core.list_consumer_privacy_requests($1)", [clinicalUuid(connectionId)],
      )).rows);
      return rows.map(privacyFromRow);
    },
  };
}

export class ConsumerClinicalError extends Error {
  constructor(readonly category: "request_invalid" | "clinical_record_refused" | "consent_required" | "conflict" | "database_unavailable") {
    super(category);
    this.name = "ConsumerClinicalError";
  }
}

type VersionRow = {
  version_id: string; stable_record_id: string; record_key: string;
  resource_version: string; payload?: unknown; payload_sha256?: string;
  deleted?: boolean; received_at: string; duplicate?: boolean;
};
type ConsentRow = { scope: string; status: "granted" | "revoked"; recorded_at: string; version: number; method: string; representative_authority: string };
type PrivacyRow = { request_id: string; kind: PrivacyRequestKind; status: ConsumerPrivacyRequest["status"]; detail: string | null; submitted_at: string; resolved_at: string | null };

function versionFromRow(row: VersionRow, originalPayload?: Record<string, unknown>, originalSha?: string): ConsumerClinicalVersion {
  const payload = originalPayload ?? parsePayload(row.payload);
  return {
    versionId: row.version_id,
    stableRecordId: row.stable_record_id,
    recordKey: row.record_key,
    resourceVersion: row.resource_version,
    payload,
    payloadSha256: row.payload_sha256 ?? originalSha ?? createHash("sha256").update(canonicalPayload(payload)).digest("hex"),
    deleted: row.deleted ?? false,
    receivedAt: row.received_at,
    ...(row.duplicate !== undefined ? { duplicate: row.duplicate } : {}),
  };
}

function privacyFromRow(row: PrivacyRow): ConsumerPrivacyRequest {
  return { requestId: row.request_id, kind: row.kind, status: row.status,
    detail: row.detail, submittedAt: row.submitted_at, resolvedAt: row.resolved_at };
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    canonicalPayload(parsed as Record<string, unknown>);
    return parsed as Record<string, unknown>;
  } catch {
    throw new ConsumerClinicalError("database_unavailable");
  }
}

export function canonicalPayload(value: Record<string, unknown>): string {
  validateValue(value, 0);
  const canonical = canonicalJson(value);
  if (Buffer.byteLength(canonical, "utf8") > MAX_PAYLOAD_BYTES) throw new ConsumerClinicalError("request_invalid");
  return canonical;
}

export function validateCollectionPayload(collection: ConsumerClinicalCollection, value: Record<string, unknown>): void {
  const schema = COLLECTION_KEYS[collection];
  const keys = Object.keys(value);
  if (keys.some((key) => !schema.allowed.includes(key)) || schema.required.some((key) => !(key in value))) {
    throw new ConsumerClinicalError("request_invalid");
  }
  const id = value.id;
  if (id !== undefined && (typeof id !== "string" || id.length < 1 || id.length > 160)) {
    throw new ConsumerClinicalError("request_invalid");
  }
  for (const key of ["date", "start_date", "end_date", "logged_at", "meal_time"] as const) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null
      && (typeof candidate !== "string" || candidate.length > 40 || !Number.isFinite(new Date(candidate).getTime()))) {
      throw new ConsumerClinicalError("request_invalid");
    }
  }
  if (collection === "adverse_event_reports") {
    if (!["new_symptom", "possible_adverse_reaction"].includes(String(value.event_type))
      || typeof value.symptom !== "string" || value.symptom.trim().length < 2 || value.symptom.length > 200
      || !Number.isInteger(value.severity) || Number(value.severity) < 1 || Number(value.severity) > 10
      || typeof value.onset_at !== "string" || !validDate(value.onset_at)
      || !Array.isArray(value.actions_taken) || value.actions_taken.length > 20
      || !value.safety_answers || typeof value.safety_answers !== "object" || Array.isArray(value.safety_answers)) {
      throw new ConsumerClinicalError("request_invalid");
    }
  }
  canonicalPayload(value);
}

function validateValue(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new ConsumerClinicalError("request_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConsumerClinicalError("request_invalid");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new ConsumerClinicalError("request_invalid");
    value.forEach((entry) => validateValue(entry, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new ConsumerClinicalError("request_invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) throw new ConsumerClinicalError("request_invalid");
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || FORBIDDEN_KEYS.test(key)) {
      throw new ConsumerClinicalError("request_invalid");
    }
    validateValue(entry, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function validDate(value: string): boolean {
  return value.length <= 40 && Number.isFinite(new Date(value).getTime());
}

function assertContext(
  context: ClinicalRequestContext,
  boundary: "synthetic" | "production",
  purpose: "clinical_data" | "consent_management",
) {
  const boundaryMatches = boundary === "synthetic"
    ? context.environment === "synthetic-staging" && context.dataClassification === "synthetic_only"
      && context.containsPhi === false && context.realPatientData === false
    : context.environment === "production-clinical" && context.dataClassification === "clinical_phi"
      && context.containsPhi === true && context.realPatientData === true
      && "productionBound" in context && context.productionBound === true;
  if (context.identityPool !== "consumer" || context.purpose !== purpose
    || !boundaryMatches
    || !UUID.test(context.actorPersonId) || !UUID.test(context.organizationId)) {
    throw new ConsumerClinicalError("clinical_record_refused");
  }
}

async function run<T>(database: ClinicalCoreDatabase, context: ClinicalRequestContext, work: (tx: ClinicalCoreTransaction) => Promise<T>): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
        context.identitySubject, context.purpose, context.environment, context.dataClassification,
      ]);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof ConsumerClinicalError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) {
      throw new ConsumerClinicalError(error.category === "identity_refused" ? "clinical_record_refused" : "consent_required");
    }
    throw new ConsumerClinicalError("database_unavailable");
  }
}

function first<Row extends Record<string, unknown>>(result: { rows: Row[] }): Row {
  const row = result.rows[0];
  if (!row) throw new ConsumerClinicalError("clinical_record_refused");
  return row;
}
