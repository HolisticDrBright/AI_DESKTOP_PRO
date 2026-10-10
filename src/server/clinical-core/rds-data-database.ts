if (typeof window !== "undefined") {
  throw new Error("clinical-core/rds-data-database is server-only.");
}

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
  type Field,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreQueryResult, type ClinicalCoreTransaction, type ClinicalUuid } from "./database";
import {retryDatabaseResume} from './rds-resume-retry';
import { createSingleAttemptRdsClient } from './rds-single-attempt-client';

export type RdsDataConfiguration = {
  clusterArn: string;
  secretArn: string;
  databaseName: string;
  region?: string;
};

export interface RdsDataCommandClient {
  send(command: unknown): Promise<Record<string, unknown>>;
}

export class RdsDataDatabaseError extends Error {
  constructor(readonly category: "configuration_invalid" | "transaction_failed" | "query_failed") {
    super(category);
    this.name = "RdsDataDatabaseError";
  }
}

const ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:\d{12}:cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function createRdsDataClinicalCoreDatabase(
  configuration: RdsDataConfiguration,
  client: RdsDataCommandClient = createSingleAttemptRdsClient({ region: configuration.region }),
): ClinicalCoreDatabase {
  return createRdsDataDatabase(configuration, client, "clinical_core_api");
}

/** Dedicated unreleased Fullscript worker. No caller-selected role or
 * administrative migration connection is exposed to request code. The role
 * must already exist on the reviewed target; missing membership fails closed. */
export function createRdsDataFullscriptDraftDatabase(
  configuration: RdsDataConfiguration,
  client: RdsDataCommandClient = createSingleAttemptRdsClient({ region: configuration.region }),
): ClinicalCoreDatabase {
  return createRdsDataDatabase(configuration, client, "fullscript_draft_worker");
}

/** Administrative access is reserved for reviewed migration/import operator paths. */
export function createRdsDataAdministrativeDatabase(
  configuration: RdsDataConfiguration,
  authorization: { purpose: "reviewed_synthetic_migration" | "reviewed_reference_catalog_import" | "reviewed_production_schema_migration" | "reviewed_retention_service_release" | "reviewed_covered_entity_termination" | "reviewed_consent_copy_registration" },
  client: RdsDataCommandClient = createSingleAttemptRdsClient({ region: configuration.region }),
): ClinicalCoreDatabase {
  if (!["reviewed_synthetic_migration", "reviewed_reference_catalog_import", "reviewed_production_schema_migration", "reviewed_retention_service_release", "reviewed_covered_entity_termination", "reviewed_consent_copy_registration"].includes(authorization.purpose)) {
    throw new RdsDataDatabaseError("configuration_invalid");
  }
  return createRdsDataDatabase(configuration, client);
}

function createRdsDataDatabase(
  configuration: RdsDataConfiguration,
  client: RdsDataCommandClient,
  assumeRole?: "clinical_core_api" | "fullscript_draft_worker",
): ClinicalCoreDatabase {
  assertConfiguration(configuration);
  const common = {
    resourceArn: configuration.clusterArn,
    secretArn: configuration.secretArn,
    database: configuration.databaseName,
  };

  return {
    async transaction<T>(work: (tx: ClinicalCoreTransaction) => Promise<T>): Promise<T> {
      let transactionId: string | undefined;
      let workError: unknown;
      try {
        const begun = await retryDatabaseResume(()=>client.send(new BeginTransactionCommand(common)));
        transactionId = stringProperty(begun, "transactionId");
        if (!transactionId) throw new RdsDataDatabaseError("transaction_failed");

        if (assumeRole) {
          await client.send(new ExecuteStatementCommand({
            ...common,
            transactionId,
            sql: `set local role ${assumeRole}`,
          }));
        }

        const tx: ClinicalCoreTransaction = {
          query: <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) =>
            execute<Row>(client, common, transactionId as string, sql, parameters),
        };
        let result: T;
        try {
          result = await work(tx);
        } catch (error) {
          workError = error;
          throw error;
        }
        await client.send(new CommitTransactionCommand({ ...common, transactionId }));
        return result;
      } catch (error) {
        if (transactionId) {
          try {
            await client.send(new RollbackTransactionCommand({ ...common, transactionId }));
          } catch {
            // The original bounded category is authoritative; rollback errors contain no useful caller detail.
          }
        }
        if (workError !== undefined) throw workError;
        if (error instanceof RdsDataDatabaseError || error instanceof ClinicalCoreDatabaseRejection) throw error;
        throw new RdsDataDatabaseError(transactionId ? "query_failed" : "transaction_failed");
      }
    },
  };
}

