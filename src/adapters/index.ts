/**
 * CLINICAL ADAPTER REGISTRY.
 *
 * The UI consumes clinical data exclusively through this `api` object — no
 * component selects mock versus live behavior on its own, imports Supabase or
 * tRPC directly, or reaches into a fixture module. This file is the one place
 * that decides where each domain's data comes from, and in this repository
 * there are exactly two answers:
 *
 *   LIVE          The Desktop-owned Supabase boundary, called as the signed-in
 *                  practitioner (JWT + RLS + org membership), through the
 *                  server routes in `src/app/api/live/*`.
 *   UNAVAILABLE   An `AdapterError("unavailable")` naming the surface, which
 *                  the UI renders as an honest not-configured state. Never a
 *                  fixture, never a fabricated row, never an empty screen that
 *                  reads as "this patient has no data".
 *
 * There is no mock branch. Synthetic fixtures (`*.mock.ts`) exist for unit and
 * browser tests only; the import-graph check (`scripts/check-mock-imports.mjs`)
 * fails the build if any production route can reach one.
 *
 * Domain status is tracked in `docs/clinical-runtime-migration.md`. A domain
 * moves from UNAVAILABLE to LIVE only with a real authenticated read/write —
 * that is the whole migration, one domain at a time.
 */
import { AdapterError } from "./errors";
import { getCommandGroups } from "./commands";
import { mapLiveQueueItem } from "./tasks.map";
import { liveClient } from "./live-client";
import { runClinicalMutation, type MutationOutcome } from "./mutations";
import {
  getReviewOutcome,
  removeReviewOutcome,
  setReviewOutcome,
} from "./review-state";
import { executeLiveAction, type ActionContext, type ActionKind } from "./actions";
import type { OptimalRange } from "./labs.types";
import type {
  LiveAppointmentStatus,
  LiveAuditEvent,
  LiveBookInput,
  LiveProtocolDraftPayload,
} from "./live-types";

/** Context passed to lab marker mutations so the audit entry is meaningful. */
interface LabMarkerCtx {
  patientId: string;
  patientName: string;
  markerName: string;
}

/**
 * A domain with no live source yet. The thrown error's message is the honest
 * state the UI shows; the detail names the barrier for logs (no PHI).
 */
function notWired<A extends unknown[], R>(what: string): (...args: A) => Promise<R> {
  return async () => {
    throw new AdapterError(
      "unavailable",
      `${what} is not configured yet. This surface has no live data source; ` +
        `nothing is shown rather than synthetic data.`,
      `clinical registry: ${what} not wired`,
    );
  };
}

