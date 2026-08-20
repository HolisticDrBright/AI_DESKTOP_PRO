if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-production-desktop is server-only.");
}

import {
  createAwsDesktopCompatibilityAdapter,
  type DesktopCompatibilityAdapter,
} from "./aws-desktop-compatibility";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";

export type ProductionRequestContext = ProductionClinicalRequestContext;

export type AwsProductionDesktopAdapter = DesktopCompatibilityAdapter<ProductionRequestContext>;

export class ProductionDesktopError extends Error {
  constructor(readonly category: "request_invalid" | "operation_refused" | "database_unavailable") {
    super(category);
    this.name = "ProductionDesktopError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORE_RPCS = new Set([
  "create_patient_profile",
  "review_biomarker",
  "list_patient_lab_observations",
  "record_registered_audit_event",
  "list_audit_events",
]);
const CORE_SELECTS = new Set(["patient_profiles", "lab_documents"]);

export function createAwsProductionDesktopAdapter(
  database: ClinicalCoreDatabase,
  fallback: DesktopCompatibilityAdapter = createAwsDesktopCompatibilityAdapter(database),
): AwsProductionDesktopAdapter {
  return {
    async execute(context, request) {
      assertContext(context);
      if (request.kind === "rpc" && CORE_RPCS.has(request.functionName)) {
        return run(database, context, (tx) => executeCoreRpc(tx, context, request.functionName, request.args));
      }
      if (request.kind === "select" && CORE_SELECTS.has(request.table)) {
        return run(database, context, (tx) => executeCoreSelect(tx, context, request.table, request.query));
      }
      try {
        return await fallback.execute(context, request);
      } catch (error) {
        if (error instanceof ClinicalCoreDatabaseRejection) throw new ProductionDesktopError("operation_refused");
        throw new ProductionDesktopError("operation_refused");
      }
    },
  };
}