async function execute<Row extends Record<string, unknown>>(
  client: RdsDataCommandClient,
  common: { resourceArn: string; secretArn: string; database: string },
  transactionId: string,
  sql: string,
  values: readonly unknown[],
): Promise<ClinicalCoreQueryResult<Row>> {
  const { sql: namedSql, parameters } = bindParameters(sql, values);
  let response: Record<string, unknown>;
  try {
    response = await client.send(new ExecuteStatementCommand({
      ...common,
      transactionId,
      sql: namedSql,
      parameters,
      includeResultMetadata: true,
    }));
  } catch (error) {
    const rejection = classifyDatabaseRejection(error);
    if (rejection) throw rejection;
    throw new RdsDataDatabaseError("query_failed");
  }

  const columns = Array.isArray(response.columnMetadata)
    ? response.columnMetadata.map((entry) => stringProperty(entry, "name") ?? "")
    : [];
  const records = Array.isArray(response.records) ? response.records as Field[][] : [];
  return {
    rows: records.map((record) => Object.fromEntries(
      columns.map((name, index) => [name, decodeField(record[index])]),
    ) as Row),
    rowCount: numberProperty(response, "numberOfRecordsUpdated") ?? records.length,
  };
}

export function bindParameters(sql: string, values: readonly unknown[]): { sql: string; parameters: SqlParameter[] } {
  if (values.length === 0) return { sql, parameters: [] };
  const referenced = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  if (referenced.some((index) => index < 1 || index > values.length)) {
    throw new RdsDataDatabaseError("query_failed");
  }
  const names = [...new Set(referenced)].sort((a, b) => a - b);
  return {
    sql: sql.replace(/\$(\d+)/g, (_whole, index) => `:p${index}`),
    parameters: names.map((index) => {
      const raw = values[index - 1];
      return {
        name: `p${index}`,
        value: encodeField(raw),
        ...(isClinicalUuid(raw) ? { typeHint: "UUID" as const } : {}),
      };
    }),
  };
}

function encodeField(value: unknown): Field {
  if (value === null || value === undefined) return { isNull: true };
  if (isClinicalUuid(value)) return { stringValue: value.value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isSafeInteger(value)) return { longValue: value };
  if (typeof value === "number" && Number.isFinite(value)) return { doubleValue: value };
  if (typeof value === "bigint") return { stringValue: value.toString() };
  if (value instanceof Date && Number.isFinite(value.getTime())) return { stringValue: value.toISOString() };
  if (value instanceof Uint8Array) return { blobValue: value };
  throw new RdsDataDatabaseError("query_failed");
}

function isClinicalUuid(value: unknown): value is ClinicalUuid {
  return Boolean(value) && typeof value === "object"
    && (value as ClinicalUuid).kind === "uuid"
    && typeof (value as ClinicalUuid).value === "string";
}

