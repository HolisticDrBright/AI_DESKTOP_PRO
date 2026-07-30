/**
 * Client-safe bridge to the `/api/live/*` route handlers.
 *
 * This is the ONLY thing the facade calls in live mode from client components.
 * It does same-origin `fetch` and never imports server-only code, so no tRPC
 * client or credentials reach the browser bundle. Every failure surfaces as an
 * AdapterError with a safe message.
 */
import { AdapterError, codeFromHttpStatus, type AdapterErrorCode } from "./errors";
import type { LabWorkspace } from "./labs.types";
import type { KnowledgeImportBatch, KnowledgeImportSourceItem } from "./clinical-import.types";
import type { KnowledgePathway, KnowledgePathwayContent } from "./clinical-knowledge.types";
import type {
  LiveAppointmentStatusResult,
  LiveAuditEvent,
  LiveBookInput,
  LiveBookResult,
  LiveCalendar,
  LiveRescheduleResult,
  LiveQueueItem,
  LiveResolveResult,
  LiveReviewResult,
  LiveTaskResult,
  LiveUploadResult,
  LivePatientOverview,
  LiveReasoningWorkspace,
  LiveHypothesisReviewResult,
  LiveAppointmentStatus,
  LiveTransitionResult,
  LivePatientProtocol,
  LiveProtocolDraftPayload,
  LiveProtocolMutationResult,
  LiveProtocolTemplate,
  LiveCatalogSearch,
  LiveInteractionCheck,
  LiveInteractionReviewResult,
  ReviewDecision,
} from "./live-types";

interface Envelope<T> {
  data?: T;
  error?: { code?: AdapterErrorCode; message?: string };
}

