/**
 * Data adapter façade.
 *
 * The UI consumes data exclusively through this `api` object, shaped the way
 * the future tRPC client will be (async, per-domain namespaces). Swapping a
 * namespace from mock to live means adding a flag branch here — components
 * never change, and never import Supabase/tRPC/live modules directly.
 *
 * Live wiring status (NEXT_PUBLIC_USE_LIVE_API):
 *   - patients.list / patients.get  -> live (server components, tRPC)
 *   - labs.getWorkspace / reviewMarker / flagMarker / createReviewTask -> live
 *     (client components -> /api/live/* route handlers -> tRPC -> RPCs 0013)
 *   - actions.listLiveAuditEvents   -> live (dual-mode Audit Log)
 *   - everything else               -> mock/demo session (see docs/live-api.md)
 */
import {
  DEFAULT_PATIENT_ID,
  getPatient,
  getPatientSummary,
  listPatients,
} from "./patients.mock";
import { getPracticeDashboard, getRightRail } from "./practice.mock";
import { getAssistantSession } from "./assistant.mock";
import { getCommandGroups } from "./commands.mock";
import { generateDraft, type ComposerContext } from "./composer.mock";
import { buildImportPlan, type ImportSourceId } from "./imports.mock";
import { getTaskQueue } from "./tasks.mock";
import { getLabWorkspace, type OptimalRange } from "./labs.mock";
import { getReasoningWorkspace } from "./reasoning.mock";
import { getSupplementWorkspace } from "./supplements.mock";
import { getHealthTwin } from "./twin.mock";
import { getActiveExperiments, getCompletedExperiments } from "./experiments.mock";
import { getClientRows } from "./clients.mock";
import { getProgramTemplates } from "./programs.mock";
import { getConnectors } from "./integrations.mock";
import { CAPABILITIES, ROLES } from "./permissions.mock";
import { USE_LIVE_API } from "./config";
import { liveClient } from "./live-client";
import { runClinicalMutation, type MutationOutcome } from "./mutations";
import {
  executeAction,
  type ActionContext,
  type ActionKind,
} from "./actions";
import {
  addSessionQueueItem,
  clearAuditEntries,
  getReviewOutcome,
  listAuditEntries,
  recordAuditEntry,
  removeReviewOutcome,
  setReviewOutcome,
} from "./session-store";
import type { LiveAuditEvent } from "./live-types";
import type { DraftKind } from "./types";

/** Context passed to lab marker mutations so the audit entry is meaningful. */
interface LabMarkerCtx {
  patientId: string;
  patientName: string;
  markerName: string;
}