function decodeField(field: Field | undefined): unknown {
  if (!field || field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return field.blobValue;
  if (field.arrayValue !== undefined) return field.arrayValue;
  return null;
}

function assertConfiguration(configuration: RdsDataConfiguration) {
  if (!ARN.test(configuration.clusterArn) || !SECRET_ARN.test(configuration.secretArn) || !DB_NAME.test(configuration.databaseName)) {
    throw new RdsDataDatabaseError("configuration_invalid");
  }
}

function classifyDatabaseRejection(error: unknown): ClinicalCoreDatabaseRejection | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (record.name !== "DatabaseErrorException" || typeof record.message !== "string") return undefined;
  const message = record.message;
  if (/\bcare_message_refused\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\bcare_message_consent_required\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\bcare_message_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\bcare_message_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bcare_connection_refused\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\bcare_connection_approved_copy_required\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\bcare_connection_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\bcare_connection_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  // A settled request id can never be admitted again; the caller must treat it as a
  // decided conflict, not as an identity problem it could retry past.
  if (/\bcare_message_settled\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\bprogram_assignment_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\b(program_assignment_refused|program_assignment_unpublished|program_item_held|program_assignment_immutable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(program_assignment_conflict|program_assignment_version_changed|program_assignment_revision_stale|program_review_stale|program_assignment_state_invalid|program_tasks_remaining|program_phase_not_due|program_check_in_required|program_practitioner_review_required|program_clinical_items_held)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\b(care_data_invalid|care_erasure_intent_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bcare_data_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\bcare_data_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\bcare_data_erasure_immutable\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\bexternal_calendar_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bexternal_calendar_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(external_calendar_scope_refused|external_calendar_immutable|external_calendar_absent)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(external_calendar_not_pending|external_calendar_state_mismatch|external_calendar_authorization_expired|external_calendar_revision_stale|external_calendar_not_connected|external_calendar_reauthorization_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  // A booking refused because the practitioner's external calendar says otherwise, or
  // because it cannot currently say anything. Both are decided answers, not faults.
  if (/\b(external_busy_conflict|external_busy_unknown|external_busy_stale|external_busy_unreadable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\b(recording_access_refused|recording_capture_refused|recording_representative_authority_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(recording_consent_required|recording_consent_release_required|recording_capture_release_required|recording_roster_required|recording_storage_release_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\b(recording_segment_conflict|recording_segment_order_required|recording_reservation_expired)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\b(recording_segment_invalid|recording_size_limit)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\b(recording_lifecycle_conflict|recording_inventory_changed|recording_segments_unresolved)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\brecording_lifecycle_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\b(recording_participant_conflict|recording_consent_conflict|recording_capture_conflict|recording_consent_already_granted|recording_disposition_required|recording_encounter_closed)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\b(recording_participant_invalid|recording_participant_limit|recording_consent_invalid|recording_capture_invalid|recording_workspace_invalid)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\b(privacy_operator_required|privacy_operator_assignment_required|personal_purge_policy_required|retention_policy_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(privacy_correction_resolution_conflict|privacy_correction_not_applied|privacy_correction_target_changed|personal_purge_command_conflict|personal_purge_preview_changed|personal_purge_verification_failed|privacy_request_personal_store_changed)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\b(privacy_queue_invalid|privacy_correction_invalid|privacy_correction_resolution_invalid|personal_purge_request_invalid|personal_purge_inventory_too_large)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
    if (/\bexternal_inventory_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
    if (/\bexternal_inventory_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
    // Exact server-authored codes only. Never forward SQL/provider detail.
  // The public consult link and the clinic's queue. `consult_link_unavailable` is the one
  // answer given for an absent, disabled or expired slug, so the classification must not
  // split them either.
  if (/\b(consult_request_invalid|consult_link_invalid|consult_review_invalid)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bconsult_request_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(consult_link_unavailable|consult_request_unavailable|consult_link_absent|consult_request_absent|consult_request_immutable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(consult_link_closed|consult_link_slug_taken|consult_record_key_taken|consult_reference_unavailable|consult_request_state_invalid|consult_request_revision_stale)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  // Pre-visit forms. A form that is not published, and a packet or item that is not there,
  // are refusals about the object; a changed document or a recorded answer is a conflict the
  // caller has to re-read before retrying.
  if (/\b(intake_form_invalid|intake_packet_invalid|intake_form_content_invalid|intake_answers_invalid|intake_item_not_questionnaire|intake_item_not_document)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bintake_packet_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\bintake_consent_absent\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\b(intake_form_unpublished|intake_form_absent|intake_packet_absent|intake_item_absent|intake_form_immutable|intake_connection_absent|intake_connection_unavailable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(intake_form_not_draft|intake_form_not_published|intake_packet_state_invalid|intake_packet_revision_stale|intake_packet_past_due|intake_response_recorded|intake_signature_recorded|intake_form_changed|intake_agreement_changed)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  // Contesting a record, and revision notices. An absent subject and an absent dispute are
  // refusals about the object; a closed dispute and a stale revision are conflicts the caller
  // has to re-read before retrying.
  if (/\b(clinical_dispute_invalid|revision_notice_invalid|revision_statement_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bclinical_dispute_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(clinical_dispute_absent|clinical_dispute_subject_absent|clinical_dispute_connection_absent|clinical_dispute_immutable|revision_notice_absent|revision_notice_immutable|revision_version_absent|revision_version_unpublished)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(clinical_dispute_exists|clinical_dispute_closed|clinical_dispute_state_invalid|clinical_dispute_revision_stale)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  // The practice's own note templates and house style. A stale digest is the only conflict
  // here, and it means the draft changed between being read and being published.
  if (/\b(note_template_invalid|note_template_sections_invalid|note_style_invalid)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bnote_template_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(note_template_absent|note_template_draft_absent|note_template_version_immutable|practice_note_style_immutable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\bnote_template_digest_mismatch\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  // Compiling a cart from a published protocol. An absent manifest, an unpublished version and
  // a protocol with nothing to buy are all `operation_refused`: one answer for all of them, so a
  // caller cannot use the status to learn which protocols exist.
  if (/\bprotocol_cart_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bprotocol_cart_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(protocol_cart_absent|protocol_cart_version_absent|protocol_cart_version_unpublished|protocol_cart_no_supplements|protocol_cart_immutable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  // The practice outcome ledger. An undeclared code and an absent connection are one answer, and
  // a missing research consent is its own, because that one the practitioner can act on.
  if (/\b(outcome_ledger_invalid|outcome_age_out_of_range)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\boutcome_ledger_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\boutcome_consent_absent\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\b(outcome_code_absent|outcome_connection_absent)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  // Consult contact retention. `consult_contact_purged` is what an attempt to open an erased
  // envelope gets; it is a refusal about the object, not a failure to retry.
  if (/\bconsult_retention_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\bconsult_retention_forbidden\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(consult_contact_purged|consult_retention_immutable)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\bspecimen_consent_required\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\bspecimen_context_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\bspecimen_context_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\b(specimen_context_refused|specimen_provider_approval_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(owned_record_legal_hold|privacy_request_held|recording_cleanup_legal_hold)\b/.test(message)) return new ClinicalCoreDatabaseRejection("legal_hold");
  if (/\brecording_legal_hold\b/.test(message)) return new ClinicalCoreDatabaseRejection("legal_hold");
  if (/\b(recording_transcription_refused|recording_transcript_missing|recording_transcription_release_refused|recording_drafting_release_refused)\b/.test(message)) return new ClinicalCoreDatabaseRejection("operation_refused");
  if (/\b(recording_transcription_conflict|recording_segments_unresolved|recording_drafting_conflict|recording_transcript_superseded)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\b(recording_transcription_invalid|recording_transcription_artifact_invalid|recording_drafting_invalid)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\brecording_transcription_artifact_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\brecording_cleanup_not_ready\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\brecording_cleanup_attempt_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\brecording_cleanup_run_conflict\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\brecording_cleanup_run_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\brecording_cleanup_attempt_invalid\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\brecording_cleanup_attempt_required\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(recording_cleanup_operator_required|recording_cleanup_release_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\bowned_account_deletion_write_blocked\b/.test(message)) return new ClinicalCoreDatabaseRejection("account_deletion_write_blocked");
  if (/\bconsumer_owner_required\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(consumer_storage_consent_required|reviewed_consent_release_required)\b/.test(message)) return new ClinicalCoreDatabaseRejection("consent_required");
  if (/\b(owned_record_revision_conflict|owned_record_idempotency_conflict|consent_revision_conflict|privacy_export_conflict|privacy_export_job_state|privacy_export_job_busy)\b/.test(message)) return new ClinicalCoreDatabaseRejection("conflict");
  if (/\bprivacy_export_job_refused\b/.test(message)) return new ClinicalCoreDatabaseRejection("identity_refused");
  if (/\b(owned_record_request_invalid|consent_request_invalid|privacy_export_request_invalid)\b/.test(message)) return new ClinicalCoreDatabaseRejection("request_invalid");
  if (/\b(request_context_refused|synthetic_context_refused|production_context_refused|clinical_role_required|consumer_identity_required|consent_actor_refused|consumer_connection_refused|patient_access_refused)\b/.test(message)) {
    return new ClinicalCoreDatabaseRejection("identity_refused");
  }
  if (/\b(invitation_shape_invalid|invitation_invalid_or_expired|synthetic_patient_not_found|production_patient_not_found|connection_not_invitable|connection_state_invalid|approved_artifact_required|consent_scope_invalid|consent_precondition_failed|consent_already_active|active_consent_required|idempotency_conflict|resource_version_conflict|clinical_record_consent_required|verified_connection_required|connection_required|clinical_collection_invalid|clinical_query_invalid|clinical_record_invalid|privacy_request_invalid|compatibility_request_invalid|compatibility_tenant_refused|compatibility_operation_not_ported|compatibility_handler_missing|relationship_invitation_invalid|relationship_already_exists|relationship_not_found|relationship_version_conflict|relationship_revocation_reason_required)\b/.test(message)) {
    return new ClinicalCoreDatabaseRejection("operation_refused");
  }
  return undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : undefined;
}
