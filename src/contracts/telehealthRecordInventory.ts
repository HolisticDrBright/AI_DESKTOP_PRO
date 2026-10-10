/**
 * Telehealth record inventory — where every piece of telehealth text lives and
 * which governed control reaches it.
 *
 * This is INVENTORY, not deletion authority and not a retention policy. The
 * clinical project has no approved retention/disposition policy yet
 * (`clinical_private.owned_retention_policies` has no rows), so nothing here
 * names a duration, promises a deletion, or certifies a provider copy erased.
 * Each location states the control that covers it today and, where a control
 * does not exist, says so.
 *
 * Stores:
 *   - `telehealth_visit_record`  the DynamoDB visit item (telehealth Lambda)
 *   - `chart`                    the clinical database: encounters, clinical
 *                                notes, note versions, signatures, addenda,
 *                                provenance and the transfer ledger
 *   - `zoom`                     the provider's own copies (meeting, cloud
 *                                recording, AI Companion summary)
 *   - `backups`                  point-in-time recovery of the visit table and
 *                                database backups
 *
 * Owner correction and clinician amendment are different authorities: an owner
 * request never rewrites a signed record; a clinician amends through the
 * chart's append-only addendum with reason, author, time and referenced
 * version. Consent withdrawal stops NEW processing (no further AI import, no
 * new visit) and claims no deletion.
 */

export const TELEHEALTH_RECORD_INVENTORY_CONTRACT = "telehealth-record-inventory/1" as const;

export type TelehealthRecordStore = "telehealth_visit_record" | "chart" | "zoom" | "backups";

/** What a control can truthfully say about a location today. */
export type TelehealthControlCoverage =
  | "covered"            // an existing governed interface reaches this location
  | "reported_only"      // the location is listed and observable, nothing acts on it
  | "not_covered"        // no interface reaches it; the gap is stated
  | "blocked_pending_policy"; // the mechanism exists but is refused until a reviewed policy/decision exists

export interface TelehealthRecordLocation {
  /** Stable id used by inventories and tests. */
  id: string;
  store: TelehealthRecordStore;
  /** Where it is, in the store's own terms (attribute path, table, provider object). */
  path: string;
  /** Whether this location holds clinical text (as opposed to identifiers or state). */
  text: boolean;
  controls: {
    /** How the text leaves the system in an owner- or clinic-authorized export. */
    export: { coverage: TelehealthControlCoverage; via: string };
    /** Correction after signature. */
    amendment: { coverage: TelehealthControlCoverage; via: string };
    /** Retention schedule. */
    retention: { coverage: TelehealthControlCoverage; via: string };
    /** Legal hold. */
    hold: { coverage: TelehealthControlCoverage; via: string };
    /** Erasure accounting: what a deletion receipt may claim about this location. */
    erasure: { coverage: TelehealthControlCoverage; via: string };
  };
}