async function liveFetch<T>(
  path: string,
  init: { method: "GET" | "POST" | "PUT"; body?: unknown; form?: FormData },
): Promise<T> {
  let res: Response;
  try {
    // FormData sets its own multipart boundary — no explicit content-type.
    res = await fetch(`/api/live/${path}`, {
      method: init.method,
      headers:
        init.form === undefined && init.body !== undefined
          ? { "content-type": "application/json" }
          : undefined,
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
  } catch (e) {
    throw new AdapterError("unavailable", undefined, e instanceof Error ? e.message : undefined);
  }

  let json: Envelope<T> = {};
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    /* leave json empty; handled below */
  }

  if (!res.ok || json.error) {
    const code = json.error?.code ?? codeFromHttpStatus(res.status);
    throw new AdapterError(code, json.error?.message);
  }
  return json.data as T;
}

export const liveClient = {
  labsWorkspace: (patientId: string) =>
    liveFetch<LabWorkspace>("labs/workspace", { method: "POST", body: { patientId } }),

  reviewMarker: (observationId: string, decision: ReviewDecision, note?: string) =>
    liveFetch<LiveReviewResult>("labs/review", {
      method: "POST",
      body: { observationId, decision, note },
    }),

  uploadLabDocument: (patientId: string, file: File) => {
    const form = new FormData();
    form.set("patientId", patientId);
    form.set("file", file);
    return liveFetch<LiveUploadResult>("labs/upload", { method: "POST", form });
  },

  scheduleCalendar: (fromIso: string, toIso: string) =>
    liveFetch<LiveCalendar>("schedule/calendar", { method: "POST", body: { fromIso, toIso } }),

  bookAppointment: (input: LiveBookInput) =>
    liveFetch<LiveBookResult>("schedule/book", { method: "POST", body: input }),

  updateAppointmentStatus: (appointmentId: string, status: string) =>
    liveFetch<LiveAppointmentStatusResult>("schedule/status", {
      method: "POST",
      body: { appointmentId, status },
    }),

  rescheduleAppointment: (appointmentId: string, startsAtIso: string, endsAtIso: string) =>
    liveFetch<LiveRescheduleResult>("schedule/reschedule", {
      method: "POST",
      body: { appointmentId, startsAtIso, endsAtIso },
    }),

  listQueue: () => liveFetch<LiveQueueItem[]>("tasks/queue", { method: "GET" }),

  resolveQueueItem: (itemId: string, note?: string) =>
    liveFetch<LiveResolveResult>("tasks/resolve", { method: "POST", body: { itemId, note } }),

  listAuditEvents: (limit = 50) =>
    liveFetch<LiveAuditEvent[]>(`actions/audit?limit=${limit}`, { method: "GET" }),

  recordAudit: (input: {
    eventType: string;
    resourceId?: string;
    patientId?: string;
    metadata?: Record<string, string | number | boolean>;
  }) => liveFetch<{ id: string }>("actions/audit", { method: "POST", body: input }),

  createReviewTask: (input: {
    patientId: string;
    title: string;
    itemType?: string;
    priority?: "low" | "medium" | "high";
    refId?: string;
  }) => liveFetch<LiveTaskResult>("actions/task", { method: "POST", body: input }),

  listKnowledgePathways: () =>
    liveFetch<KnowledgePathway[]>("knowledge/pathways", { method: "GET" }),

  createKnowledgeDraft: (input: {
    pathwayId: string;
    content: KnowledgePathwayContent;
    sourceRefs: string[];
    changeSummary: string;
  }) => liveFetch<{ versionId: string; version: number }>("knowledge/draft", {
    method: "POST",
    body: input,
  }),

  updateKnowledgeDraft: (input: {
    versionId: string;
    content: KnowledgePathwayContent;
    sourceRefs: string[];
    changeSummary: string;
  }) => liveFetch<{ ok: true }>("knowledge/draft", {
    method: "PUT",
    body: input,
  }),

  approveKnowledgeVersion: (versionId: string) =>
    liveFetch<{ ok: true }>("knowledge/approve", {
      method: "POST",
      body: { versionId },
    }),

  listKnowledgeImports: () =>
    liveFetch<KnowledgeImportBatch[]>("knowledge/imports", { method: "GET" }),

  stageKnowledgeImport: (input: {
    sourceName: string;
    sourceRevision?: string;
    schemaVersion: string;
    items: KnowledgeImportSourceItem[];
    attestsNoPhi: true;
  }) => liveFetch<{ batchId: string; itemCount: number }>("knowledge/imports", {
    method: "POST",
    body: input,
  }),

  patientOverview: (patientId: string) =>
    liveFetch<LivePatientOverview>("patients/overview", { method: "POST", body: { patientId } }),

  reasoningWorkspace: (patientId: string) =>
    liveFetch<LiveReasoningWorkspace>("reasoning/workspace", { method: "POST", body: { patientId } }),

  reviewHypothesis: (hypothesisId: string, action: "accepted" | "rejected" | "needs_data", note?: string) =>
    liveFetch<LiveHypothesisReviewResult>("reasoning/review", {
      method: "POST",
      body: { hypothesisId, action, note },
    }),

  /* ---------------------------------------------- front desk (phase 2) */
  transitionAppointment: (input: {
    appointmentId: string;
    toStatus: LiveAppointmentStatus;
    expectedVersion?: number | null;
    idempotencyKey?: string | null;
    reason?: string | null;
  }) => liveFetch<LiveTransitionResult>("schedule/transition", { method: "POST", body: input }),

  correctAppointmentStatus: (input: {
    appointmentId: string;
    toStatus: LiveAppointmentStatus;
    reason: string;
    expectedVersion?: number | null;
  }) => liveFetch<LiveTransitionResult>("schedule/correct", { method: "POST", body: input }),

  /* ---------------------------------------------- protocols (phase 2) */
  patientProtocol: (patientId: string) =>
    liveFetch<LivePatientProtocol>("protocols/patient", { method: "POST", body: { patientId } }),

  listProtocolTemplates: (includeArchived = false) =>
    liveFetch<LiveProtocolTemplate[]>("protocols/templates", {
      method: "POST",
      body: { includeArchived },
    }),

  createProtocolDraft: (input: {
    patientId: string;
    title: string;
    fromTemplateId?: string | null;
  }) => liveFetch<LiveProtocolMutationResult>("protocols/draft", { method: "POST", body: input }),

  saveProtocolDraft: (input: {
    versionId: string;
    payload: LiveProtocolDraftPayload;
    expectedUpdatedAt: string | null;
  }) => liveFetch<LiveProtocolMutationResult>("protocols/save", { method: "POST", body: input }),

  protocolAction: (input: {
    action: "approve" | "activate" | "revise" | "lifecycle";
    versionId?: string;
    protocolId?: string;
    reviewNote?: string | null;
    status?: "active" | "paused" | "completed" | "discontinued";
    reason?: string | null;
  }) => liveFetch<LiveProtocolMutationResult>("protocols/action", { method: "POST", body: input }),

  searchProtocolCatalog: (query: string | null, limit = 20) =>
    liveFetch<LiveCatalogSearch>("protocols/catalog", {
      method: "POST",
      body: { query, limit },
    }),

  checkProtocolInteractions: (versionId: string) =>
    liveFetch<LiveInteractionCheck>("protocols/interactions", {
      method: "POST",
      body: { versionId },
    }),

  reviewProtocolItemInteractions: (itemId: string, note: string | null) =>
    liveFetch<LiveInteractionReviewResult>("protocols/interaction-review", {
      method: "POST",
      body: { itemId, note },
    }),

  protocolTemplateAction: (input: {
    action: "create" | "approve" | "archive";
    name?: string;
    description?: string | null;
    fromVersionId?: string | null;
    versionId?: string;
    templateId?: string;
    archived?: boolean;
  }) => liveFetch<LiveProtocolMutationResult>("protocols/template-action", {
    method: "POST",
    body: input,
  }),

  reviewKnowledgeImportItem: (
    itemId: string,
    decision: "accept" | "reject",
    reviewNote?: string,
  ) => liveFetch<{
    status: "applied" | "rejected";
    appliedRefType: string | null;
    appliedRefId: string | null;
  }>("knowledge/import-item", {
    method: "POST",
    body: { itemId, decision, reviewNote },
  }),
};
