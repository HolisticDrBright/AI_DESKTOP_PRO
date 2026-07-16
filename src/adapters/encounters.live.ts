if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { resolveOrgId } from "./config";

/**
 * Live EMR namespace (server-only): encounters + clinical notes (Phase 2
 * slice 1). Every mutation lands in a SECURITY DEFINER RPC (migration 0021)
 * that enforces the state machines, signed-note immutability, idempotent
 * signing, tenant agreement, and atomic audit — this module only threads the
 * caller's session and shapes typed DTOs.
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
  | "practitioner_entered";

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

export const encountersLive = {
  start(
    input: { patientId: string; visitType: string; appointmentId?: string },
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<{ encounterId: string }> {
    return trpcMutation("clinical.encounters.start", {
      organizationId: resolveOrgId(orgId),
      patientId: input.patientId,
      visitType: input.visitType,
      appointmentId: input.appointmentId,
    }, sessionToken);
  },

  setStatus(
    input: { encounterId: string; status: "completed" | "cancelled" | "entered_in_error"; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation("clinical.encounters.setStatus", input, sessionToken);
  },

  get(
    encounterId: string,
    sessionToken?: string | null,
  ): Promise<{ encounter: LiveEncounter; notes: LiveNoteSummary[] }> {
    return trpcQuery("clinical.encounters.get", { encounterId }, sessionToken);
  },

  forPatient(patientId: string, sessionToken?: string | null): Promise<LiveEncounter[]> {
    return trpcQuery("clinical.encounters.forPatient", { patientId }, sessionToken);
  },

  saveNote(
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
    return trpcMutation("clinical.notes.save", {
      organizationId: resolveOrgId(orgId),
      ...input,
    }, sessionToken);
  },

  getNote(noteId: string, sessionToken?: string | null): Promise<LiveNoteDetail> {
    return trpcQuery("clinical.notes.get", { noteId }, sessionToken);
  },

  markNoteReady(noteId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation("clinical.notes.markReady", { noteId }, sessionToken);
  },

  signNote(
    input: { noteId: string; expectedVersion: number },
    sessionToken?: string | null,
  ): Promise<{ signatureId: string; alreadySigned: boolean; version: number; signedAt: string }> {
    return trpcMutation("clinical.notes.sign", input, sessionToken);
  },

  addAddendum(
    input: { noteId: string; reason: string; content: string },
    sessionToken?: string | null,
  ): Promise<{ addendumId: string }> {
    return trpcMutation("clinical.notes.addAddendum", input, sessionToken);
  },

  markNoteError(
    input: { noteId: string; reason: string },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation("clinical.notes.markError", input, sessionToken);
  },

  timeline(patientId: string, sessionToken?: string | null): Promise<TimelineEvent[]> {
    return trpcQuery("clinical.notes.timeline", { patientId }, sessionToken);
  },
};