const CHART_AMENDMENT = { coverage: "covered" as const, via: "clinical_core.add_note_addendum: append-only, with reason, author, time and referenced version; the original version and signature are kept" };
const NO_RETENTION_POLICY = { coverage: "blocked_pending_policy" as const, via: "no approved retention/disposition policy exists (owned_retention_policies has no rows); no duration is chosen here" };
const CHART_HOLD = { coverage: "covered" as const, via: "clinical_private.recording_legal_holds on the patient record, reported by get_telehealth_record_authority as legal_hold" };
const CLINIC_RECORD_ERASURE = { coverage: "blocked_pending_policy" as const, via: "privacy operator recordDisposition for the clinic_records store: a recorded disposition or retained_by_policy, never a purged claim; the visit record has no deletion route" };
const CHART_ERASURE = { coverage: "blocked_pending_policy" as const, via: "chart tables are append-only (block_update_delete) and covered-entity inventory says 'blocked by immutable trigger until a separately reviewed clinic retention/disposition procedure exists'" };
const WORKFORCE_EXPORT = { coverage: "covered" as const, via: "GET /clinical-core/workforce/appointments/visits/notes under the retained-record authority returns the full record; GET .../notes/inventory lists every location with digests" };
const CHART_EXPORT = { coverage: "covered" as const, via: "clinical_core.get_desktop_note / get_desktop_encounter under require_clinical_patient; the transfer ledger carries the complete source payload" };
const ZOOM_NOT_COVERED = { coverage: "not_covered" as const, via: "the provider's copy stays in Zoom under Zoom's retention; this deployment holds no delete permission and never certifies it erased" };
const BACKUP_NOT_COVERED = { coverage: "not_covered" as const, via: "point-in-time recovery and database backups are outside every receipt; listed, never certified erased" };
const BACKUP_HOLD = { coverage: "not_covered" as const, via: "no hold mechanism reaches backups; a hold on the live record does not alter backup retention" };
const VISIT_HOLD = { coverage: "reported_only" as const, via: "the visit record has no hold of its own; the patient's chart hold is read through get_telehealth_record_authority and shown with the record" };
const NO_AMENDMENT = { coverage: "not_covered" as const, via: "not a clinical statement; nothing to amend" };
const FROZEN_SOURCE = { coverage: "covered" as const, via: "a signed visit note is frozen on the visit; corrections are made on the chart draft/note through add_note_addendum, with the original kept here as the recorded source" };

