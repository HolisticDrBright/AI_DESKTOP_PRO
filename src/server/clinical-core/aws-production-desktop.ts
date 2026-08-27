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
const NUTRITION_RPC_KEYS: Readonly<Record<string, readonly string[]>> = {
  activate_nutrition_plan_version: ["_organization_id", "_plan_version_id"],
  add_nutrition_amendment: ["_body", "_organization_id", "_plan_version_id", "_reason"],
  approve_nutrition_plan_version: ["_note", "_organization_id", "_plan_version_id"],
  archive_nutrition_template: ["_organization_id", "_reason", "_template_id"],
  create_nutrition_plan: ["_organization_id", "_patient_id", "_source_template_version_id", "_title"],
  create_nutrition_template_version: ["_caution_populations", "_copy_from_version_id", "_education_vs_advice_note", "_evidence_grade", "_evidence_summary", "_intended_use", "_missing_information_required", "_organization_id", "_patient_education", "_prerequisites", "_purpose", "_requires_practitioner_review", "_template_id"],
  evaluate_nutrition_plan_safety: ["_organization_id", "_plan_version_id"],
  get_nutrition_adherence_summary: ["_days", "_organization_id", "_patient_id"],
  get_nutrition_version_content: ["_organization_id", "_plan_version_id", "_template_version_id"],
  get_patient_nutrition: ["_organization_id", "_patient_id"],
  install_nutrition_starter_template: ["_content", "_content_hash", "_meta", "_name", "_organization_id", "_pattern", "_slug", "_summary"],
  list_nutrition_templates: ["_include_archived", "_organization_id"],
  publish_nutrition_template_version: ["_organization_id", "_template_version_id"],
  raise_nutrition_safety_flag: ["_detail", "_kind", "_organization_id", "_plan_version_id", "_severity"],
  record_nutrition_checkin: ["_diet_adherence_pct", "_digestive_tolerance", "_energy_rating", "_hunger_rating", "_meal_plan_adherence_pct", "_observed_on", "_organization_id", "_patient_id", "_patient_note", "_plan_version_id", "_satiety_rating", "_source", "_symptoms", "_weight_unit", "_weight_value"],
  resolve_nutrition_safety_flag: ["_action", "_flag_id", "_organization_id", "_reason"],
  review_nutrition_checkin: ["_checkin_id", "_organization_id", "_state"],
  revise_nutrition_plan_version: ["_organization_id", "_plan_version_id", "_reason"],
  save_nutrition_plan_version: ["_autosave", "_carbohydrate_g", "_carbohydrate_pct", "_content", "_energy_target_unit", "_energy_target_value", "_expected_version", "_fasting_instructions", "_fat_g", "_fat_pct", "_fiber_g", "_goals", "_meal_timing_guidance", "_organization_id", "_patient_instructions", "_plan_version_id", "_practitioner_rationale", "_protein_g", "_protein_pct"],
  save_nutrition_template_content: ["_content", "_organization_id", "_template_version_id"],
  set_nutrition_plan_constraints: ["_constraints", "_organization_id", "_plan_version_id"],
  set_nutrition_plan_lifecycle: ["_action", "_organization_id", "_plan_id", "_reason"],
  submit_nutrition_plan_version: ["_organization_id", "_plan_version_id"],
  upsert_nutrition_template: ["_expected_version", "_name", "_organization_id", "_pattern", "_summary", "_template_id"],
};
const BILLING_RPC_KEYS: Readonly<Record<string, readonly string[]>> = {
  adjust_inventory_stock: ["_delta", "_kind", "_location_id", "_organization_id", "_product_id", "_reason"],
  apply_patient_credit: ["_amount_minor", "_expected_version", "_invoice_id", "_organization_id"],
  archive_billing_product: ["_expected_version", "_organization_id", "_product_id"],
  create_invoice_draft: ["_appointment_id", "_location_id", "_organization_id", "_patient_id"],
  finalize_invoice: ["_expected_version", "_invoice_id", "_organization_id"],
  get_billing_invoice: ["_invoice_id", "_organization_id"],
  get_billing_workspace: ["_from", "_location_id", "_method", "_organization_id", "_practitioner_user_id", "_status", "_to"],
  get_inventory_history: ["_limit", "_location_id", "_organization_id", "_product_id"],
  get_patient_billing: ["_organization_id", "_patient_id"],
  grant_patient_credit: ["_amount_minor", "_organization_id", "_patient_id", "_reason"],
  list_billing_catalog: ["_include_archived", "_kind", "_limit", "_location_id", "_organization_id", "_query", "_stock_filter", "_supplier_id"],
  receive_inventory_stock: ["_location_id", "_organization_id", "_product_id", "_quantity", "_reference", "_supplier_id", "_unit_cost_minor"],
  record_manual_payment: ["_amount_minor", "_expected_version", "_idempotency_key", "_invoice_id", "_method", "_organization_id", "_reference"],
  refund_payment: ["_amount_minor", "_method", "_organization_id", "_payment_id", "_reason"],
  return_inventory_stock: ["_condition", "_invoice_id", "_location_id", "_organization_id", "_product_id", "_quantity", "_reason"],
  save_invoice_draft: ["_expected_version", "_invoice_id", "_lines", "_location_id", "_organization_id"],
  start_card_payment: ["_expected_version", "_idempotency_key", "_invoice_id", "_organization_id"],
  upsert_billing_location: ["_archive", "_id", "_name", "_organization_id"],
  upsert_billing_product: ["_amount_minor", "_barcode", "_catalog_product_id", "_cost_minor", "_currency", "_description", "_expected_version", "_id", "_kind", "_name", "_organization_id", "_reorder_threshold", "_sku", "_supplier_id", "_tax_rate_id", "_track_inventory"],
  upsert_supplier: ["_archive", "_contact_email", "_id", "_name", "_notes", "_organization_id", "_phone"],
  upsert_tax_rate: ["_active", "_id", "_name", "_organization_id", "_rate_bps"],
  void_invoice: ["_expected_version", "_invoice_id", "_organization_id", "_reason"],
};
const PLAN_RPC_KEYS: Readonly<Record<string, readonly string[]>> = {
  assign_complimentary_plan: ["_expires_at", "_organization_id", "_patient_id", "_plan_type", "_reason", "_version_id"],
  create_plan_version: ["_credit_mode", "_credit_quantity", "_currency", "_eligible_location_ids", "_eligible_practitioner_ids", "_eligible_product_ids", "_expires_after_days", "_grace_period_days", "_included_credits", "_interval_count", "_interval_unit", "_minimum_commitment_periods", "_organization_id", "_plan_id", "_plan_type", "_price_minor", "_terms_summary", "_transfer_policy", "_trial_days"],
  expire_entitlements: ["_organization_id"],
  get_patient_entitlements: ["_organization_id", "_patient_id"],
  get_reconciliation_workspace: ["_organization_id", "_status"],
  grant_entitlements_for_invoice: ["_invoice_id", "_organization_id"],
  list_plans: ["_include_archived", "_organization_id"],
  publish_plan_version: ["_organization_id", "_plan_type", "_version_id"],
  purchase_package: ["_acceptance_method", "_organization_id", "_package_version_id", "_patient_id"],
  reserve_entitlement_for_appointment: ["_appointment_id", "_entitlement_id", "_organization_id", "_quantity"],
  resolve_reconciliation_exception: ["_exception_id", "_expected_version", "_organization_id", "_reason", "_resolution"],
  restore_entitlement: ["_entitlement_id", "_organization_id", "_quantity", "_reason"],
  revoke_entitlements_for_refund: ["_invoice_id", "_organization_id", "_reason"],
  set_membership_lifecycle: ["_action", "_expected_version", "_organization_id", "_patient_membership_id", "_reason"],
  set_org_billing_policy: ["_consume_on", "_late_cancel_policy", "_late_cancel_window_hours", "_no_show_policy", "_organization_id"],
  settle_entitlement_for_appointment: ["_appointment_id", "_organization_id", "_outcome", "_reason"],
  upsert_plan: ["_archive", "_description", "_expected_version", "_id", "_kind", "_name", "_organization_id", "_plan_type"],
};
const PROGRAM_RPC_KEYS: Readonly<Record<string, readonly string[]>> = {
  approve_program_template_version: ["_version_id"],
  approve_program_version: ["_note", "_version_id"],
  archive_program: ["_archived", "_program_id"],
  archive_program_template: ["_archived", "_template_id"],
  create_program: ["_from_template_id", "_name", "_organization_id"],
  create_program_template: ["_description", "_from_version_id", "_name", "_organization_id"],
  enroll_patient_in_program: ["_activate", "_comp_reason", "_offer_id", "_patient_id", "_program_id"],
  get_patient_programs: ["_patient_id"],
  get_program_studio: ["_program_id"],
  list_program_templates: ["_include_archived", "_organization_id"],
  list_programs: ["_limit", "_organization_id", "_query", "_status"],
  publish_program_version: ["_version_id"],
  record_program_progress: ["_block_id", "_enrollment_id", "_kind", "_lesson_id", "_needs_review", "_payload"],
  return_program_version: ["_note", "_version_id"],
  review_program_progress: ["_progress_id"],
  revise_program_version: ["_version_id"],
  save_program_draft: ["_expected_updated_at", "_payload", "_version_id"],
  set_program_enrollment_status: ["_enrollment_id", "_reason", "_status"],
  submit_program_version: ["_version_id"],
  upsert_program_offer: ["_access_duration_days", "_currency", "_enrollment_open", "_name", "_offer_id", "_payment_mode", "_price_cents", "_program_id", "_status"],
};
const INBOX_RPC_KEYS: Readonly<Record<string, readonly string[]>> = {
  append_message_to_note: ["_encounter_id", "_message_id", "_section"],
  cancel_message_draft: ["_message_id"],
  create_conversation: ["_category", "_organization_id", "_patient_id", "_priority", "_subject"],
  create_task_from_message: ["_message_id", "_priority", "_title"],
  get_conversation: ["_conversation_id"],
  get_inbox_today_summary: ["_organization_id"],
  get_patient_messages: ["_patient_id"],
  list_inbox: ["_assigned_to_me", "_category", "_due_only", "_limit", "_organization_id", "_priority", "_query", "_queue", "_status", "_unread_only"],
  mark_conversation_read: ["_conversation_id"],
  register_message_attachment: ["_byte_size", "_content_type", "_conversation_id", "_file_name", "_message_id", "_sha256"],
  review_ai_suggestion: ["_decision", "_review_id"],
  save_message_draft: ["_body", "_conversation_id", "_expected_version", "_message_id"],
  send_message: ["_channel", "_idempotency_key", "_message_id"],
  set_communication_preferences: ["_consent_id", "_do_not_contact", "_email_ok", "_note", "_patient_id", "_preferred_channel", "_push_ok", "_sms_ok"],
  update_conversation_workflow: ["_action", "_at", "_conversation_id", "_expected_version", "_note", "_value"],
};
const CORE_RPCS = new Set([
  "create_patient_profile",
  "review_biomarker",
  "list_patient_lab_observations",
  "record_registered_audit_event",
  "list_audit_events",
  "list_my_organizations",
  "activate_my_memberships",
  "list_org_members",
  "add_org_member",
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
  "preview_knowledge_import",
  "get_knowledge_import_preview",
  "resolve_knowledge_import_conflict",
  "commit_knowledge_import",
  "cancel_knowledge_import",
  "list_label_commercial_links",
  "list_protocol_commercial_links",
  "get_research_handoff_review",
  "record_research_handoff_item_review",
  "approve_knowledge_reference",
  "attach_commercial_link_to_verified_product",
  "bulk_apply_org_tag",
  "bulk_assign_reviewer",
  "bulk_mark_duplicate",
  "clear_catalog_product_restriction",
  "complete_catalog_product_review",
  "create_knowledge_reference_draft",
  "create_product_label_draft",
  "get_catalog_review_queue",
  "get_import_provenance",
  "get_import_source_inventory",
  "get_restricted_review_history_v2",
  "get_restricted_review_queue",
  "list_knowledge_references",
  "list_product_label_versions",
  "list_warning_resolutions",
  "record_import_source_file",
  "record_restricted_review_outcome_v2",
  "record_warning_resolution",
  "resolve_knowledge_import_ambiguity",
  "revoke_commercial_link",
  "supersede_knowledge_reference",
  "supersede_product_label_version",
  ...Object.keys(NUTRITION_RPC_KEYS),
  ...Object.keys(BILLING_RPC_KEYS),
  ...Object.keys(PLAN_RPC_KEYS),
  ...Object.keys(PROGRAM_RPC_KEYS),
  ...Object.keys(INBOX_RPC_KEYS),
]);
const CORE_SELECTS = new Set([
  "patient_profiles",
  "lab_documents",
  "clinical_pathways",
  "clinical_knowledge_import_batches",
  "clinical_knowledge_import_items",
]);
const IMPORT_REVIEW_RPC_KEYS: Readonly<Record<string, readonly string[]>> = {
  approve_knowledge_reference: ["_organization_id", "_reference_id", "_verification_reason"],
  attach_commercial_link_to_verified_product: ["_organization_id", "_label_version_id", "_incoming_sku", "_incoming_upc", "_incoming_manufacturer", "_incoming_product_name", "_affiliate_url", "_discount_code", "_disclosure", "_match_reason"],
  bulk_apply_org_tag: ["_organization_id", "_item_ids", "_tag", "_reason"],
  bulk_assign_reviewer: ["_organization_id", "_item_ids", "_assignee", "_reason"],
  bulk_mark_duplicate: ["_organization_id", "_item_ids", "_duplicate_of_item_id", "_reason"],
  clear_catalog_product_restriction: ["_product_id", "_note"],
  complete_catalog_product_review: ["_product_id", "_note"],
  create_knowledge_reference_draft: ["_organization_id", "_claim", "_reference_type", "_clinical_domain", "_structured_claim", "_population", "_intervention", "_outcome_field", "_evidence_grade", "_citation", "_source_kind", "_source_version", "_publication_date", "_jurisdiction", "_limitations", "_contradictions", "_restricted_flags"],
  create_product_label_draft: ["_organization_id", "_product_code", "_product_name", "_brand", "_exact_label", "_source_url", "_serving_size", "_ingredients", "_other_ingredients", "_allergens", "_contraindications", "_warnings_text", "_storage_instructions", "_observed_date", "_jurisdiction", "_label_image_ref"],
  get_catalog_review_queue: ["_organization_id"],
  get_import_provenance: ["_organization_id", "_ref_type", "_ref_id", "_limit"],
  get_import_source_inventory: ["_organization_id"],
  get_restricted_review_history_v2: ["_organization_id", "_subject_type", "_subject_id"],
  get_restricted_review_queue: ["_organization_id"],
  list_knowledge_references: ["_organization_id"],
  list_product_label_versions: ["_organization_id", "_product_code"],
  list_warning_resolutions: ["_organization_id", "_subject_type", "_subject_id"],
  record_import_source_file: ["_organization_id", "_declared_name", "_source_kind", "_availability", "_content_sha256", "_byte_size", "_unavailable_reason"],
  record_restricted_review_outcome_v2: ["_organization_id", "_subject_type", "_subject_id", "_outcome", "_reason", "_jurisdiction"],
  record_warning_resolution: ["_organization_id", "_subject_type", "_subject_id", "_warning_key", "_disposition", "_reason"],
  resolve_knowledge_import_ambiguity: ["_item_id", "_resolution", "_note", "_existing_product_id"],
  revoke_commercial_link: ["_organization_id", "_link_id", "_reason"],
  supersede_knowledge_reference: ["_organization_id", "_supersedes_id", "_new_claim", "_reason"],
  supersede_product_label_version: ["_organization_id", "_supersedes_id", "_exact_label", "_reason", "_serving_size", "_ingredients", "_other_ingredients", "_allergens", "_contraindications", "_warnings_text", "_storage_instructions", "_source_url", "_observed_date"],
};

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
  if (name === "activate_my_memberships") {
    exactKeys(args, []);
    const row = first(await tx.query<{ activated: number }>(
      "select clinical_core.activate_my_memberships() as activated", [],
    ));
    return row.activated;
  }
  if (name === "list_org_members") {
    exactKeys(args, ["_organization_id"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    return (await tx.query(
      "select * from clinical_core.list_org_members($1)",
      [clinicalUuid(context.organizationId)],
    )).rows;
  }
  if (name === "add_org_member") {
    exactKeys(args, ["_organization_id", "_email", "_role"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const email = requiredString(args._email, 320).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid();
    const role = requiredString(args._role, 16);
    if (!["owner", "admin", "practitioner", "staff", "member"].includes(role)) throw invalid();
    const row = first(await tx.query<{ membership_id: string }>(
      "select clinical_core.add_org_member($1,$2,$3) as membership_id",
      [clinicalUuid(context.organizationId), email, role],
    ));
    return row.membership_id;
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
    if (Object.hasOwn(args, "_organization_id")) {
      const row = first(await tx.query<{ data: unknown }>(
        "select clinical_core.invoke_import_review_operation($1,$2::jsonb) as data",
        [name, JSON.stringify(boundedJsonObject(args, 524_288))],
      ));
      return decodeJson(row.data);
    }
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
  if (name === "preview_knowledge_import") {
    exactKeys(args, [
      "_organization_id", "_source_kind", "_source_name", "_schema_version", "_items",
      "_attests_no_phi", "_source_filename", "_source_byte_size", "_source_revision",
      "_source_restricted_flags", "_source_restricted_reason", "_commercial_only",
    ]);
    if (args._organization_id !== context.organizationId
      || args._schema_version !== "clinical-knowledge-import-v1"
      || args._attests_no_phi !== true || args._commercial_only !== false) throw invalid();
    const sourceKind = requiredString(args._source_kind, 32);
    if (!["product_spreadsheet", "affiliate_sheet", "protocol_document", "obsidian_export",
      "reference_list", "other", "research_handoff"].includes(sourceKind)) throw invalid();
    const flags = boundedStringArray(args._source_restricted_flags, 20, 100);
    if (flags.some((flag) => flag.includes(","))) throw invalid();
    const byteSize = optionalInteger(args._source_byte_size, 0);
    if (byteSize !== null && byteSize > 20_971_520) throw invalid();
    const items = boundedKnowledgeImportItems(args._items);
    const row = first(await tx.query<{ data: unknown }>(
      `select clinical_core.preview_knowledge_import($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,
        string_to_array($10,',')::text[],$11,$12) as data`,
      [clinicalUuid(context.organizationId), sourceKind, requiredString(args._source_name, 240),
        args._schema_version, JSON.stringify(items), true, optionalString(args._source_filename, 260),
        byteSize, optionalString(args._source_revision, 120), flags.join(","),
        optionalString(args._source_restricted_reason, 2000), false],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_knowledge_import_preview") {
    exactKeys(args, ["_batch_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_knowledge_import_preview($1) as data",
      [clinicalUuid(requiredUuid(args._batch_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "resolve_knowledge_import_conflict") {
    exactKeys(args, ["_item_id", "_resolution", "_note"]);
    const resolution = requiredString(args._resolution, 32);
    if (!["keep_existing", "take_incoming", "skip"].includes(resolution)) throw invalid();
    const note = requiredString(args._note, 2000);
    if (note.trim().length < 10) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.resolve_knowledge_import_conflict($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._item_id)), resolution, note],
    ));
    return decodeJson(row.data);
  }
  if (name === "commit_knowledge_import") {
    exactKeys(args, ["_batch_id", "_expected_counts", "_note"]);
    const counts = boundedKnowledgeImportExpectedCounts(args._expected_counts);
    const note = optionalString(args._note, 2000);
    if (note !== null && note.trim().length < 10) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.commit_knowledge_import($1,$2::jsonb,$3) as data",
      [clinicalUuid(requiredUuid(args._batch_id)), counts === null ? null : JSON.stringify(counts), note],
    ));
    return decodeJson(row.data);
  }
  if (name === "cancel_knowledge_import") {
    exactKeys(args, ["_batch_id", "_reason"]);
    const reason = requiredString(args._reason, 1000);
    if (reason.trim().length < 10) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.cancel_knowledge_import($1,$2) as data",
      [clinicalUuid(requiredUuid(args._batch_id)), reason],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_label_commercial_links") {
    exactKeys(args, ["_label_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_label_commercial_links($1) as data",
      [clinicalUuid(requiredUuid(args._label_version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "list_protocol_commercial_links") {
    exactKeys(args, ["_version_id"]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.list_protocol_commercial_links($1) as data",
      [clinicalUuid(requiredUuid(args._version_id))],
    ));
    return decodeJson(row.data);
  }
  if (name === "get_research_handoff_review") {
    exactKeys(args, ["_organization_id", "_prh_ids"]);
    if (args._organization_id !== context.organizationId) throw invalid();
    const ids = boundedStringArray(args._prh_ids, 50, 200);
    if (ids.length < 1 || ids.some((id) => id.includes(","))) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.get_research_handoff_review($1,string_to_array($2,',')::text[]) as data",
      [clinicalUuid(context.organizationId), ids.join(",")],
    ));
    return decodeJson(row.data);
  }
  if (name === "record_research_handoff_item_review") {
    exactKeys(args, ["_item_id", "_verdict", "_note"]);
    const verdict = requiredString(args._verdict, 16);
    if (!["verified", "blocked"].includes(verdict)) throw invalid();
    const note = requiredString(args._note, 2000);
    if (note.trim().length < 10) throw invalid();
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.record_research_handoff_item_review($1,$2,$3) as data",
      [clinicalUuid(requiredUuid(args._item_id)), verdict, note],
    ));
    return decodeJson(row.data);
  }
  const importReviewKeys = IMPORT_REVIEW_RPC_KEYS[name];
  if (importReviewKeys) {
    exactKeys(args, [...importReviewKeys]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.invoke_import_review_operation($1,$2::jsonb) as data",
      [name, JSON.stringify(boundedJsonObject(args, 524_288))],
    ));
    return decodeJson(row.data);
  }
  const nutritionKeys = NUTRITION_RPC_KEYS[name];
  if (nutritionKeys) {
    exactKeys(args, [...nutritionKeys]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.invoke_nutrition_operation($1,$2::jsonb) as data",
      [name, JSON.stringify(boundedJsonObject(args, 1_048_576))],
    ));
    return decodeJson(row.data);
  }
  const billingKeys = BILLING_RPC_KEYS[name];
  if (billingKeys) {
    exactKeys(args, [...billingKeys]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.invoke_billing_operation($1,$2::jsonb) as data",
      [name, JSON.stringify(boundedJsonObject(args, 1_048_576))],
    ));
    return decodeJson(row.data);
  }
  const planKeys = PLAN_RPC_KEYS[name];
  if (planKeys) {
    exactKeys(args, [...planKeys]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.invoke_plan_operation($1,$2::jsonb) as data",
      [name, JSON.stringify(boundedJsonObject(args, 524_288))],
    ));
    return decodeJson(row.data);
  }
  const programKeys = PROGRAM_RPC_KEYS[name];
  if (programKeys) {
    exactKeys(args, [...programKeys]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.invoke_program_operation($1,$2::jsonb) as data",
      [name, JSON.stringify(boundedJsonObject(args, 1_048_576))],
    ));
    return decodeJson(row.data);
  }
  const inboxKeys = INBOX_RPC_KEYS[name];
  if (inboxKeys) {
    exactKeys(args, [...inboxKeys]);
    const row = first(await tx.query<{ data: unknown }>(
      "select clinical_core.invoke_inbox_operation($1,$2::jsonb) as data",
      [name, JSON.stringify(boundedJsonObject(args, 524_288))],
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

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid();
  return value.map((item) => requiredString(item, maxLength));
}

function boundedKnowledgeImportExpectedCounts(value: unknown): { added: number; changed: number } | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const counts = value as Record<string, unknown>;
  exactKeys(counts, ["added", "changed"]);
  return {
    added: boundedInteger(counts.added, 0, 250),
    changed: boundedInteger(counts.changed, 0, 250),
  };
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