async function executeCoreRpc(
  tx: ClinicalCoreTransaction,
  context: ProductionRequestContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "create_patient_profile") {
    exactKeys(args, [
      "_organization_id", "_first_name", "_last_name", "_date_of_birth",
      "_sex", "_mrn", "_email", "_phone",
    ]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      `select clinical_core.create_patient_profile(
        $1,$2,$3,$4::date,$5,$6,$7,$8
      ) as data`,
      [
        clinicalUuid(context.organizationId), requiredString(args._first_name, 100),
        requiredString(args._last_name, 100), optionalDate(args._date_of_birth),
        requiredString(args._sex, 16), optionalString(args._mrn, 64),
        optionalString(args._email, 320), optionalString(args._phone, 40),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "review_biomarker") {
    exactKeys(args, ["_observation_id", "_decision", "_note"]);
    const observationId = requiredString(args._observation_id, 36);
    const decision = requiredString(args._decision, 16);
    if (!UUID.test(observationId) || !["accepted", "flagged", "rejected"].includes(decision)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.review_biomarker($1,$2,$3) as data",
      [clinicalUuid(observationId), decision, optionalString(args._note, 500)],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_patient_lab_observations") {
    exactKeys(args, ["_organization_id", "_patient_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const patientId = requiredString(args._patient_id, 36);
    if (!UUID.test(patientId)) throw invalid();
    return (await tx.query(
      "select * from clinical_core.list_patient_lab_observations($1)",
      [clinicalUuid(patientId)],
    )).rows;
  }
  if (name === "record_registered_audit_event") {
    exactKeys(args, ["_organization_id", "_event_type", "_resource_id", "_patient_id", "_metadata"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const patientId = optionalUuid(args._patient_id);
    const metadata = boundedScalarMetadata(args._metadata);
    const row = first(await tx.query<{ id: string }>(
      "select clinical_core.record_registered_audit_event($1,$2,$3,$4,$5::jsonb) as id",
      [
        clinicalUuid(context.organizationId), requiredString(args._event_type, 64),
        optionalString(args._resource_id, 128), patientId ? clinicalUuid(patientId) : null,
        JSON.stringify(metadata),
      ],
    ));
    return row.id;
  }
  if (name === "list_audit_events") {
    exactKeys(args, ["_organization_id", "_limit"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const limit = boundedInteger(args._limit, 1, 200);
    return (await tx.query(
      "select * from clinical_core.list_audit_events($1,$2)",
      [clinicalUuid(context.organizationId), limit],
    )).rows;
  }
  throw new ProductionDesktopError("operation_refused");
}

async function executeCoreSelect(
  tx: ClinicalCoreTransaction,
  context: ProductionRequestContext,
  table: string,
  query: string,
): Promise<unknown> {
  const params = new URLSearchParams(query);
  if (params.get("organization_id") !== `eq.${context.organizationId}`) throw invalid();
  if (table === "patient_profiles") {
    const patientId = equalityUuid(params.get("id"));
    return (await tx.query(
      `select id, organization_id, mrn, first_name, last_name, date_of_birth,
        sex, status from clinical_core.patient_records
       where organization_id=$1 and deleted_at is null
         and ($2::uuid is null or id=$2)
       order by last_name, first_name, id limit 1000`,
      [clinicalUuid(context.organizationId), patientId ? clinicalUuid(patientId) : null],
    )).rows;
  }
  if (table === "lab_documents") {
    const patientId = equalityUuid(params.get("patient_id"), true)!;
    return (await tx.query(
      `select id, 'AI Longevity Pro import'::text as file_name,
        coalesce(source_label,'AI Longevity Pro') as lab_company,
        panel_name, collected_at::date as lab_date, received_at as created_at
       from clinical_core.lab_import_events
       where organization_id=$1 and patient_record_id=$2 and state='accepted'
       order by received_at desc, id limit 20`,
      [clinicalUuid(context.organizationId), clinicalUuid(patientId)],
    )).rows;
  }
  throw new ProductionDesktopError("operation_refused");
}

async function run<T>(
  database: ClinicalCoreDatabase,
  context: ProductionRequestContext,
  work: (tx: ClinicalCoreTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId),
        context.identityPool, context.identitySubject, context.purpose,
        context.environment, context.dataClassification,
      ]);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof ProductionDesktopError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) throw new ProductionDesktopError("operation_refused");
    throw new ProductionDesktopError("database_unavailable");
  }
}

function assertContext(context: ProductionRequestContext) {
  if (context.environment !== "production-clinical" || context.dataClassification !== "clinical_phi"
    || context.containsPhi !== true || context.realPatientData !== true || context.productionBound !== true
    || context.identityPool !== "workforce" || context.purpose !== "clinical_data"
    || !UUID.test(context.actorPersonId) || !UUID.test(context.organizationId)
    || !/^[A-Za-z0-9:_-]{8,128}$/.test(context.identitySubject)) throw invalid();
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw invalid();
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) throw invalid();
  return value;
}

function optionalString(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, max);
}

function optionalDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(new Date(`${value}T00:00:00Z`).getTime())) throw invalid();
  return value;
}

function equalityUuid(value: string | null, required = false): string | undefined {
  if (!value) {
    if (required) throw invalid();
    return undefined;
  }
  const candidate = value.startsWith("eq.") ? value.slice(3) : "";
  if (!UUID.test(candidate)) throw invalid();
  return candidate;
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value;
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
  return value as number;
}

function boundedScalarMetadata(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw invalid();
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)
      || !["string", "number", "boolean"].includes(typeof item)
      || (typeof item === "string" && item.length > 256)
      || (typeof item === "number" && !Number.isFinite(item))) throw invalid();
  }
  if (JSON.stringify(value).length > 2048) throw invalid();
  return Object.fromEntries(entries) as Record<string, string | number | boolean>;
}

function first<Row extends Record<string, unknown>>(result: { rows: Row[] }): Row {
  const row = result.rows[0];
  if (!row) throw new ProductionDesktopError("operation_refused");
  return row;
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new ProductionDesktopError("operation_refused"); }
}

function invalid(): ProductionDesktopError {
  return new ProductionDesktopError("request_invalid");
}