export const TELEHEALTH_RECORD_LOCATIONS: readonly TelehealthRecordLocation[] = [
  { id: "visit.quickNotes", store: "telehealth_visit_record", path: "VisitItem.quickNotes", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: FROZEN_SOURCE, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.flags", store: "telehealth_visit_record", path: "VisitItem.flags[].label", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: FROZEN_SOURCE, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.note.aiOriginal", store: "telehealth_visit_record", path: "VisitItem.note.aiOriginal (Zoom's full AI Companion payload, verbatim)", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.note.aiSections", store: "telehealth_visit_record", path: "VisitItem.note.aiSections.{summary,patient_reported,results_reviewed,plan_discussed}", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: FROZEN_SOURCE, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.note.practitionerNotes", store: "telehealth_visit_record", path: "VisitItem.note.practitionerNotes", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: FROZEN_SOURCE, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.note.actionItems", store: "telehealth_visit_record", path: "VisitItem.note.actionItems[].{text,status}", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: FROZEN_SOURCE, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.note.signature", store: "telehealth_visit_record", path: "VisitItem.note.{signedAt,signedBy,revision}", text: false,
    controls: { export: WORKFORCE_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.noteHistory", store: "telehealth_visit_record", path: "VisitItem.noteHistory[] (superseded revisions, same fields as note)", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.consents", store: "telehealth_visit_record", path: "VisitItem.consents[] (receipts: artifact id/version/hash, signer name, method, status)", text: true,
    controls: { export: WORKFORCE_EXPORT, amendment: { coverage: "covered", via: "append-only receipts; withdrawal marks, never removes" }, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.chartTransfer", store: "telehealth_visit_record", path: "VisitItem.chartTransfer (transfer id, source revision/digest, destination ids)", text: false,
    controls: { export: WORKFORCE_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "visit.providerIdentifiers", store: "telehealth_visit_record", path: "VisitItem.{providerMeetingId,providerMeetingUuid,joinUrl,note.zoomSummaryId}", text: false,
    controls: { export: WORKFORCE_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: VISIT_HOLD, erasure: CLINIC_RECORD_ERASURE } },
  { id: "chart.transferLedger", store: "chart", path: "clinical_core.telehealth_note_transfers.source_payload (complete provider summary, reviewed sections, practitioner text, action items, consent summary)", text: true,
    controls: { export: CHART_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: CHART_HOLD, erasure: CHART_ERASURE } },
  { id: "chart.noteDraft", store: "chart", path: "clinical_core.clinical_note_versions.content (the unsigned narrative draft and every later version)", text: true,
    controls: { export: CHART_EXPORT, amendment: CHART_AMENDMENT, retention: NO_RETENTION_POLICY, hold: CHART_HOLD, erasure: CHART_ERASURE } },
  { id: "chart.noteProvenance", store: "chart", path: "clinical_core.note_provenance_refs (telehealth_visit / practitioner_entered labels)", text: false,
    controls: { export: CHART_EXPORT, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: CHART_HOLD, erasure: CHART_ERASURE } },
  { id: "chart.addenda", store: "chart", path: "clinical_core.note_addenda (reason, content, referenced version)", text: true,
    controls: { export: CHART_EXPORT, amendment: CHART_AMENDMENT, retention: NO_RETENTION_POLICY, hold: CHART_HOLD, erasure: CHART_ERASURE } },
  { id: "chart.audit", store: "chart", path: "clinical_audit.events (telehealth.note_transferred, note.*; safe metadata only, no text)", text: false,
    controls: { export: { coverage: "covered", via: "list_audit_events" }, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: CHART_HOLD, erasure: CHART_ERASURE } },
  { id: "zoom.meeting", store: "zoom", path: "Zoom meeting object (id, uuid, join URL, password) in the host account", text: false,
    controls: { export: { coverage: "reported_only", via: "identifiers are in the visit record; the object itself is the provider's" }, amendment: NO_AMENDMENT, retention: { coverage: "not_covered", via: "Zoom's own retention" }, hold: { coverage: "not_covered", via: "no hold reaches the provider" }, erasure: ZOOM_NOT_COVERED } },
  { id: "zoom.aiCompanionSummary", store: "zoom", path: "Zoom AI Companion summary for the meeting instance (and any cloud recording/transcript Zoom keeps)", text: true,
    controls: { export: { coverage: "reported_only", via: "the imported copy is aiOriginal; the provider copy is Zoom's" }, amendment: NO_AMENDMENT, retention: { coverage: "not_covered", via: "Zoom's own retention; an open decision in docs/telehealth.md" }, hold: { coverage: "not_covered", via: "no hold reaches the provider" }, erasure: ZOOM_NOT_COVERED } },
  { id: "backups.visitTable", store: "backups", path: "DynamoDB point-in-time recovery of the telehealth table (DeletionPolicy Retain)", text: true,
    controls: { export: BACKUP_NOT_COVERED, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: BACKUP_HOLD, erasure: BACKUP_NOT_COVERED } },
  { id: "backups.database", store: "backups", path: "Clinical database backups (chart tables)", text: true,
    controls: { export: BACKUP_NOT_COVERED, amendment: NO_AMENDMENT, retention: NO_RETENTION_POLICY, hold: BACKUP_HOLD, erasure: BACKUP_NOT_COVERED } },
];

/** One visit's inventory: every location with presence, digest and size, never the text itself. */
export interface TelehealthRecordInventory {
  contract: typeof TELEHEALTH_RECORD_INVENTORY_CONTRACT;
  appointmentId: string;
  organizationId: string;
  patientRecordId: string | null;
  visitStatus: string;
  /** True when the patient's chart records are under an active legal hold (from the retained-record authority). */
  legalHold: boolean | null;
  consent: { granted: boolean; withdrawn: boolean; withdrawnAt: string | null };
  /** Consent withdrawal stops new processing; it is never a deletion receipt. */
  processing: { aiImportAllowed: boolean; reason: string };
  locations: Array<{
    id: string;
    store: TelehealthRecordStore;
    present: boolean;
    /** sha256 of the canonical JSON of what is there (null when absent or when the store is not readable from here). */
    sha256: string | null;
    bytes: number | null;
    /** Number of retained items for list-like locations (revisions, flags, consents). */
    count: number | null;
    identifiers?: Record<string, string | null>;
    controls: TelehealthRecordLocation["controls"];
  }>;
  /** What no receipt from this system may claim. */
  notCertifiable: string[];
}

export function telehealthRecordLocation(id: string): TelehealthRecordLocation {
  const found = TELEHEALTH_RECORD_LOCATIONS.find((location) => location.id === id);
  if (!found) throw new Error(`unknown telehealth record location: ${id}`);
  return found;
}
