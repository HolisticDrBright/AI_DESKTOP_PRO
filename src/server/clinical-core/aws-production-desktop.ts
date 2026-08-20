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
  "list_my_organizations",
  "list_org_members",
  "set_org_member_role",
  "remove_org_member",
  "create_review_task",
  "list_review_queue",
  "resolve_review_queue_item",
  "get_desktop_calendar",
  "book_appointment",
  "update_appointment_status",
  "reschedule_appointment",
  "transition_appointment",
  "correct_appointment_status",
  "start_encounter",
  "set_encounter_status",
  "save_note_draft",
  "mark_note_ready",
  "sign_note",
  "add_note_addendum",
  "mark_note_error",
  "get_desktop_encounter",
  "list_desktop_patient_encounters",
  "get_desktop_note",
  "get_desktop_patient_timeline",
  "get_patient_overview",
  "get_patient_sync_overview",
  "get_org_sync_operations",
  "create_sync_invitation",
  "pause_sync_connection",
  "resume_sync_connection",
  "revoke_sync_connection",
  "set_sync_consent_scope",
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
  if (name === "list_my_organizations") {
    exactKeys(args, []);
    return (await tx.query("select * from clinical_core.list_my_organizations()", [])).rows;
  }
  if (name === "list_org_members") {
    exactKeys(args, ["_organization_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    return (await tx.query(
      "select * from clinical_core.list_org_members($1)",
      [clinicalUuid(context.organizationId)],
    )).rows;
  }
  if (name === "set_org_member_role") {
    exactKeys(args, ["_membership_id", "_role"]);
    const membershipId = requiredUuid(args._membership_id);
    const role = requiredString(args._role, 16);
    if (!["owner", "admin", "practitioner", "staff"].includes(role)) throw invalid();
    await tx.query(
      "select clinical_core.set_org_member_role($1,$2)",
      [clinicalUuid(membershipId), role],
    );
    return null;
  }
  if (name === "remove_org_member") {
    exactKeys(args, ["_membership_id"]);
    const membershipId = requiredUuid(args._membership_id);
    await tx.query(
      "select clinical_core.remove_org_member($1)",
      [clinicalUuid(membershipId)],
    );
    return null;
  }
  if (name === "create_review_task") {
    exactKeys(args, ["_patient_id", "_title", "_item_type", "_priority", "_ref_id"]);
    const patientId = requiredUuid(args._patient_id);
    const referenceId = optionalUuid(args._ref_id);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.create_review_task($1,$2,$3,$4,$5) as data",
      [
        clinicalUuid(patientId), requiredString(args._title, 200),
        requiredString(args._item_type, 32), requiredString(args._priority, 16),
        referenceId ? clinicalUuid(referenceId) : null,
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_review_queue") {
    exactKeys(args, ["_organization_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    return (await tx.query(
      "select * from clinical_core.list_review_queue($1)",
      [clinicalUuid(context.organizationId)],
    )).rows;
  }
  if (name === "resolve_review_queue_item") {
    exactKeys(args, ["_item_id", "_note"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.resolve_review_queue_item($1,$2) as data",
      [clinicalUuid(requiredUuid(args._item_id)), optionalString(args._note, 500)],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_desktop_calendar") {
    exactKeys(args, ["_organization_id", "_from", "_to"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_desktop_calendar($1,$2,$3) as data",
      [clinicalUuid(context.organizationId), requiredTimestamp(args._from), requiredTimestamp(args._to)],
    ));
    return decodeJson(row.data);
  }
  if (name === "book_appointment") {
    exactKeys(args, [
      "_organization_id", "_practitioner_user_id", "_appointment_type", "_starts_at", "_ends_at",
      "_patient_id", "_location", "_telehealth_url", "_title",
    ]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const patient = optionalUuid(args._patient_id);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.book_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9) as data",
      [
        clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._practitioner_user_id)),
        requiredString(args._appointment_type, 32), requiredTimestamp(args._starts_at),
        requiredTimestamp(args._ends_at), patient ? clinicalUuid(patient) : null,
        optionalString(args._location, 200), optionalString(args._telehealth_url, 2048),
        optionalString(args._title, 200),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "update_appointment_status") {
    exactKeys(args, ["_appointment_id", "_status"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.update_appointment_status($1,$2) as data",
      [clinicalUuid(requiredUuid(args._appointment_id)), requiredString(args._status, 32)],
    ));
    return decodeJson(row.data);
  }
  if (name === "reschedule_appointment") {
    exactKeys(args, ["_appointment_id", "_starts_at", "_ends_at"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.reschedule_appointment($1,$2,$3) as data",
      [
        clinicalUuid(requiredUuid(args._appointment_id)), requiredTimestamp(args._starts_at),
        requiredTimestamp(args._ends_at),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "transition_appointment") {
    exactKeys(args, ["_appointment_id", "_to_status", "_expected_version", "_idempotency_key", "_reason"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.transition_appointment($1,$2,$3,$4,$5) as data",
      [
        clinicalUuid(requiredUuid(args._appointment_id)), requiredString(args._to_status, 32),
        optionalInteger(args._expected_version, 1), optionalString(args._idempotency_key, 128),
        optionalString(args._reason, 1000),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "correct_appointment_status") {
    exactKeys(args, ["_appointment_id", "_to_status", "_reason", "_expected_version"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.correct_appointment_status($1,$2,$3,$4) as data",
      [
        clinicalUuid(requiredUuid(args._appointment_id)), requiredString(args._to_status, 32),
        requiredString(args._reason, 1000), optionalInteger(args._expected_version, 1),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "start_encounter") {
    exactKeys(args, ["_organization_id", "_patient_id", "_visit_type", "_appointment_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const appointmentId = optionalUuid(args._appointment_id);
    const row = first(await tx.query<{ id: string }>(
      "select clinical_core.start_encounter($1,$2,$3,$4) as id",
      [
        clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._patient_id)),
        requiredString(args._visit_type, 32), appointmentId ? clinicalUuid(appointmentId) : null,
      ],
    ));
    return row.id;
  }
  if (name === "set_encounter_status") {
    exactKeys(args, ["_encounter_id", "_status", "_reason"]);
    await tx.query("select clinical_core.set_encounter_status($1,$2,$3)", [
      clinicalUuid(requiredUuid(args._encounter_id)), requiredString(args._status, 32),
      optionalString(args._reason, 1000),
    ]);
    return null;
  }
  if (name === "save_note_draft") {
    exactKeys(args, [
      "_organization_id", "_encounter_id", "_note_type", "_content", "_expected_version",
      "_note_id", "_save_kind", "_provenance",
    ]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const noteId = optionalUuid(args._note_id);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.save_note_draft($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb) as data",
      [
        clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._encounter_id)),
        requiredString(args._note_type, 32), JSON.stringify(boundedNoteContent(args._content)),
        boundedInteger(args._expected_version, 0, 1_000_000), noteId ? clinicalUuid(noteId) : null,
        requiredString(args._save_kind, 16), JSON.stringify(boundedProvenance(args._provenance)),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "mark_note_ready") {
    exactKeys(args, ["_note_id"]);
    await tx.query("select clinical_core.mark_note_ready($1)", [clinicalUuid(requiredUuid(args._note_id))]);
    return null;
  }
  if (name === "sign_note") {
    exactKeys(args, ["_note_id", "_expected_version"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.sign_note($1,$2) as data",
      [clinicalUuid(requiredUuid(args._note_id)), boundedInteger(args._expected_version, 1, 1_000_000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "add_note_addendum") {
    exactKeys(args, ["_note_id", "_reason", "_content"]);
    const row = first(await tx.query<{ id: string }>(
      "select clinical_core.add_note_addendum($1,$2,$3) as id",
      [
        clinicalUuid(requiredUuid(args._note_id)), requiredString(args._reason, 500),
        requiredString(args._content, 65_536),
      ],
    ));
    return row.id;
  }
  if (name === "mark_note_error") {
    exactKeys(args, ["_note_id", "_reason"]);
    await tx.query("select clinical_core.mark_note_error($1,$2)", [
      clinicalUuid(requiredUuid(args._note_id)), requiredString(args._reason, 1000),
    ]);
    return null;
  }
  if (name === "get_desktop_encounter") {
    exactKeys(args, ["_encounter_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_desktop_encounter($1) as data",
      [clinicalUuid(requiredUuid(args._encounter_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_desktop_patient_encounters") {
    exactKeys(args, ["_patient_id", "_limit"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_desktop_patient_encounters($1,$2) as data",
      [clinicalUuid(requiredUuid(args._patient_id)), boundedInteger(args._limit, 1, 200)],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_desktop_note") {
    exactKeys(args, ["_note_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_desktop_note($1) as data",
      [clinicalUuid(requiredUuid(args._note_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_desktop_patient_timeline") {
    exactKeys(args, ["_patient_id", "_limit"]);
    return (await tx.query("select * from clinical_core.get_desktop_patient_timeline($1,$2)", [
      clinicalUuid(requiredUuid(args._patient_id)), boundedInteger(args._limit, 1, 500),
    ])).rows;
  }
  if (name === "get_patient_overview") {
    exactKeys(args, ["_organization_id", "_patient_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_patient_overview($1,$2) as data",
      [clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._patient_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_patient_sync_overview") {
    exactKeys(args, ["_patient_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_patient_sync_overview($1) as data",
      [clinicalUuid(requiredUuid(args._patient_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_org_sync_operations") {
    exactKeys(args, ["_organization_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_org_sync_operations($1) as data",
      [clinicalUuid(context.organizationId)],
    ));
    return decodeJson(row.data);
  }
  if (name === "create_sync_invitation") {
    exactKeys(args, ["_organization_id", "_patient_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.create_sync_invitation($1,$2) as data",
      [clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._patient_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "pause_sync_connection" || name === "resume_sync_connection") {
    exactKeys(args, ["_connection_id", "_expected_version"]);
    const row = first(await tx.query<{ data: unknown }>(
      `select clinical_core.${name}($1,$2) as data`,
      [clinicalUuid(requiredUuid(args._connection_id)), boundedInteger(args._expected_version, 1, 1_000_000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "revoke_sync_connection") {
    exactKeys(args, ["_connection_id", "_expected_version", "_reason"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.revoke_sync_connection($1,$2,$3) as data",
      [
        clinicalUuid(requiredUuid(args._connection_id)), boundedInteger(args._expected_version, 1, 1_000_000),
        requiredString(args._reason, 500),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "set_sync_consent_scope") {
    exactKeys(args, [
      "_connection_id", "_scope", "_grant", "_artifact_title", "_artifact_version",
      "_jurisdiction", "_method", "_authority",
    ]);
    if (typeof args._grant !== "boolean") throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.set_sync_consent_scope($1,$2,$3,$4,$5,$6,$7,$8) as data",
      [
        clinicalUuid(requiredUuid(args._connection_id)), requiredString(args._scope, 64), args._grant,
        optionalString(args._artifact_title, 200), optionalString(args._artifact_version, 64),
        optionalString(args._jurisdiction, 64), requiredString(args._method, 32),
        requiredString(args._authority, 32),
      ],
    ));
    return decodeJson(row.data);
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

function requiredUuid(value: unknown): string {
  const candidate = optionalUuid(value);
  if (!candidate) throw invalid();
  return candidate;
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
  return value as number;
}

function optionalInteger(value: unknown, min: number): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < min) throw invalid();
  return value as number;
}

function requiredTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)
    || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
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

function boundedNoteContent(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64 || entries.some(([key, content]) => !/^[A-Za-z0-9 _-]{1,60}$/.test(key)
    || typeof content !== "string" || content.length > 65_536)) throw invalid();
  if (JSON.stringify(value).length > 262_144) throw invalid();
  return Object.fromEntries(entries) as Record<string, string>;
}

function boundedProvenance(value: unknown): Array<Record<string, string | null>> {
  if (!Array.isArray(value) || value.length > 50) throw invalid();
  const allowed = new Set([
    "appointment", "encounter", "lab_observation", "lab_document", "patient_form", "chart_item",
    "practitioner_entered", "transcript", "differential_question", "lens_evaluation",
  ]);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const item = entry as Record<string, unknown>;
    exactKeys(item, ["sectionKey", "refType", "refId", "label"]);
    const refId = optionalUuid(item.refId);
    const refType = requiredString(item.refType, 32);
    if (!allowed.has(refType)) throw invalid();
    return {
      sectionKey: requiredString(item.sectionKey, 60), refType, refId,
      label: requiredString(item.label, 200),
    };
  });
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
