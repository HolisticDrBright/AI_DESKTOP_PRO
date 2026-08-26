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
  "get_patient_app_intake",
  "get_patient_sync_overview",
  "get_org_sync_operations",
  "create_sync_invitation",
  "pause_sync_connection",
  "resume_sync_connection",
  "revoke_sync_connection",
  "set_sync_consent_scope",
  "queue_sync_export",
  "withdraw_sync_resource",
  "retry_sync_event",
  "cancel_sync_event",
  "resolve_sync_conflict",
  "review_sync_inbound",
  "record_sync_inbound_correction",
  "get_patient_protocol",
  "create_protocol_draft",
  "save_protocol_draft",
  "approve_protocol_version",
  "activate_protocol_version",
  "set_protocol_lifecycle",
  "revise_protocol_version",
  "get_product_catalog",
  "get_product_label_detail",
  "verify_product_label_version",
  "get_protocol_template_detail",
  "compare_protocol_template_versions",
  "record_protocol_template_safety_review",
  "supersede_protocol_template",
  "list_protocol_templates",
  "create_protocol_template",
  "approve_protocol_template_version",
  "archive_protocol_template",
  "search_protocol_catalog",
  "check_protocol_interactions",
  "review_protocol_item_interactions",
  "get_reasoning_workspace",
  "review_hypothesis",
  "list_desktop_lens_paradigms",
  "list_desktop_lens_domains",
  "list_desktop_lens_knowledge_sources",
  "get_desktop_lens_evaluation",
  "list_desktop_question_answers",
  "set_question_status",
  "dismiss_question",
  "answer_question",
  "correct_question_answer",
  "record_question_note_use",
  "submit_question_feedback",
  "review_safety_block",
  "create_clinical_pathway_draft",
  "update_clinical_pathway_draft",
  "approve_clinical_pathway_version",
  "stage_clinical_knowledge_import",
  "review_clinical_knowledge_import_item",
]);
const CORE_SELECTS = new Set([
  "patient_profiles",
  "lab_documents",
  "clinical_pathways",
  "clinical_knowledge_import_batches",
  "clinical_knowledge_import_items",
]);

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
  if (name === "get_patient_app_intake") {
    exactKeys(args, ["_organization_id", "_patient_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_patient_app_intake($1,$2) as data",
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
  if (name === "queue_sync_export") {
    exactKeys(args, ["_connection_id", "_resource_type", "_resource_id"]);
    const resourceType = requiredString(args._resource_type, 32);
    if (!["protocol_version", "appointment_summary", "lab_summary"].includes(resourceType)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.queue_sync_export($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._connection_id)), resourceType, clinicalUuid(requiredUuid(args._resource_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "withdraw_sync_resource") {
    exactKeys(args, ["_connection_id", "_resource_type", "_resource_id", "_reason"]);
    const resourceType = requiredString(args._resource_type, 32);
    if (!["protocol_version", "appointment_summary", "lab_summary"].includes(resourceType)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.withdraw_sync_resource($1,$2,$3,$4) as data",
      [clinicalUuid(requiredUuid(args._connection_id)), resourceType,
        clinicalUuid(requiredUuid(args._resource_id)), requiredString(args._reason, 500)],
    ));
    return decodeJson(row.data);
  }
  if (name === "retry_sync_event" || name === "cancel_sync_event") {
    exactKeys(args, ["_event_id", "_reason"]);
    const row = first(await tx.query<{ data: unknown }>(
      `select clinical_core.${name}($1,$2) as data`,
      [clinicalUuid(requiredUuid(args._event_id)), requiredString(args._reason, 500)],
    ));
    return decodeJson(row.data);
  }
  if (name === "resolve_sync_conflict") {
    exactKeys(args, ["_conflict_id", "_resolution", "_note", "_expected_version"]);
    const resolution = requiredString(args._resolution, 32);
    if (!["resolved_keep_desktop", "resolved_keep_external", "resolved_manual", "dismissed"].includes(resolution)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.resolve_sync_conflict($1,$2,$3,$4) as data",
      [clinicalUuid(requiredUuid(args._conflict_id)), resolution, requiredString(args._note, 1000),
        boundedInteger(args._expected_version, 1, 1_000_000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "review_sync_inbound") {
    exactKeys(args, ["_event_id", "_action", "_note"]);
    const action = requiredString(args._action, 16);
    if (!["accept", "reject"].includes(action)) throw invalid();
    const note = action === "reject" ? requiredString(args._note, 500) : optionalString(args._note, 500);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.review_sync_inbound($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._event_id)), action, note],
    ));
    return decodeJson(row.data);
  }
  if (name === "record_sync_inbound_correction") {
    exactKeys(args, ["_inbound_event_id", "_overlay", "_reason"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.record_sync_inbound_correction($1,$2::jsonb,$3) as data",
      [clinicalUuid(requiredUuid(args._inbound_event_id)), JSON.stringify(boundedCorrectionOverlay(args._overlay)),
        requiredString(args._reason, 1000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_patient_protocol") {
    exactKeys(args, ["_organization_id", "_patient_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_patient_protocol($1,$2) as data",
      [clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._patient_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "create_protocol_draft") {
    exactKeys(args, ["_organization_id", "_patient_id", "_title", "_from_template_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const templateId = optionalUuid(args._from_template_id);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.create_protocol_draft($1,$2,$3,$4) as data",
      [
        clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._patient_id)),
        requiredString(args._title, 200), templateId ? clinicalUuid(templateId) : null,
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "save_protocol_draft") {
    exactKeys(args, ["_version_id", "_payload", "_expected_updated_at"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.save_protocol_draft($1,$2::jsonb,$3) as data",
      [
        clinicalUuid(requiredUuid(args._version_id)), JSON.stringify(boundedProtocolPayload(args._payload)),
        optionalTimestamp(args._expected_updated_at),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "approve_protocol_version") {
    exactKeys(args, ["_version_id", "_review_note"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.approve_protocol_version($1,$2) as data",
      [clinicalUuid(requiredUuid(args._version_id)), optionalString(args._review_note, 2000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "activate_protocol_version") {
    exactKeys(args, ["_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.activate_protocol_version($1) as data",
      [clinicalUuid(requiredUuid(args._version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "set_protocol_lifecycle") {
    exactKeys(args, ["_protocol_id", "_status", "_reason"]);
    const status = requiredString(args._status, 16);
    if (!["active", "paused", "completed", "discontinued"].includes(status)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.set_protocol_lifecycle($1,$2,$3) as data",
      [
        clinicalUuid(requiredUuid(args._protocol_id)), status,
        optionalString(args._reason, 1000),
      ],
    ));
    return decodeJson(row.data);
  }
  if (name === "revise_protocol_version") {
    exactKeys(args, ["_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.revise_protocol_version($1) as data",
      [clinicalUuid(requiredUuid(args._version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_product_catalog") {
    exactKeys(args, ["_organization_id", "_query", "_status", "_limit"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const status = optionalString(args._status, 20);
    if (status !== null && !["draft", "published", "superseded", "withdrawn"].includes(status)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_product_catalog($1,$2,$3,$4) as data",
      [clinicalUuid(context.organizationId), optionalString(args._query, 200), status,
        args._limit === null ? null : boundedInteger(args._limit, 1, 500)],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_product_label_detail") {
    exactKeys(args, ["_label_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_product_label_detail($1) as data",
      [clinicalUuid(requiredUuid(args._label_version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "verify_product_label_version") {
    exactKeys(args, ["_label_version_id", "_verification_note"]);
    await tx.query("select clinical_core.verify_product_label_version($1,$2)", [
      clinicalUuid(requiredUuid(args._label_version_id)), requiredString(args._verification_note, 2000),
    ]);
    return null;
  }
  if (name === "get_protocol_template_detail") {
    exactKeys(args, ["_template_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_protocol_template_detail($1) as data",
      [requiredCatalogId(args._template_id, "tpl")],
    ));
    return decodeJson(row.data);
  }
  if (name === "compare_protocol_template_versions") {
    exactKeys(args, ["_left_version_id", "_right_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.compare_protocol_template_versions($1,$2) as data",
      [clinicalUuid(requiredUuid(args._left_version_id)), clinicalUuid(requiredUuid(args._right_version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "record_protocol_template_safety_review") {
    exactKeys(args, ["_version_id", "_outcome", "_note"]);
    const outcome = requiredString(args._outcome, 16);
    if (!["passed", "concerns", "blocked"].includes(outcome)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.record_protocol_template_safety_review($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._version_id)), outcome, requiredString(args._note, 2000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "supersede_protocol_template") {
    exactKeys(args, ["_template_id", "_successor_template_id", "_reason"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.supersede_protocol_template($1,$2,$3) as data",
      [requiredCatalogId(args._template_id, "tpl"), requiredCatalogId(args._successor_template_id, "tpl"),
        requiredString(args._reason, 2000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_protocol_templates") {
    exactKeys(args, ["_organization_id", "_include_archived"]);
    if (args._organization_id !== context.organizationId || typeof args._include_archived !== "boolean") throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_protocol_templates($1,$2) as data",
      [clinicalUuid(context.organizationId), args._include_archived],
    ));
    return decodeJson(row.data);
  }
  if (name === "create_protocol_template") {
    exactKeys(args, ["_organization_id", "_name", "_description", "_from_version_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const sourceVersionId = optionalUuid(args._from_version_id);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.create_protocol_template($1,$2,$3,$4) as data",
      [clinicalUuid(context.organizationId), requiredString(args._name, 200),
        optionalString(args._description, 10_000), sourceVersionId ? clinicalUuid(sourceVersionId) : null],
    ));
    return decodeJson(row.data);
  }
  if (name === "approve_protocol_template_version") {
    exactKeys(args, ["_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.approve_protocol_template_version($1) as data",
      [clinicalUuid(requiredUuid(args._version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "archive_protocol_template") {
    exactKeys(args, ["_template_id", "_archived"]);
    if (typeof args._archived !== "boolean") throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.archive_protocol_template($1,$2) as data",
      [clinicalUuid(requiredUuid(args._template_id)), args._archived],
    ));
    return decodeJson(row.data);
  }
  if (name === "search_protocol_catalog") {
    exactKeys(args, ["_organization_id", "_query", "_limit"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.search_protocol_catalog($1,$2,$3) as data",
      [clinicalUuid(context.organizationId), optionalString(args._query, 200), boundedInteger(args._limit, 1, 100)],
    ));
    return decodeJson(row.data);
  }
  if (name === "check_protocol_interactions") {
    exactKeys(args, ["_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.check_protocol_interactions($1) as data",
      [clinicalUuid(requiredUuid(args._version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "review_protocol_item_interactions") {
    exactKeys(args, ["_item_id", "_note"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.review_protocol_item_interactions($1,$2) as data",
      [clinicalUuid(requiredUuid(args._item_id)), optionalString(args._note, 2000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_reasoning_workspace") {
    exactKeys(args, ["_organization_id", "_patient_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_reasoning_workspace($1,$2) as data",
      [clinicalUuid(context.organizationId), clinicalUuid(requiredUuid(args._patient_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "review_hypothesis") {
    exactKeys(args, ["_hypothesis_id", "_action", "_note"]);
    const action = requiredString(args._action, 16);
    if (!["accepted", "rejected", "needs_data"].includes(action)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.review_hypothesis($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._hypothesis_id)), action, optionalString(args._note, 2000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_desktop_lens_paradigms" || name === "list_desktop_lens_domains"
    || name === "list_desktop_lens_knowledge_sources") {
    exactKeys(args, []);
    const row = first(await tx.query<{ data: unknown }>(`select clinical_core.${name}() as data`, []));
    return decodeJson(row.data);
  }
  if (name === "get_desktop_lens_evaluation") {
    exactKeys(args, ["_encounter_id", "_paradigm"]);
    const paradigm = requiredString(args._paradigm, 32);
    if (!["western_conventional", "functional", "naturopathic", "tcm", "biohacking", "synergistic"].includes(paradigm)) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_desktop_lens_evaluation($1,$2) as data",
      [clinicalUuid(requiredUuid(args._encounter_id)), paradigm],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_desktop_question_answers") {
    exactKeys(args, ["_question_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_desktop_question_answers($1) as data",
      [clinicalUuid(requiredUuid(args._question_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "set_question_status") {
    exactKeys(args, ["_question_id", "_to", "_reason"]);
    const action = requiredString(args._to, 16);
    if (!["accepted", "asked", "deferred", "skipped"].includes(action)) throw invalid();
    await tx.query("select clinical_core.set_question_status($1,$2,$3)", [
      clinicalUuid(requiredUuid(args._question_id)), action, optionalString(args._reason, 2000),
    ]);
    return null;
  }
  if (name === "dismiss_question") {
    exactKeys(args, ["_question_id", "_feedback_kind", "_comment"]);
    const kind = questionFeedbackKind(args._feedback_kind);
    await tx.query("select clinical_core.dismiss_question($1,$2,$3)", [
      clinicalUuid(requiredUuid(args._question_id)), kind, optionalString(args._comment, 2000),
    ]);
    return null;
  }
  if (name === "answer_question") {
    exactKeys(args, ["_question_id", "_answer"]);
    const row = first(await tx.query<{ data: number }>(
      "select clinical_core.answer_question($1,$2::jsonb) as data",
      [clinicalUuid(requiredUuid(args._question_id)), JSON.stringify(boundedJsonObject(args._answer, 16_384))],
    ));
    return Number(row.data);
  }
  if (name === "correct_question_answer") {
    exactKeys(args, ["_question_id", "_answer", "_reason"]);
    const row = first(await tx.query<{ data: number }>(
      "select clinical_core.correct_question_answer($1,$2::jsonb,$3) as data",
      [clinicalUuid(requiredUuid(args._question_id)), JSON.stringify(boundedJsonObject(args._answer, 16_384)),
        optionalString(args._reason, 2000)],
    ));
    return Number(row.data);
  }
  if (name === "record_question_note_use") {
    exactKeys(args, ["_question_id", "_note_id"]);
    await tx.query("select clinical_core.record_question_note_use($1,$2)", [
      clinicalUuid(requiredUuid(args._question_id)), clinicalUuid(requiredUuid(args._note_id)),
    ]);
    return null;
  }
  if (name === "submit_question_feedback") {
    exactKeys(args, ["_question_id", "_kind", "_comment"]);
    await tx.query("select clinical_core.submit_question_feedback($1,$2,$3)", [
      clinicalUuid(requiredUuid(args._question_id)), questionFeedbackKind(args._kind),
      optionalString(args._comment, 2000),
    ]);
    return null;
  }
  if (name === "review_safety_block") {
    exactKeys(args, ["_block_id", "_resolution"]);
    await tx.query("select clinical_core.review_safety_block($1,$2)", [
      clinicalUuid(requiredUuid(args._block_id)), requiredString(args._resolution, 4000),
    ]);
    return null;
  }
  if (name === "create_clinical_pathway_draft") {
    exactKeys(args, ["_pathway_id", "_content", "_source_refs", "_change_summary"]);
    const content = boundedKnowledgePathwayContent(args._content);
    const sources = boundedKnowledgeSourceRefs(args._source_refs);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.create_clinical_pathway_draft($1,$2::jsonb,$3::jsonb,$4) as data",
      [clinicalUuid(requiredUuid(args._pathway_id)), JSON.stringify(content), JSON.stringify(sources),
        optionalString(args._change_summary, 2000)],
    ));
    return decodeJson(row.data);
  }
  if (name === "update_clinical_pathway_draft") {
    exactKeys(args, ["_version_id", "_content", "_source_refs", "_change_summary"]);
    const content = boundedKnowledgePathwayContent(args._content);
    const sources = boundedKnowledgeSourceRefs(args._source_refs);
    await tx.query(
      "select clinical_core.update_clinical_pathway_draft($1,$2::jsonb,$3::jsonb,$4)",
      [clinicalUuid(requiredUuid(args._version_id)), JSON.stringify(content), JSON.stringify(sources),
        optionalString(args._change_summary, 2000)],
    );
    return null;
  }
  if (name === "approve_clinical_pathway_version") {
    exactKeys(args, ["_version_id"]);
    await tx.query("select clinical_core.approve_clinical_pathway_version($1)", [
      clinicalUuid(requiredUuid(args._version_id)),
    ]);
    return null;
  }
  if (name === "stage_clinical_knowledge_import") {
    exactKeys(args, [
      "_organization_id", "_source_name", "_source_revision", "_schema_version",
      "_items", "_attests_no_phi",
    ]);
    if (args._organization_id !== context.organizationId
      || args._schema_version !== "clinical-knowledge-import-v1"
      || args._attests_no_phi !== true) throw invalid();
    const items = boundedKnowledgeImportItems(args._items);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.stage_clinical_knowledge_import($1,$2,$3,$4,$5::jsonb,$6) as data",
      [clinicalUuid(context.organizationId), requiredString(args._source_name, 240),
        optionalString(args._source_revision, 120), args._schema_version,
        JSON.stringify(items), true],
    ));
    return decodeJson(row.data);
  }
  if (name === "review_clinical_knowledge_import_item") {
    exactKeys(args, ["_item_id", "_decision", "_review_note"]);
    const decision = requiredString(args._decision, 16);
    if (!["accept", "reject"].includes(decision)) throw invalid();
    const note = requiredString(args._review_note, 2000);
    if (note.trim().length < 10) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.review_clinical_knowledge_import_item($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._item_id)), decision, note],
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
  if (table === "clinical_pathways") {
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_clinical_pathways($1) as data",
      [clinicalUuid(context.organizationId)],
    ));
    return decodeJson(row.data);
  }
  if (table === "clinical_knowledge_import_batches") {
    if (params.get("limit") !== "20" || params.get("order") !== "created_at.desc") throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_clinical_knowledge_import_batches($1,$2) as data",
      [clinicalUuid(context.organizationId), 20],
    ));
    return decodeJson(row.data);
  }
  if (table === "clinical_knowledge_import_items") {
    if (params.get("order") !== "created_at.asc") throw invalid();
    const batchIds = equalityUuidList(params.get("batch_id"), 20);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_clinical_knowledge_import_items($1,string_to_array($2,',')::uuid[]) as data",
      [clinicalUuid(context.organizationId), batchIds.join(",")],
    ));
    return decodeJson(row.data);
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

function equalityUuidList(value: string | null, max: number): string[] {
  if (!value?.startsWith("in.(") || !value.endsWith(")")) throw invalid();
  const values = value.slice(4, -1).split(",");
  if (values.length < 1 || values.length > max || values.some((item) => !UUID.test(item))) throw invalid();
  return values;
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

function requiredCatalogId(value: unknown, prefix: "prd" | "tpl"): string {
  const candidate = requiredString(value, 100);
  if (!new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{2,95}$`).test(candidate)) throw invalid();
  return candidate;
}

function boundedKnowledgeImportItems(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 250) throw invalid();
  const serialized = JSON.stringify(value);
  if (serialized.length > 4_194_304
    || /"(?:affiliateUrl|affiliateUrls|destinationUrl|discountCode|trackingCode)"\s*:/i.test(serialized)) {
    throw invalid();
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw invalid();
    const item = candidate as Record<string, unknown>;
    const allowed = new Set(["entityType", "externalKey", "displayName", "sourceSheet", "warnings", "payload"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) throw invalid();
    if (!["pathway", "product_label"].includes(requiredString(item.entityType, 32))) throw invalid();
    requiredString(item.externalKey, 200);
    requiredString(item.displayName, 300);
    optionalString(item.sourceSheet, 200);
    if (!Array.isArray(item.warnings) || item.warnings.length > 50
      || item.warnings.some((warning) => typeof warning !== "string" || warning.length > 1000)
      || !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)
      || JSON.stringify(item.payload).length > 524_288) throw invalid();
    return item;
  });
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

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredTimestamp(value);
}

function boundedProtocolPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const payload = value as Record<string, unknown>;
  allowedKeys(payload, [
    "title", "summary", "dietInstructions", "lifestyleInstructions", "monitoringPlan",
    "followupPlan", "phases", "items",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, max] of [
    ["title", 200], ["summary", 10_000], ["dietInstructions", 20_000],
    ["lifestyleInstructions", 20_000], ["monitoringPlan", 20_000], ["followupPlan", 20_000],
  ] as const) {
    if (key in payload) result[key] = optionalString(payload[key], max);
  }
  const phases = payload.phases ?? [];
  if (!Array.isArray(phases) || phases.length > 24) throw invalid();
  result.phases = phases.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const phase = entry as Record<string, unknown>;
    allowedKeys(phase, [
      "name", "startsOn", "endsOn", "relativeStartDay", "relativeDurationDays", "notes",
    ]);
    const startsOn = optionalDate(phase.startsOn);
    const endsOn = optionalDate(phase.endsOn);
    const relativeStartDay = optionalBoundedInteger(phase.relativeStartDay, 0, 3650);
    const relativeDurationDays = optionalBoundedInteger(phase.relativeDurationDays, 1, 3650);
    if ((startsOn !== null || endsOn !== null)
      && (relativeStartDay !== null || relativeDurationDays !== null)) throw invalid();
    return {
      name: requiredString(phase.name, 120), startsOn, endsOn, relativeStartDay,
      relativeDurationDays, notes: optionalString(phase.notes, 5000),
    };
  });
  const items = payload.items ?? [];
  if (!Array.isArray(items) || items.length > 200) throw invalid();
  result.items = items.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const item = entry as Record<string, unknown>;
    allowedKeys(item, [
      "kind", "label", "phaseIndex", "instructions", "catalogProductId",
      "catalogProductVersionId", "manufacturer", "labelVersion", "dosageText",
      "timingText", "route", "verificationStatus", "affiliateUrl",
    ]);
    const kind = requiredString(item.kind, 16);
    if (!["product", "diet", "lifestyle", "monitoring", "followup"].includes(kind)) throw invalid();
    const phaseIndex = optionalBoundedInteger(item.phaseIndex, 0, Math.max(phases.length - 1, 0));
    if (phaseIndex !== null && phases.length === 0) throw invalid();
    if (item.affiliateUrl !== null && item.affiliateUrl !== undefined && item.affiliateUrl !== "") throw invalid();
    if (item.verificationStatus !== null && item.verificationStatus !== undefined
      && item.verificationStatus !== "unverified") throw invalid();
    const clinical = {
      catalogProductId: optionalString(item.catalogProductId, 100),
      catalogProductVersionId: optionalString(item.catalogProductVersionId, 9),
      manufacturer: optionalString(item.manufacturer, 200), labelVersion: optionalString(item.labelVersion, 120),
      dosageText: optionalString(item.dosageText, 1000), timingText: optionalString(item.timingText, 1000),
      route: optionalString(item.route, 120),
    };
    if (kind === "product") {
      if (!/^prd_[a-z0-9][a-z0-9_-]{2,95}$/.test(clinical.catalogProductId ?? "")
        || !/^[1-9][0-9]{0,8}$/.test(clinical.catalogProductVersionId ?? "")) throw invalid();
    } else if (Object.values(clinical).some((candidate) => candidate !== null)) throw invalid();
    return {
      kind, label: requiredString(item.label, 240), phaseIndex,
      instructions: optionalString(item.instructions, 10_000), ...clinical,
      verificationStatus: "unverified", affiliateUrl: null,
    };
  });
  if (JSON.stringify(result).length > 524_288) throw invalid();
  return result;
}

function boundedKnowledgePathwayContent(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const content = value as Record<string, unknown>;
  exactKeys(content, [
    "differentiatingQuestions", "labStrategy", "productCandidates", "nutrition", "lifestyle", "safetyStops",
  ]);
  const strings = (candidate: unknown, maxItems: number, maxLength: number) => {
    if (!Array.isArray(candidate) || candidate.length > maxItems) throw invalid();
    return candidate.map((item) => requiredString(item, maxLength));
  };
  const objectRows = (candidate: unknown, keys: readonly string[], maxItems: number) => {
    if (!Array.isArray(candidate) || candidate.length > maxItems) throw invalid();
    return candidate.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
      const row = item as Record<string, unknown>;
      exactKeys(row, [...keys]);
      return Object.fromEntries(keys.map((key) => [key, requiredString(row[key], 1000)]));
    });
  };
  const bounded = {
    differentiatingQuestions: strings(content.differentiatingQuestions, 100, 2000),
    labStrategy: objectRows(content.labStrategy, ["panel", "vendor", "purpose"], 100),
    productCandidates: objectRows(content.productCandidates, ["name", "brand", "role"], 100),
    nutrition: strings(content.nutrition, 100, 2000),
    lifestyle: strings(content.lifestyle, 100, 2000),
    safetyStops: strings(content.safetyStops, 100, 2000),
  };
  if (JSON.stringify(bounded).length > 524_288) throw invalid();
  return bounded;
}

function boundedKnowledgeSourceRefs(value: unknown): Array<{ label: string }> {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const sources = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const source = item as Record<string, unknown>;
    exactKeys(source, ["label"]);
    return { label: requiredString(source.label, 1000) };
  });
  if (JSON.stringify(sources).length > 131_072) throw invalid();
  return sources;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

function optionalBoundedInteger(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
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

function boundedJsonObject(value: unknown, maxBytes: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  if (JSON.stringify(value).length > maxBytes) throw invalid();
  return value as Record<string, unknown>;
}

function questionFeedbackKind(value: unknown): string {
  const kind = requiredString(value, 24);
  if (!["helpful", "not_relevant", "unsafe", "incorrect", "duplicate", "other"].includes(kind)) throw invalid();
  return kind;
}

function boundedCorrectionOverlay(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const forbidden = /authorization|cookie|password|token|secret|service.?role|affiliate|destination|discount|tracking/i;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 64) throw invalid();
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(key) || forbidden.test(key)
      || !(item === null || ["string", "number", "boolean"].includes(typeof item))
      || (typeof item === "string" && item.length > 2000)
      || (typeof item === "number" && !Number.isFinite(item))) throw invalid();
  }
  if (JSON.stringify(value).length > 16_384) throw invalid();
  return Object.fromEntries(entries) as Record<string, string | number | boolean | null>;
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