export const api = {
  patients: {
    /**
     * LIVE: patient_profiles through the Desktop-owned server boundary (RLS
     * enforced). sessionToken/orgId are passed by SERVER callers
     * (src/server/session.ts); client callers omit them and the API route
     * reads the cookie session.
     */
    list: async (sessionToken?: string | null, orgId?: string | null) =>
      (await import("./patients.live")).patientsLive.list(sessionToken, orgId),
    get: async (id: string, sessionToken?: string | null, orgId?: string | null) =>
      (await import("./patients.live")).patientsLive.get(id, sessionToken, orgId),
    /**
     * LIVE: the bounded patient-overview aggregate (demographics, care team,
     * allergies, medications, conditions, recent activity, latest labs, open
     * tasks, missing-information indicators). Values without a governed
     * source are absent — the UI says "Not enough verified data", it never
     * invents a number.
     */
    overview: async (patientId: string) => liveClient.patientOverview(patientId),
    /**
     * The synthesized health-score/systems summary has NO governed source
     * (algorithm, inputs, version, and review status are not defined), so it
     * is not computed at all. See docs/clinical-runtime-migration.md.
     */
    summary: notWired("The clinical summary score"),
  },
  schedule: {
    /**
     * LIVE: the Desktop-owned calendar RPC returns a role-scoped schedule and
     * minimal booking directory. Authorized RPC writes enforce overlap,
     * transition, and tenant rules and append audit.
     */
    getWeek: async (fromIso: string, toIso: string) => liveClient.scheduleCalendar(fromIso, toIso),
    book: async (input: LiveBookInput) => liveClient.bookAppointment(input),
    updateStatus: async (appointmentId: string, status: string) =>
      liveClient.updateAppointmentStatus(appointmentId, status),
    reschedule: async (appointmentId: string, startsAtIso: string, endsAtIso: string) =>
      liveClient.rescheduleAppointment(appointmentId, startsAtIso, endsAtIso),
    /**
     * LIVE: the front-desk state machine. The database enforces which
     * transitions are legal, checks the optimistic `expectedVersion`, and
     * replays an `idempotencyKey` instead of transitioning twice. Rescheduling
     * stays a separate operation above — moving a visit in time is not a
     * status change.
     */
    transition: async (input: {
      appointmentId: string;
      toStatus: LiveAppointmentStatus;
      expectedVersion?: number | null;
      idempotencyKey?: string | null;
      reason?: string | null;
    }) => liveClient.transitionAppointment(input),
    /**
     * LIVE: the authorized correction workflow — the ONLY way a settled
     * appointment leaves a terminal status. Org admins only, reason required.
     */
    correctStatus: async (input: {
      appointmentId: string;
      toStatus: LiveAppointmentStatus;
      reason: string;
      expectedVersion?: number | null;
    }) => liveClient.correctAppointmentStatus(input),
  },
  protocols: {
    /**
     * LIVE: the patient's protocol — current draft, latest approved, active
     * version, and append-only version history. `exists: false` is the honest
     * empty state; nothing is synthesized to fill the screen.
     */
    getForPatient: async (patientId: string) => liveClient.patientProtocol(patientId),
    /** LIVE: organization-owned templates (archived hidden unless asked). */
    listTemplates: async (includeArchived = false) =>
      liveClient.listProtocolTemplates(includeArchived),
    /** LIVE: blank draft, or a detached copy of an APPROVED template version. */
    createDraft: async (input: {
      patientId: string;
      title: string;
      fromTemplateId?: string | null;
    }) => liveClient.createProtocolDraft(input),
    /**
     * LIVE: autosave. `expectedUpdatedAt` is the concurrency token — a stale
     * token returns a conflict rather than overwriting another editor.
     */
    saveDraft: async (input: {
      versionId: string;
      payload: LiveProtocolDraftPayload;
      expectedUpdatedAt: string | null;
    }) => liveClient.saveProtocolDraft(input),
    /** LIVE: freeze a draft as approved. Does NOT activate it. */
    approve: async (versionId: string, reviewNote?: string | null) =>
      liveClient.protocolAction({ action: "approve", versionId, reviewNote: reviewNote ?? null }),
    /** LIVE: put an approved version in effect — a separate, confirmed action. */
    activate: async (versionId: string) =>
      liveClient.protocolAction({ action: "activate", versionId }),
    /** LIVE: copy an approved/active version into a NEW draft (never edit it). */
    revise: async (versionId: string) =>
      liveClient.protocolAction({ action: "revise", versionId }),
    /** LIVE: pause / complete / discontinue the course. */
    setLifecycle: async (
      protocolId: string,
      status: "active" | "paused" | "completed" | "discontinued",
      reason?: string | null,
    ) => liveClient.protocolAction({
      action: "lifecycle", protocolId, status, reason: reason ?? null,
    }),
    templates: {
      create: async (input: {
        name: string;
        description?: string | null;
        fromVersionId?: string | null;
      }) => liveClient.protocolTemplateAction({ action: "create", ...input }),
      approve: async (versionId: string) =>
        liveClient.protocolTemplateAction({ action: "approve", versionId }),
      /** Archiving never touches protocols already created from the template. */
      archive: async (templateId: string, archived = true) =>
        liveClient.protocolTemplateAction({ action: "archive", templateId, archived }),
    },
  },
  reasoning: {
    /**
     * LIVE: reasoning snapshot + hypotheses + evidence + open questions for a
     * patient, read from the Desktop-owned boundary. Internal evidence
     * strength wording is preserved verbatim — never a medical probability.
     */
    getWorkspace: async (patientId: string) => liveClient.reasoningWorkspace(patientId),
    /**
     * LIVE: practitioner review of a hypothesis (accept / reject /
     * request-data). Persists the review and its audit event atomically via
     * RPC. Accepting NEVER auto-inserts into a note or care plan.
     */
    reviewHypothesis: async (input: {
      hypothesisId: string;
      action: "accepted" | "rejected" | "needs_data";
      note?: string;
    }) => liveClient.reviewHypothesis(input.hypothesisId, input.action, input.note),
  },
  assistant: {
    session: notWired("The clinical assistant"),
  },
  commands: {
    /** Navigation only — carries no patient data. */
    groups: async (patientId?: string) => getCommandGroups(patientId),
  },
  composer: {
    generate: notWired("Draft generation"),
  },
  imports: {
    plan: notWired("Import planning"),
  },
  actions: {
    /**
     * Execute a review action. Actions whose context carries a `liveRef`
     * route to the real backend mutation — currently `resolve` on a
     * review-queue item (RPC: status update + audit_events row, atomically,
     * idempotent on retries). Everything else has no live executor yet and
     * reports itself unavailable rather than pretending.
     */
    execute: async (kind: ActionKind, context: ActionContext, timestamp: string) => {
      if (kind === "resolve" && context.liveRef?.kind === "queue-item") {
        const key = context.reviewKey;
        const prev = key ? getReviewOutcome(key) : undefined;
        const itemId = context.liveRef.id;
        const outcome = await runClinicalMutation({
          optimistic: () => key && setReviewOutcome(key, "resolved"),
          rollback: () =>
            key && (prev ? setReviewOutcome(key, prev) : removeReviewOutcome(key)),
          live: () => liveClient.resolveQueueItem(itemId),
          liveMessage: `Resolved: ${context.subjectLabel}. (saved to record + audit)`,
        });
        return { ok: outcome.ok, message: outcome.message };
      }
      void timestamp;
      return executeLiveAction(kind, context);
    },
    /** LIVE: append-only audit log through the caller-authorized DB function. */
    listLiveAuditEvents: async (limit = 50): Promise<LiveAuditEvent[]> =>
      liveClient.listAuditEvents(limit),
  },
  tasks: {
    /**
     * LIVE: real review_queue_items for the active org (RLS-scoped — the
     * caller only sees patients they can access), mapped to the QueueItem
     * shape with the row's settled status carried through so resolved items
     * survive reload.
     */
    getQueue: async () => (await liveClient.listQueue()).map(mapLiveQueueItem),
  },
  calendar: {
    /**
     * The demo weekday template is gone; the real week comes from
     * `schedule.getWeek`. This alias exists so legacy callers fail loudly
     * instead of silently rendering nothing.
     */
    getSchedule: notWired("The demo calendar template (use schedule.getWeek)"),
  },
  labOrders: {
    listCatalogPanels: notWired("Lab ordering"),
    listRecommendedPanels: notWired("Lab ordering"),
    getDraftOrder: notWired("Lab ordering"),
    addPanelToDraft: notWired("Lab ordering"),
    removePanelFromDraft: notWired("Lab ordering"),
    prepareOrderDraft: notWired("Lab ordering"),
    markOrderReviewed: notWired("Lab ordering"),
    listOrderEvents: notWired("Lab ordering"),
  },
  inventory: {
    listProducts: notWired("The dispensary and inventory"),
    addProduct: notWired("The dispensary and inventory"),
    updateProduct: notWired("The dispensary and inventory"),
    receiveStock: notWired("The dispensary and inventory"),
    setStock: notWired("The dispensary and inventory"),
    recordSale: notWired("The dispensary and inventory"),
    listSales: notWired("The dispensary and inventory"),
  },
  supplements: {
    getWorkspace: notWired("The supplement workspace"),
  },
  healthTwin: {
    getMap: notWired("The longitudinal systems model"),
  },
  experiments: {
    listActive: notWired("N-of-1 experiments"),
    listCompleted: notWired("N-of-1 experiments"),
  },
  integrations: {
    getConnectors: notWired("External integrations"),
  },
  permissions: {
    getMatrix: notWired("The role/permission matrix"),
  },
  labs: {
    /**
     * LIVE: real biomarker_observations through the Desktop-owned Supabase
     * boundary (RLS-scoped, reference intervals preserved).
     */
    getWorkspace: async (patientId: string) => liveClient.labsWorkspace(patientId),
    /**
     * LIVE: `review_biomarker` RPC updates the review columns and appends an
     * audit_events row atomically, stamping reviewer id server-side and
     * preserving lab values/provenance. Optimistic state is in-memory only.
     */
    reviewMarker: async (markerId: string, ctx: LabMarkerCtx): Promise<MutationOutcome> => {
      const key = `lab:${ctx.patientId}:${markerId}`;
      const prev = getReviewOutcome(key);
      return runClinicalMutation({
        optimistic: () => setReviewOutcome(key, "reviewed"),
        rollback: () => (prev ? setReviewOutcome(key, prev) : removeReviewOutcome(key)),
        live: () => liveClient.reviewMarker(markerId, "accepted"),
        liveMessage: `Marked reviewed: ${ctx.markerName}. (saved to record)`,
      });
    },
    /** LIVE: review_biomarker(flagged) + audit. */
    flagMarker: async (markerId: string, ctx: LabMarkerCtx): Promise<MutationOutcome> => {
      const key = `lab:${ctx.patientId}:${markerId}`;
      const prev = getReviewOutcome(key);
      return runClinicalMutation({
        optimistic: () => setReviewOutcome(key, "flagged"),
        rollback: () => (prev ? setReviewOutcome(key, prev) : removeReviewOutcome(key)),
        live: () => liveClient.reviewMarker(markerId, "flagged"),
        liveMessage: `Flagged for review: ${ctx.markerName}. (saved to record)`,
      });
    },
    /** LIVE: `create_review_task` RPC (+ audit). */
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
        liveMessage: `Follow-up task created for ${input.markerName}. (saved to queue)`,
      });
    },
    /**
     * Practice optimal ranges have no live table yet; refusing is honest,
     * and the lab reference interval on each marker is never affected.
     */
    configureOptimalRange: notWired("Practice optimal ranges") as (
      markerId: string,
      range: OptimalRange,
      ctx: LabMarkerCtx,
    ) => Promise<{ ok: boolean; message: string }>,
    /**
     * LIVE ONLY: upload a lab PDF for real ingestion — storage + extraction +
     * observations + review-queue item + audit, all as the signed-in
     * practitioner (see labs.live.ts). A "failed" result is honest: the PDF
     * is stored for manual review and the failure is audited.
     */
    uploadDocument: async (patientId: string, file: File) =>
      liveClient.uploadLabDocument(patientId, file),
  },
};

export * from "./types";
