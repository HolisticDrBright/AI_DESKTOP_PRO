/**
 * Data adapter façade.
 *
 * The UI consumes data exclusively through this `api` object, shaped the way
 * the future tRPC client will be (async, per-domain namespaces). Replacing
 * the mocks with real queries means swapping the function bodies here — the
 * components should not need to change.
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
import { USE_LIVE_API } from "./config";
import {
  executeAction,
  type ActionContext,
  type ActionKind,
} from "./actions";
import {
  clearAuditEntries,
  listAuditEntries,
  recordAuditEntry,
  setReviewOutcome,
} from "./session-store";
import type { DraftKind } from "./types";

/** Context passed to lab marker mutations so the demo audit entry is meaningful. */
interface LabMarkerCtx {
  patientId: string;
  patientName: string;
  markerName: string;
}

export const api = {
  patients: {
    // `patients` is the one swapped namespace (Item 6). When USE_LIVE_API is
    // on, list/get read real patient_profiles rows through the authenticated
    // tRPC backend (RLS enforced). The live module is loaded lazily so the
    // default mock build never pulls in server-only code. `summary` synthesizes
    // data with no DB source, so it stays on the mock until parity is proven.
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
     * and settles any linked review; no backend persistence. Replace with a
     * tRPC mutation writing the append-only audit_events table.
     */
    execute: async (kind: ActionKind, context: ActionContext, timestamp: string) =>
      executeAction(kind, context, timestamp),
    /** Demo session audit log (sessionStorage). Not backend persistence. */
    listAuditEvents: () => listAuditEntries(),
    /** Clear the demo session audit log (demo reset). */
    clearSessionAuditEvents: () => clearAuditEntries(),
  },
  tasks: {
    /** MOCK practitioner review queue. Replace with a tRPC query. */
    getQueue: async () => getTaskQueue(),
  },
  labs: {
    /** MOCK labs workspace. Replace with a tRPC query. */
    getWorkspace: async (patientId: string, patientName?: string) =>
      getLabWorkspace(patientId, patientName),
    /** Settle a marker as reviewed (demo session state + audit). */
    reviewMarker: async (markerId: string, ctx: LabMarkerCtx) => {
      setReviewOutcome(`lab:${ctx.patientId}:${markerId}`, "reviewed");
      recordAuditEntry({
        kind: "mark_reviewed",
        subjectType: "lab marker",
        subjectLabel: ctx.markerName,
        patientName: ctx.patientName,
        reviewed: true,
        outcome: "reviewed",
      });
      return { ok: true, message: `Marked reviewed: ${ctx.markerName}. (demo — not persisted)` };
    },
    /** Flag a marker for further review (demo session state + audit). */
    flagMarker: async (markerId: string, ctx: LabMarkerCtx) => {
      setReviewOutcome(`lab:${ctx.patientId}:${markerId}`, "flagged");
      recordAuditEntry({
        kind: "flag",
        subjectType: "lab marker",
        subjectLabel: ctx.markerName,
        patientName: ctx.patientName,
        reviewed: false,
        outcome: "flagged",
      });
      return { ok: true, message: `Flagged for review: ${ctx.markerName}. (demo — not persisted)` };
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
