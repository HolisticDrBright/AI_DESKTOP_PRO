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
import { AdapterError } from "./errors";
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
import { mapLiveQueueItem } from "./tasks.map";
import { getCalendar } from "./calendar.mock";
import { SEED_PRODUCTS, type InventoryProduct } from "./inventory.mock";
import {
  getLabCatalog,
  getPanelById,
  getRecommendedPanels,
  type OrderEvent,
} from "./labOrders.mock";
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
  addCustomProduct,
  addSessionQueueItem,
  adjustInventory,
  clearAuditEntries,
  getInventoryAdjustments,
  getLabOrderDraft,
  getReviewOutcome,
  listAuditEntries,
  listCustomProducts,
  listSales,
  recordAuditEntry,
  recordSale,
  removeReviewOutcome,
  setInventoryLevel,
  setReviewOutcome,
  updateLabOrderDraft,
  type SaleLine,
} from "./session-store";

/** Build a demo order event. */
const orderEvent = (label: string): OrderEvent => ({
  id: `evt-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
  at: new Date().toISOString(),
  label,
});
import type { LiveAuditEvent, LiveBookInput } from "./live-types";
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
    // sessionToken: the cookie session's access token, passed by SERVER
    // callers (src/server/session.ts). Client/demo callers omit it.
    list: async (sessionToken?: string | null) => {
      if (USE_LIVE_API) return (await import("./patients.live")).patientsLive.list(sessionToken);
      return listPatients();
    },
    get: async (id: string, sessionToken?: string | null) => {
      if (USE_LIVE_API) return (await import("./patients.live")).patientsLive.get(id, sessionToken);
      return getPatient(id);
    },
    summary: async (id: string) => getPatientSummary(id),
  },
  practice: {
    dashboard: async () => getPracticeDashboard(),
    rightRail: async () => getRightRail(),
  },
  schedule: {
    /**
     * LIVE ONLY namespace — real appointments (RLS-scoped reads; 0017
     * SECURITY DEFINER RPC writes with double-booking rejection + audit).
     * The demo calendar keeps rendering the weekday-pattern mock directly
     * (calendar.mock.getCalendar); these methods throw in demo mode instead
     * of pretending to persist.
     */
    getWeek: async (fromIso: string, toIso: string) => {
      if (!USE_LIVE_API) throw new AdapterError("invalid", "Demo mode does not load live schedule data.");
      return liveClient.scheduleCalendar(fromIso, toIso);
    },
    book: async (input: LiveBookInput) => {
      if (!USE_LIVE_API) throw new AdapterError("invalid", "Demo mode does not book appointments.");
      return liveClient.bookAppointment(input);
    },
    updateStatus: async (appointmentId: string, status: string) => {
      if (!USE_LIVE_API) throw new AdapterError("invalid", "Demo mode does not change appointment status.");
      return liveClient.updateAppointmentStatus(appointmentId, status);
    },
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
     * and settles any linked review. LIVE: actions whose context carries a
     * `liveRef` route to the real backend mutation — currently `resolve` on a
     * review-queue item, which calls the `resolve_review_queue_item` RPC
     * (migration 0014): status update + audit_events row, atomically,
     * idempotent on retries. Demo mode never enters this branch.
     */
    execute: async (kind: ActionKind, context: ActionContext, timestamp: string) => {
      if (USE_LIVE_API && kind === "resolve" && context.liveRef?.kind === "queue-item") {
        const key = context.reviewKey;
        const prev = key ? getReviewOutcome(key) : undefined;
        const itemId = context.liveRef.id;
        const outcome = await runClinicalMutation({
          optimistic: () => key && setReviewOutcome(key, "resolved"),
          rollback: () =>
            key && (prev ? setReviewOutcome(key, prev) : removeReviewOutcome(key)),
          live: () => liveClient.resolveQueueItem(itemId),
          demo: () => {},
          liveMessage: `Resolved: ${context.subjectLabel}. (saved to record + audit)`,
          demoMessage: "",
        });
        return { ok: outcome.ok, message: outcome.message };
      }
      return executeAction(kind, context, timestamp);
    },
    /** Demo session audit log (sessionStorage). Not backend persistence. */
    listAuditEvents: () => listAuditEntries(),
    /** Live append-only audit log for the caller's org (empty in mock mode). */
    listLiveAuditEvents: async (limit = 50): Promise<LiveAuditEvent[]> =>
      USE_LIVE_API ? liveClient.listAuditEvents(limit) : [],
    /** Clear the demo session audit log (demo reset). */
    clearSessionAuditEvents: () => clearAuditEntries(),
  },
  tasks: {
    /**
     * Practitioner review queue. LIVE: real review_queue_items for the active
     * org (RLS-scoped — the caller only sees patients they can access), mapped
     * to the QueueItem shape with the row's settled status carried through so
     * resolved items survive reload. MOCK: demo queue, unchanged.
     */
    getQueue: async () => {
      if (USE_LIVE_API) return (await liveClient.listQueue()).map(mapLiveQueueItem);
      return getTaskQueue();
    },
  },
  calendar: {
    /** MOCK scheduling data (recurring weekly template). Replace with a tRPC query. */
    getSchedule: async () => getCalendar(),
  },
  labOrders: {
    /**
     * MOCK lab ordering. DEMO ONLY — no lab order is ever submitted, no
     * requisition is generated, no price is charged. Replace with a tRPC
     * mutation over a real lab-vendor integration.
     */
    listCatalogPanels: async (patientId: string) => {
      void patientId; // per-patient catalog filtering lands with the backend
      return getLabCatalog();
    },
    listRecommendedPanels: async (patientId: string) => {
      void patientId; // recommendations derive from this patient's record server-side
      return getRecommendedPanels();
    },
    getDraftOrder: async (patientId: string) => getLabOrderDraft(patientId),
    addPanelToDraft: async (patientId: string, panelId: string) => {
      const panel = getPanelById(panelId);
      updateLabOrderDraft(patientId, (d) =>
        d.panelIds.includes(panelId)
          ? d
          : {
              ...d,
              status: "draft",
              reviewed: false,
              panelIds: [...d.panelIds, panelId],
              events: [orderEvent(`Added panel: ${panel?.name ?? panelId}`), ...d.events],
            },
      );
      recordAuditEntry({
        kind: "order_panel_added",
        subjectType: "lab order",
        subjectLabel: panel?.name ?? panelId,
        reviewed: true,
      });
      return { ok: true, message: `Added ${panel?.name ?? "panel"} to the order draft. (demo — not submitted)` };
    },
    removePanelFromDraft: async (patientId: string, panelId: string) => {
      const panel = getPanelById(panelId);
      updateLabOrderDraft(patientId, (d) => ({
        ...d,
        panelIds: d.panelIds.filter((id) => id !== panelId),
        reviewed: false,
        events: [orderEvent(`Removed panel: ${panel?.name ?? panelId}`), ...d.events],
      }));
      recordAuditEntry({
        kind: "order_panel_removed",
        subjectType: "lab order",
        subjectLabel: panel?.name ?? panelId,
        reviewed: true,
      });
      return { ok: true, message: `Removed ${panel?.name ?? "panel"} from the order draft. (demo)` };
    },
    prepareOrderDraft: async (patientId: string) => {
      updateLabOrderDraft(patientId, (d) => ({
        ...d,
        status: "prepared",
        events: [orderEvent("Order draft prepared"), ...d.events],
      }));
      recordAuditEntry({
        kind: "order_prepared",
        subjectType: "lab order",
        subjectLabel: "Order draft",
        reviewed: true,
      });
      return { ok: true, message: "Order draft prepared. (demo — no lab order is submitted)" };
    },
    markOrderReviewed: async (patientId: string) => {
      updateLabOrderDraft(patientId, (d) => ({
        ...d,
        reviewed: true,
        events: [orderEvent("Order reviewed by practitioner"), ...d.events],
      }));
      recordAuditEntry({
        kind: "order_reviewed",
        subjectType: "lab order",
        subjectLabel: "Order draft",
        reviewed: true,
      });
      return { ok: true, message: "Order marked reviewed. (demo — not persisted)" };
    },
    listOrderEvents: async (patientId: string) => getLabOrderDraft(patientId).events,
  },
  inventory: {
    /**
     * MOCK dispensary. Products with EFFECTIVE stock = seed + session movement,
     * so selling counts stock down this session. Replace with a tRPC query over
     * products_services + an inventory table; sales become invoice/line-item rows.
     */
    listProducts: async (): Promise<InventoryProduct[]> => {
      const adj = getInventoryAdjustments();
      const all = [...listCustomProducts(), ...SEED_PRODUCTS];
      return all.map((p) => ({ ...p, stock: Math.max(0, p.stock + (adj[p.id] ?? 0)) }));
    },
    /** Add a new product to inventory this session + audit. */
    addProduct: async (product: InventoryProduct) => {
      addCustomProduct(product);
      recordAuditEntry({
        kind: "receive_stock",
        subjectType: "inventory",
        subjectLabel: `Added ${product.name} (${product.stock} on hand)`,
        reviewed: true,
      });
      return { ok: true, message: `Added ${product.name} to inventory. (demo — not persisted)` };
    },
    /** Receive (restock) units into inventory + audit. */
    receiveStock: async (productId: string, qty: number, name: string) => {
      const n = Math.max(1, Math.round(qty));
      adjustInventory(productId, n);
      recordAuditEntry({
        kind: "receive_stock",
        subjectType: "inventory",
        subjectLabel: `+${n} · ${name}`,
        reviewed: true,
      });
      return { ok: true, message: `Received ${n} into stock: ${name}. (demo — not persisted)` };
    },
    /** Correct an on-hand count to an absolute value + audit. */
    setStock: async (productId: string, seed: number, target: number, name: string) => {
      const t = Math.max(0, Math.round(target));
      setInventoryLevel(productId, seed, t);
      recordAuditEntry({
        kind: "receive_stock",
        subjectType: "inventory",
        subjectLabel: `Set ${name} → ${t}`,
        reviewed: true,
      });
      return { ok: true, message: `Stock set to ${t}: ${name}. (demo — not persisted)` };
    },
    /**
     * Complete a supplement sale for a patient: decrement each line's stock,
     * record the sale, and write an audit entry. No PHI in the audit label.
     */
    recordSale: async (input: {
      patientId: string;
      patientName: string;
      lines: SaleLine[];
      subtotalMinor: number;
      discountMinor: number;
      taxMinor: number;
      totalMinor: number;
    }) => {
      for (const l of input.lines) adjustInventory(l.productId, -Math.abs(l.qty));
      const sale = recordSale(input);
      const count = input.lines.reduce((n, l) => n + l.qty, 0);
      recordAuditEntry({
        kind: "record_sale",
        subjectType: "supplement sale",
        subjectLabel: `${count} item${count === 1 ? "" : "s"} · $${(input.totalMinor / 100).toFixed(2)}`,
        patientName: input.patientName,
        reviewed: true,
      });
      return { ok: true, sale, message: `Sale recorded for ${input.patientName}. (demo — not persisted)` };
    },
    /** Demo session sales log. */
    listSales: async () => listSales(),
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
    /**
     * LIVE ONLY: upload a lab PDF for real ingestion — storage + extraction +
     * observations + review-queue item + audit, all as the signed-in
     * practitioner (see labs.live.ts). A "failed" result is honest: the PDF
     * is stored for manual review and the failure is audited. Demo mode uses
     * queueUploadDemo instead (no file ever leaves the browser).
     */
    uploadDocument: async (patientId: string, file: File) => {
      if (!USE_LIVE_API) {
        throw new AdapterError("invalid", "Demo mode does not upload files.");
      }
      return liveClient.uploadLabDocument(patientId, file);
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