export const api = {
  patients: {
    // When USE_LIVE_API is on, list/get read real patient_profiles rows through
    // the authenticated tRPC backend (RLS enforced). The live module is loaded
    // lazily so the default mock build never pulls in server-only code.
    list: async () => {
      if (USE_LIVE_API) return (await import("./patients.live")).patientsLive.list();
      return listPatients();
    },
    get: async (id: string) => {
      if (USE_LIVE_API) return (await import("./patients.live")).patientsLive.get(id);
      return getPatient(id);
    },
    summary: async (id: string) => getPatientSummary(id),
  },
  practice: {
    dashboard: async () => getPracticeDashboard(),
    rightRail: async () => getRightRail(),
  },
  assistant: {
    session: async () => getAssistantSession(),
  },
  commands: {
    groups: async (patientId?: string) => getCommandGroups(patientId),
  },
  composer: {
    /** MOCK draft generation. Replace with a server-side generation call. */
    generate: async (kind: DraftKind, context: ComposerContext) =>
      generateDraft(kind, context),
  },
  imports: {
    /** MOCK import planning. Replace with a real parse + match pipeline. */
    plan: async (sourceId: ImportSourceId) => buildImportPlan(sourceId),
  },
  actions: {
    /**
     * Execute a review action. MOCK: records to the demo session audit store
     * and settles any linked review. The labs-review slice persists through
     * `labs.reviewMarker` instead; other namespaces stay demo until wired.
     */
    execute: async (kind: ActionKind, context: ActionContext, timestamp: string) =>
      executeAction(kind, context, timestamp),
    /** Demo session audit log (sessionStorage). Not backend persistence. */
    listAuditEvents: () => listAuditEntries(),
    /** Live append-only audit log for the caller's org (empty in mock mode). */
    listLiveAuditEvents: async (limit = 50): Promise<LiveAuditEvent[]> =>
      USE_LIVE_API ? liveClient.listAuditEvents(limit) : [],
    /** Clear the demo session audit log (demo reset). */
    clearSessionAuditEvents: () => clearAuditEntries(),
  },
  tasks: {
    /** MOCK practitioner review queue. Replace with a tRPC query. */
    getQueue: async () => getTaskQueue(),
  },
  reasoning: {
    /** MOCK reasoning workspace. Replace with a tRPC query. */
    getWorkspace: async (patientId: string) => getReasoningWorkspace(patientId),
  },
  supplements: {
    /** MOCK supplement workspace. Replace with a tRPC query. */
    getWorkspace: async (patientId: string) => getSupplementWorkspace(patientId),
  },
  healthTwin: {
    /** MOCK health-twin system map (with snapshots). Replace with a tRPC query. */
    getMap: async (patientId: string) => getHealthTwin(patientId),
  },
  experiments: {
    /** MOCK N-of-1 experiments. Replace with tRPC queries. */
    listActive: async () => getActiveExperiments(),
    listCompleted: async () => getCompletedExperiments(),
  },
  clients: {
    /** MOCK client directory. Replace with a tRPC query. */
    list: async () => getClientRows(),
  },
  programs: {
    /** MOCK program templates. Replace with tRPC queries. */
    listTemplates: async () => getProgramTemplates(),
  },
  integrations: {
    /** MOCK connector health. Replace with a tRPC query. */
    getConnectors: async () => getConnectors(),
  },
  permissions: {
    /** MOCK role/permission matrix (intended policy; DB enforces). */
    getMatrix: async () => ({ roles: ROLES, capabilities: CAPABILITIES }),
  },
  labs: {
    /**
     * Labs workspace read. LIVE: real biomarker_observations via the tRPC
     * backend (RLS-scoped, reference intervals preserved). MOCK: demo workspace.
     */
    getWorkspace: async (patientId: string, patientName?: string) => {
      if (USE_LIVE_API) return liveClient.labsWorkspace(patientId);
      return getLabWorkspace(patientId, patientName);
    },
    /**
     * Mark a marker reviewed. LIVE: `review_biomarker` RPC updates the review
     * columns and appends an audit_events row atomically (migration 0013),
     * stamping reviewer id server-side and preserving lab values/provenance.
     * MOCK: session review state + session audit entry.
     */
    reviewMarker: async (markerId: string, ctx: LabMarkerCtx): Promise<MutationOutcome> => {
      const key = `lab:${ctx.patientId}:${markerId}`;
      const prev = getReviewOutcome(key);
      return runClinicalMutation({
        optimistic: () => setReviewOutcome(key, "reviewed"),
        rollback: () => (prev ? setReviewOutcome(key, prev) : removeReviewOutcome(key)),
        live: () => liveClient.reviewMarker(markerId, "accepted"),
        demo: () =>
          recordAuditEntry({
            kind: "mark_reviewed",
            subjectType: "lab marker",
            subjectLabel: ctx.markerName,
            patientName: ctx.patientName,
            reviewed: true,
            outcome: "reviewed",
          }),
        liveMessage: `Marked reviewed: ${ctx.markerName}. (saved to record)`,
        demoMessage: `Marked reviewed: ${ctx.markerName}. (demo — not persisted)`,
      });
    },
    /** Flag a marker for further review. LIVE: review_biomarker(flagged) + audit. */
    flagMarker: async (markerId: string, ctx: LabMarkerCtx): Promise<MutationOutcome> => {
      const key = `lab:${ctx.patientId}:${markerId}`;
      const prev = getReviewOutcome(key);
      return runClinicalMutation({
        optimistic: () => setReviewOutcome(key, "flagged"),
        rollback: () => (prev ? setReviewOutcome(key, prev) : removeReviewOutcome(key)),
        live: () => liveClient.reviewMarker(markerId, "flagged"),
        demo: () =>
          recordAuditEntry({
            kind: "flag",
            subjectType: "lab marker",
            subjectLabel: ctx.markerName,
            patientName: ctx.patientName,
            reviewed: false,
            outcome: "flagged",
          }),
        liveMessage: `Flagged for review: ${ctx.markerName}. (saved to record)`,
        demoMessage: `Flagged for review: ${ctx.markerName}. (demo — not persisted)`,
      });
    },
    /**
     * Downstream link from a review: enqueue a follow-up review task. LIVE:
     * `create_review_task` RPC (+ audit). MOCK: a session queue item that
     * surfaces on the Tasks screen this session.
     */
    createReviewTask: async (input: {
      markerId: string;
      markerName: string;
      patientId: string;
      patientName: string;
      priority?: "High" | "Medium" | "Low";
    }): Promise<MutationOutcome> => {
      const priority = input.priority ?? "Medium";
      return runClinicalMutation({
        live: () =>
          liveClient.createReviewTask({
            patientId: input.patientId,
            title: `Follow up: ${input.markerName}`,
            itemType: "abnormal_result",
            priority: priority.toLowerCase() as "low" | "medium" | "high",
            refId: input.markerId,
          }),
        demo: () =>
          addSessionQueueItem({
            title: `Follow up: ${input.markerName}`,
            patientName: input.patientName,
            patientId: input.patientId,
            category: "Lab review",
            priority,
            seeds: [`Lab marker ${input.markerName} flagged for follow-up.`],
          }),
        liveMessage: `Follow-up task created for ${input.markerName}. (saved to queue)`,
        demoMessage: `Follow-up task created for ${input.markerName}. (demo — session queue)`,
      });
    },
    /** Configure the practice optimal range (never touches the lab reference interval). */
    configureOptimalRange: async (markerId: string, range: OptimalRange, ctx: LabMarkerCtx) => {
      recordAuditEntry({
        kind: "configure_range",
        subjectType: "optimal range",
        subjectLabel: `${ctx.markerName} → ${range.min ?? "—"}–${range.max ?? "—"} ${range.unit}`,
        patientName: ctx.patientName,
        reviewed: true,
      });
      return { ok: true, message: `Optimal range updated: ${ctx.markerName}. (demo — not persisted)` };
    },
    /** Queue a demo upload — no file is uploaded, no persistence. */
    queueUploadDemo: async (input: { source: string; lab: string; patientName: string }) => {
      recordAuditEntry({
        kind: "order_lab",
        subjectType: "lab upload",
        subjectLabel: `${input.lab} · ${input.source}`,
        patientName: input.patientName,
        reviewed: false,
      });
      return {
        ok: true,
        steps: [
          "Upload received",
          "OCR / extraction",
          "Marker matching",
          "Confidence scoring",
          "Practitioner review queue",
        ],
        message: "Upload queued for the review queue (demo — no file uploaded).",
      };
    },
  },
};

export { DEFAULT_PATIENT_ID };
export * from "./types";
