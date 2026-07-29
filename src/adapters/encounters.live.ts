if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./supabase-rest.server";

/**
 * Desktop-owned EMR namespace (server-only): encounters + clinical notes.
 *
 * Reads use bounded Desktop DTO functions. Mutations call the existing
 * database state machines directly as the signed-in practitioner, preserving
 * signed-note immutability, optimistic concurrency, append-only addenda,
 * tenant agreement, and atomic audit.
 */

export type EncounterStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "entered_in_error";

export type NoteStatus = "draft" | "ready_for_review" | "signed" | "amended" | "entered_in_error";

export type NoteType = "soap" | "narrative" | "follow_up" | "adime" | "patient_instructions";

export type ProvenanceType =
  | "appointment"
  | "encounter"
  | "lab_observation"
  | "lab_document"
  | "patient_form"
  | "chart_item"
  | "practitioner_entered"
  | "transcript"
  | "differential_question"
  | "lens_evaluation";

export interface LiveEncounter {
  encounterId: string;
  organizationId: string;
  patientId: string;
  appointmentId: string | null;
  visitType: string | null;
  status: EncounterStatus;
  startedAt: string | null;
  endedAt: string | null;
  statusReason: string | null;
  createdAt: string;
}

export interface LiveNoteSummary {
  noteId: string;
  encounterId: string;
  patientId: string;
  noteType: NoteType;
  status: NoteStatus;
  currentVersion: number;
  authorUserId: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvenanceRef {
  sectionKey: string;
  refType: ProvenanceType;
  refId?: string | null;
  label: string;
}

export interface LiveNoteDetail {
  note: LiveNoteSummary;
  content: Record<string, string>;
  contentVersion: number;
  lastSavedAt: string | null;
  signature: {
    signatureId: string;
    version: number;
    signedBy: string;
    signedAt: string;
    attestation: string;
  } | null;
  addenda: {
    addendumId: string;
    referencedVersion: number;
    authorUserId: string;
    reason: string;
    content: string;
    createdAt: string;
  }[];
  provenance: ProvenanceRef[];
}

export interface TimelineEvent {
  eventAt: string;
  eventType: string;
  title: string;
  refType: string;
  refId: string;
  detail: Record<string, unknown>;
}

interface EncounterRow {
  encounter_id: string;
  organization_id: string;
  patient_id: string;
  appointment_id: string | null;
  visit_type: string | null;
  status: EncounterStatus;
  started_at: string | null;
  ended_at: string | null;
  status_reason: string | null;
  created_at: string;
}

interface NoteSummaryRow {
  note_id: string;
  encounter_id: string;
  patient_id: string;
  note_type: NoteType;
  status: NoteStatus;
  current_version: number;
  author_user_id: string;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface NoteDetailRow {
  note: NoteSummaryRow;
  content: Record<string, string>;
  content_version: number;
  last_saved_at: string | null;
  signature: {
    signature_id: string;
    version: number;
    signed_by: string;
    signed_at: string;
    attestation: string;
  } | null;
  addenda: Array<{
    addendum_id: string;
    referenced_version: number;
    author_user_id: string;
    reason: string;
    content: string;
    created_at: string;
  }>;
  provenance: Array<{
    section_key: string;
    ref_type: ProvenanceType;
    ref_id: string | null;
    label: string;
  }>;
}

interface TimelineRow {
  event_at: string;
  event_type: string;
  title: string;
  ref_type: string;
  ref_id: string;
  detail: Record<string, unknown> | null;
}

function mapEncounter(row: EncounterRow): LiveEncounter {
  return {
    encounterId: row.encounter_id,
    organizationId: row.organization_id,
    patientId: row.patient_id,
    appointmentId: row.appointment_id,
    visitType: row.visit_type,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    statusReason: row.status_reason,
    createdAt: row.created_at,
  };
}

function mapNoteSummary(row: NoteSummaryRow): LiveNoteSummary {
  return {
    noteId: row.note_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    noteType: row.note_type,
    status: row.status,
    currentVersion: row.current_version,
    authorUserId: row.author_user_id,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const encountersLive = {
  async start(
    input: { patientId: string; visitType: string; appointmentId?: string },
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<{ encounterId: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    const encounterId = await clinicalRpc<string>("start_encounter", {
      _organization_id: resolveOrgId(orgId),
      _patient_id: input.patientId,
      _visit_type: input.visitType,
      _appointment_id: input.appointmentId ?? null,
    }, token);
    return { encounterId };
  },

  async setStatus(
    input: { encounterId: string; status: "completed" | "cancelled" | "entered_in_error"; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("set_encounter_status", {
      _encounter_id: input.encounterId,
      _status: input.status,
      _reason: input.reason ?? null,
    }, token);
    return { ok: true };
  },

  async get(
    encounterId: string,
    sessionToken?: string | null,
  ): Promise<{ encounter: LiveEncounter; notes: LiveNoteSummary[] }> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      encounter: EncounterRow;
      notes: NoteSummaryRow[];
    }>("get_desktop_encounter", {
      _encounter_id: encounterId,
    }, token);
    return {
      encounter: mapEncounter(result.encounter),
      notes: result.notes.map(mapNoteSummary),
    };
  },

  async forPatient(patientId: string, sessionToken?: string | null): Promise<LiveEncounter[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalRpc<EncounterRow[]>("list_desktop_patient_encounters", {
      _patient_id: patientId,
      _limit: 100,
    }, token);
    return rows.map(mapEncounter);
  },

  async saveNote(
    input: {
      encounterId: string;
      noteType: NoteType;
      content: Record<string, string>;
      expectedVersion: number;
      noteId?: string;
      saveKind: "autosave" | "manual";
      provenance: ProvenanceRef[];
    },
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<{ noteId: string; version: number; savedAt: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      note_id: string;
      version: number;
      saved_at: string;
    }>("save_note_draft", {
      _organization_id: resolveOrgId(orgId),
      _encounter_id: input.encounterId,
      _note_type: input.noteType,
      _content: input.content,
      _expected_version: input.expectedVersion,
      _note_id: input.noteId ?? null,
      _save_kind: input.saveKind,
      _provenance: input.provenance,
    }, token);
    return {
      noteId: result.note_id,
      version: result.version,
      savedAt: result.saved_at,
    };
  },

  async getNote(noteId: string, sessionToken?: string | null): Promise<LiveNoteDetail> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<NoteDetailRow>("get_desktop_note", {
      _note_id: noteId,
    }, token);
    return {
      note: mapNoteSummary(result.note),
      content: result.content,
      contentVersion: result.content_version,
      lastSavedAt: result.last_saved_at,
      signature: result.signature
        ? {
            signatureId: result.signature.signature_id,
            version: result.signature.version,
            signedBy: result.signature.signed_by,
            signedAt: result.signature.signed_at,
            attestation: result.signature.attestation,
          }
        : null,
      addenda: result.addenda.map((row) => ({
        addendumId: row.addendum_id,
        referencedVersion: row.referenced_version,
        authorUserId: row.author_user_id,
        reason: row.reason,
        content: row.content,
        createdAt: row.created_at,
      })),
      provenance: result.provenance.map((row) => ({
        sectionKey: row.section_key,
        refType: row.ref_type,
        refId: row.ref_id,
        label: row.label,
      })),
    };
  },

  async markNoteReady(noteId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("mark_note_ready", { _note_id: noteId }, token);
    return { ok: true };
  },

  async signNote(
    input: { noteId: string; expectedVersion: number },
    sessionToken?: string | null,
  ): Promise<{ signatureId: string; alreadySigned: boolean; version: number; signedAt: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      signature_id: string;
      already_signed: boolean;
      version: number;
      signed_at: string;
    }>("sign_note", {
      _note_id: input.noteId,
      _expected_version: input.expectedVersion,
    }, token);
    return {
      signatureId: result.signature_id,
      alreadySigned: result.already_signed,
      version: result.version,
      signedAt: result.signed_at,
    };
  },

  async addAddendum(
    input: { noteId: string; reason: string; content: string },
    sessionToken?: string | null,
  ): Promise<{ addendumId: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    const addendumId = await clinicalRpc<string>("add_note_addendum", {
      _note_id: input.noteId,
      _reason: input.reason,
      _content: input.content,
    }, token);
    return { addendumId };
  },

  async markNoteError(
    input: { noteId: string; reason: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>("mark_note_error", {
      _note_id: input.noteId,
      _reason: input.reason,
    }, token);
    return { ok: true };
  },

  async timeline(patientId: string, sessionToken?: string | null): Promise<TimelineEvent[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalRpc<TimelineRow[]>("get_desktop_patient_timeline", {
      _patient_id: patientId,
      _limit: 200,
    }, token);
    return rows.map((row) => ({
      eventAt: row.event_at,
      eventType: row.event_type,
      title: row.title,
      refType: row.ref_type,
      refId: row.ref_id,
      detail: row.detail ?? {},
    }));
  },
};
