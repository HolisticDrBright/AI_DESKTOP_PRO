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
  LiveInboxFilters,
  LiveSyncOutboundResourceType,
  LiveSyncScope,
  LiveMessageChannel,
  LiveThreadCategory,
  LiveThreadPriority,
  LiveProgramDraftPayload,
  LiveProgramEnrollmentStatus,
  LiveProgramOfferPaymentMode,
  LiveProtocolDraftPayload,
  LiveBillingCatalogFilters,
  LiveBillingProductKind,
  LiveBillingWorkspaceFilters,
  LiveInventoryAdjustmentKind,
  LiveInventoryReturnCondition,
  LiveInvoiceLineInput,
  LiveManualPaymentMethod,
  LiveMembershipAction,
  LivePackageKind,
  LivePlanType,
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
    /**
     * LIVE: the real product catalog picker. Verification status is derived by
     * the database from what the catalog holds — the client cannot claim a
     * product is structured-verified.
     */
    searchCatalog: async (query: string | null, limit = 20) =>
      liveClient.searchProtocolCatalog(query, limit),
    /**
     * LIVE: the deterministic interaction check. Runs only where structured
     * data exists on both sides; otherwise every item comes back
     * `not_completed` with the reason, which the UI renders as "Interaction
     * review not completed". A completed check never claims a product is
     * interaction-free.
     */
    checkInteractions: async (versionId: string) =>
      liveClient.checkProtocolInteractions(versionId),
    /** LIVE: the practitioner's explicit, audited interaction sign-off. */
    reviewItemInteractions: async (itemId: string, note?: string | null) =>
      liveClient.reviewProtocolItemInteractions(itemId, note ?? null),
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
  programs: {
    /**
     * LIVE: the organization's program library. Enrollment counts are counts
     * of PERSISTED enrollment rows — engagement, revenue, completion rates,
     * and "at-risk" metrics are NOT computed anywhere because no honest data
     * source for them exists.
     */
    library: async (input: { query?: string | null; status?: string | null; limit?: number } = {}) =>
      liveClient.programLibrary(input),
    /** LIVE: one program's studio — versions, history, events, offers, roster. */
    studio: async (programId: string) => liveClient.programStudio(programId),
    /** LIVE: organization-owned templates (archived hidden unless asked). */
    listTemplates: async (includeArchived = false) =>
      liveClient.listProgramTemplates(includeArchived),
    /** LIVE: blank draft, or a DETACHED copy of an APPROVED template version. */
    create: async (input: { name: string; fromTemplateId?: string | null }) =>
      liveClient.createProgram(input),
    /**
     * LIVE: wholesale autosave. `expectedUpdatedAt` is the concurrency token —
     * a stale token returns a conflict rather than overwriting another editor.
     */
    saveDraft: async (input: {
      versionId: string;
      payload: LiveProgramDraftPayload;
      expectedUpdatedAt: string | null;
    }) => liveClient.saveProgramDraft(input),
    /** LIVE: draft -> in_review. */
    submit: async (versionId: string) =>
      liveClient.programVersionAction({ action: "submit", versionId }),
    /** LIVE: in_review -> draft, with the reviewer's note. */
    returnToDraft: async (versionId: string, note?: string | null) =>
      liveClient.programVersionAction({ action: "return", versionId, note: note ?? null }),
    /** LIVE: freeze an in-review version as approved. Does NOT publish it. */
    approve: async (versionId: string, note?: string | null) =>
      liveClient.programVersionAction({ action: "approve", versionId, note: note ?? null }),
    /**
     * LIVE: publish an approved version — a separate, confirmed action.
     * Supersedes the previous published version WITHOUT touching pinned
     * enrollments, and creates no enrollment, charge, invoice, message,
     * protocol, order, task, or note.
     */
    publish: async (versionId: string) =>
      liveClient.programVersionAction({ action: "publish", versionId }),
    /** LIVE: copy a frozen version into a NEW draft (never edit it in place). */
    revise: async (versionId: string) =>
      liveClient.programVersionAction({ action: "revise", versionId }),
    /** LIVE: archive/restore. Published history and enrollments are preserved. */
    archive: async (programId: string, archived = true) =>
      liveClient.programVersionAction({
        action: archived ? "archive" : "restore",
        programId,
      }),
    templates: {
      create: async (input: {
        name: string;
        description?: string | null;
        fromVersionId?: string | null;
      }) => liveClient.programTemplateAction({ action: "create", ...input }),
      approve: async (versionId: string) =>
        liveClient.programTemplateAction({ action: "approve", versionId }),
      /** Archiving never cascades into programs created from the template. */
      archive: async (templateId: string, archived = true) =>
        liveClient.programTemplateAction({
          action: archived ? "archive" : "restore",
          templateId,
        }),
    },
    /**
     * LIVE: offer terms storage ONLY. This application never processes a
     * payment; a Stripe-mode offer is stored intent that the UI renders as
     * "Not configured" and the database refuses to enroll against.
     */
    upsertOffer: async (input: {
      programId: string;
      offerId?: string | null;
      name?: string | null;
      priceCents?: number;
      currency?: string;
      accessDurationDays?: number | null;
      paymentMode?: LiveProgramOfferPaymentMode;
      enrollmentOpen?: boolean;
      status?: "active" | "retired";
    }) => liveClient.upsertProgramOffer(input),
    /**
     * LIVE: enroll, pinned to the exact published version. Eligibility,
     * tenant agreement, comp reason + authorization, and the Stripe refusal
     * are all server-enforced — the client can claim none of them.
     */
    enroll: async (input: {
      programId: string;
      patientId: string;
      offerId?: string | null;
      activate?: boolean;
      compReason?: string | null;
    }) => liveClient.programEnroll(input),
    /** LIVE: pause / resume / complete / cancel / expire, machine-enforced. */
    setEnrollmentStatus: async (input: {
      enrollmentId: string;
      status: LiveProgramEnrollmentStatus;
      reason?: string | null;
    }) => liveClient.programEnrollmentStatus(input),
    /** LIVE: append-only progress against the enrollment's PINNED version. */
    recordProgress: async (input: {
      enrollmentId: string;
      kind: "lesson_completed" | "check_in" | "quiz_response" | "adherence";
      lessonId?: string | null;
      blockId?: string | null;
      payload?: Record<string, unknown>;
      needsReview?: boolean;
    }) => liveClient.programRecordProgress(input),
    /** LIVE: the practitioner's explicit, audited progress review. */
    reviewProgress: async (progressId: string) => liveClient.programReviewProgress(progressId),
    /** LIVE: patient-chart enrollments with pinned versions + real progress. */
    forPatient: async (patientId: string) => liveClient.patientPrograms(patientId),
    /**
     * UNAVAILABLE: the Program Builder AI. The contract is provider-neutral
     * (a future approved provider slots in behind this same call), but with
     * no approved provider configured it fails closed — the UI shows the
     * honest not-configured state and NEVER renders fixture AI output.
     */
    builderAI: notWired<[{ instruction: string; versionId: string }], never>(
      "AI program builder",
    ),
  },
  inbox: {
    /**
     * LIVE: the organization inbox. Threads, counts, and unread numbers are
     * PERSISTED rows the caller can see — nothing is projected or invented.
     */
    list: async (filters: LiveInboxFilters = {}) => liveClient.inboxList(filters),
    /** LIVE: one thread — messages, attachments, prefs, consents, AI reviews, history. */
    thread: async (conversationId: string) => liveClient.inboxThread(conversationId),
    /** LIVE: open a patient thread (urgent invariant runs on the subject). */
    createThread: async (input: {
      patientId: string;
      subject: string;
      category?: LiveThreadCategory;
      priority?: LiveThreadPriority;
    }) => liveClient.inboxCreateThread(input),
    /**
     * LIVE: versioned reply drafts. The sender is ALWAYS the authenticated
     * caller (no sender parameter exists anywhere in the stack), and a stale
     * `expectedVersion` returns a conflict rather than overwriting.
     */
    saveDraft: async (input: {
      conversationId: string;
      body: string;
      messageId?: string | null;
      expectedVersion?: number | null;
    }) => liveClient.inboxSaveDraft(input),
    cancelDraft: async (messageId: string) => liveClient.inboxCancelDraft(messageId),
    /**
     * LIVE, FAIL-CLOSED: with no registered messaging provider the database
     * refuses ({ok:false, refusal:'provider_not_configured'}), keeps the
     * draft, and records the refusal. Nothing is ever marked sent or
     * delivered without provider acknowledgment.
     */
    send: async (input: { messageId: string; channel?: LiveMessageChannel }) =>
      liveClient.inboxSend(input),
    /** LIVE: read receipts on inbound messages (idempotent). */
    markRead: async (conversationId: string) => liveClient.inboxMarkRead(conversationId),
    /** LIVE: assignment/queue/priority/category/status machine/follow-up. */
    workflow: async (input: {
      conversationId: string;
      action: "assign" | "queue" | "priority" | "category" | "status" | "follow_up";
      expectedVersion: number;
      value?: string | null;
      at?: string | null;
      note?: string | null;
    }) => liveClient.inboxWorkflow(input),
    /** LIVE: idempotent conversion into a real review-queue task. */
    createTask: async (input: {
      messageId: string;
      title?: string | null;
      priority?: "low" | "medium" | "high";
    }) => liveClient.inboxCreateTask(input),
    /** LIVE: quoted content into an UNSIGNED draft note; never signs. */
    appendToNote: async (input: { messageId: string; encounterId: string; section?: string }) =>
      liveClient.inboxAppendToNote(input),
    /** LIVE: patient communication preferences + consent link. */
    setPreferences: async (input: {
      patientId: string;
      preferredChannel?: "in_app" | "email" | "sms" | "none";
      emailOk?: boolean;
      smsOk?: boolean;
      pushOk?: boolean;
      doNotContact?: boolean;
      consentId?: string | null;
      note?: string | null;
    }) => liveClient.inboxSetPreferences(input),
    /** LIVE: attachment METADATA only — no bytes, no URLs, honest access state. */
    registerAttachment: async (input: {
      conversationId: string;
      fileName: string;
      contentType: string;
      byteSize?: number | null;
      messageId?: string | null;
    }) => liveClient.inboxRegisterAttachment(input),
    /**
     * LIVE: the human gate on AI triage output — the ONLY path from a
     * suggestion to an action, and it applies through the same guarded
     * workflow RPCs a human uses directly.
     */
    reviewAiSuggestion: async (reviewId: string, decision: "accept" | "dismiss") =>
      liveClient.inboxReviewAiSuggestion(reviewId, decision),
    /** LIVE: the patient chart's Messages tab reads the same persisted threads. */
    forPatient: async (patientId: string) => liveClient.inboxPatientMessages(patientId),
    /** LIVE: Today's inbox summary — counts of persisted rows only. */
    todaySummary: async () => liveClient.inboxTodaySummary(),
    /** LIVE: real documentable encounters, so note conversion targets one. */
    patientEncounters: async (patientId: string) => liveClient.inboxPatientEncounters(patientId),
    /**
     * UNAVAILABLE: the AI inbox copilot. The contract is provider-neutral
     * (triage suggestions arrive through the service-role worker boundary and
     * surface in `thread().aiReviews` for human review), but with no approved
     * provider configured, requesting a NEW analysis fails closed — the UI
     * shows "AI inbox copilot not configured" and never renders fixture AI
     * output. The deterministic urgent-language invariant is independent of
     * this and always runs server-side.
     */
    copilotAI: notWired<[{ conversationId: string }], never>("The AI inbox copilot"),
  },
  sync: {
    /**
     * LIVE: the patient-app delivery & synchronization gateway (phase 5).
     * Connections, consent scopes, envelopes, and evidence are persisted rows
     * behind the Desktop-owned RPC boundary. FAIL-CLOSED: without a registered
     * AI Longevity Pro provider, queueing refuses durably and NOTHING is ever
     * marked delivered or acknowledged — those states only enter through the
     * service_role worker boundary with provider evidence, which this client
     * cannot reach.
     */
    forPatient: async (patientId: string) => liveClient.syncOverview(patientId),
    orgOperations: async () => liveClient.syncOrgOperations(),
    /** The one-time invitation token appears ONLY in this response. */
    createInvitation: async (patientId: string) => liveClient.syncCreateInvitation(patientId),
    connectionAction: async (input: {
      connectionId: string;
      action: "pause" | "resume" | "revoke";
      expectedVersion: number;
      reason?: string | null;
    }) => liveClient.syncConnectionAction(input),
    setConsentScope: async (input: {
      connectionId: string;
      scope: LiveSyncScope;
      grant: boolean;
      artifactTitle?: string | null;
      artifactVersion?: string | null;
      jurisdiction?: string | null;
      method?: string;
      authority?: string;
    }) => liveClient.syncSetConsentScope(input),
    queueExport: async (input: {
      connectionId: string;
      resourceType: LiveSyncOutboundResourceType;
      resourceId: string;
    }) => liveClient.syncQueueExport(input),
    withdrawResource: async (input: {
      connectionId: string;
      resourceType: LiveSyncOutboundResourceType;
      resourceId: string;
      reason: string;
    }) => liveClient.syncWithdrawResource(input),
    retryEvent: async (eventId: string, reason: string) =>
      liveClient.syncRetryEvent(eventId, reason),
    cancelEvent: async (eventId: string, reason: string) =>
      liveClient.syncCancelEvent(eventId, reason),
    resolveConflict: async (input: {
      conflictId: string;
      resolution:
        | "resolved_keep_desktop"
        | "resolved_keep_external"
        | "resolved_manual"
        | "dismissed";
      note: string;
      expectedVersion: number;
    }) => liveClient.syncResolveConflict(input),
    reviewInbound: async (input: {
      eventId: string;
      action: "accept" | "reject";
      note?: string | null;
    }) => liveClient.syncReviewInbound(input),
    recordCorrection: async (input: {
      inboundEventId: string;
      overlay: Record<string, unknown>;
      reason: string;
    }) => liveClient.syncRecordCorrection(input),
    /**
     * UNAVAILABLE: the AI summary over inbound adherence/symptom/wearable/
     * check-in data. The human review workflow above runs without it; with no
     * approved provider it fails closed — "AI sync summary not configured" —
     * and no fixture summary ever renders.
     */
    summaryAI: notWired<[{ connectionId: string }], never>("The AI sync summary"),
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
  billing: {
    /**
     * LIVE: the practice billing workspace — summary, invoices, payments, A/R
     * aging, product sales, inventory valuation, and processor
     * reconciliation. Every figure is summed from PERSISTED rows; nothing is
     * projected, estimated, or invented.
     */
    workspace: async (filters: LiveBillingWorkspaceFilters = {}) =>
      liveClient.billingWorkspace(filters),
    /** LIVE: one invoice with its line snapshots, payments, refunds, history. */
    invoice: async (invoiceId: string) => liveClient.billingInvoice(invoiceId),
    /** LIVE: a patient's invoice ledger and credit balance. */
    forPatient: async (patientId: string) => liveClient.billingPatient(patientId),
    /**
     * LIVE: open a checkout draft. With an appointment, the booked service
     * joins the draft when its type matches an active catalog service by
     * name — a deterministic rule, never a protocol-driven cart addition.
     */
    createDraft: async (input: {
      patientId: string;
      appointmentId?: string | null;
      locationId?: string | null;
    }) => liveClient.billingCreateDraft(input),
    /**
     * LIVE: replace a draft's lines. Tax is NOT an input — the database
     * computes it from the organization's configured rates and snapshots it,
     * so a client can never assert what tax is owed. A discount without a
     * reason is refused.
     */
    saveDraft: async (input: {
      invoiceId: string;
      expectedVersion: number;
      locationId?: string | null;
      lines: LiveInvoiceLineInput[];
    }) => liveClient.billingSaveDraft(input),
    /**
     * LIVE: finalize — assigns the sequential number and RESERVES tracked
     * stock. A concurrent checkout that would oversell is refused as a
     * conflict; stock never goes negative.
     */
    finalize: async (input: { invoiceId: string; expectedVersion: number }) =>
      liveClient.billingFinalize(input),
    /** LIVE: void an UNPAID invoice with a reason, releasing reservations. */
    voidInvoice: async (input: {
      invoiceId: string;
      expectedVersion: number;
      reason: string;
    }) => liveClient.billingVoid(input),
    /**
     * LIVE: record a payment the practice already took by hand. Full
     * settlement commits the inventory sale exactly once. An idempotency-key
     * replay is refused as a conflict rather than charging twice.
     */
    recordPayment: async (input: {
      invoiceId: string;
      expectedVersion: number;
      amountMinor: number;
      method: LiveManualPaymentMethod;
      reference?: string | null;
      idempotencyKey?: string | null;
    }) => liveClient.billingRecordPayment(input),
    /** LIVE: grant patient credit (reason required). */
    grantCredit: async (input: { patientId: string; amountMinor: number; reason: string }) =>
      liveClient.billingGrantCredit(input),
    /** LIVE: apply existing credit to an open invoice. */
    applyCredit: async (input: {
      invoiceId: string;
      expectedVersion: number;
      amountMinor: number;
    }) => liveClient.billingApplyCredit(input),
    /**
     * LIVE: refund a manual payment with a reason. This NEVER restocks
     * inventory — returning goods is a separate, explicit decision made
     * through `inventory.returnStock` with a condition.
     */
    refund: async (input: {
      paymentId: string;
      amountMinor: number;
      reason: string;
      method?: string | null;
    }) => liveClient.billingRefund(input),
    /**
     * LIVE (TEST-MODE ONLY): create a PENDING card payment row. No card data
     * is collected, no processor is called from the browser, and the result
     * cannot say a charge succeeded. Only the server-only processor webhook
     * settles it — the UI must present this as started, never as paid.
     */
    startCardPayment: async (input: {
      invoiceId: string;
      expectedVersion: number;
      idempotencyKey: string;
    }) => liveClient.billingStartCardPayment(input),
  },
  plans: {
    /**
     * LIVE: the org's package and membership offerings with every version.
     * Commercial terms live on the VERSION, so a published version's terms are
     * frozen and an accepted plan can never be rewritten under the patient.
     */
    library: async (includeArchived = false) => liveClient.plansLibrary(includeArchived),
    /** LIVE: a patient's entitlements (with full ledger) and memberships. */
    forPatient: async (patientId: string) => liveClient.plansPatient(patientId),
    /** LIVE: create, rename, or archive a plan; archiving preserves history. */
    upsert: async (input: {
      planType: LivePlanType;
      id?: string | null;
      expectedVersion?: number | null;
      name?: string | null;
      description?: string | null;
      kind?: LivePackageKind | null;
      archive?: boolean;
    }) => liveClient.plansUpsert(input),
    /** LIVE: draft the next version's commercial terms. */
    createVersion: async (
      input: Record<string, unknown> & { planType: LivePlanType; planId: string; priceMinor: number },
    ) => liveClient.plansCreateVersion(input),
    /** LIVE: publish a draft version, freezing its terms permanently. */
    publishVersion: async (input: { planType: LivePlanType; versionId: string }) =>
      liveClient.plansPublishVersion(input),
    /**
     * LIVE: the org's explicit no-show / late-cancel credit policy. The rule
     * is configuration; there is no implicit default buried in the UI.
     */
    setPolicy: async (input: {
      noShowPolicy: string;
      lateCancelPolicy: string;
      lateCancelWindowHours: number;
      consumeOn: string;
    }) => liveClient.plansSetPolicy(input),
    /**
     * LIVE: sell a package. Drafts the purchase INVOICE only — entitlements
     * follow when that invoice is paid, so an unpaid purchase confers nothing.
     */
    purchase: async (input: {
      patientId: string;
      packageVersionId: string;
      acceptanceMethod?: string;
    }) => liveClient.plansPurchase(input),
    /** LIVE: grant what a PAID invoice bought. Idempotent by construction. */
    grantForInvoice: async (invoiceId: string) => liveClient.plansGrantForInvoice(invoiceId),
    /**
     * LIVE: complimentary assignment. Needs the separate comp.assign
     * permission and a reason, and records a zero-amount invoice so the gift
     * is visible. It creates NO clinical order, note, or eligibility.
     */
    assignComplimentary: async (input: {
      patientId: string;
      planType: LivePlanType;
      versionId: string;
      reason: string;
      expiresAt?: string | null;
    }) => liveClient.plansAssignComplimentary(input),
    /**
     * LIVE: hold a credit for an appointment. A concurrent second reservation
     * for the same appointment is refused by a unique index, not app logic.
     */
    reserveCredit: async (input: {
      entitlementId: string;
      appointmentId: string;
      quantity?: number;
    }) => liveClient.plansReserveCredit(input),
    /** LIVE: settle a reserved credit per the ORGANIZATION'S policy. */
    settleCredit: async (input: {
      appointmentId: string;
      outcome: string;
      reason?: string | null;
    }) => liveClient.plansSettleCredit(input),
    /** LIVE: restore spent credit — refund authority plus a reason. */
    restoreCredit: async (input: { entitlementId: string; quantity: number; reason: string }) =>
      liveClient.plansRestoreCredit(input),
    /** LIVE: sweep entitlements past their expiry. */
    expireCredits: async () => liveClient.plansExpireCredits(),
    /**
     * LIVE: revoke UNSPENT credit after a refund. A visit already received is
     * never clawed back, and a refund never silently recreates a benefit.
     */
    revokeForRefund: async (input: { invoiceId: string; reason: string }) =>
      liveClient.plansRevokeForRefund(input),
    /** LIVE: pause / resume / cancel / reactivate a patient membership. */
    membershipLifecycle: async (input: {
      patientMembershipId: string;
      action: LiveMembershipAction;
      expectedVersion: number;
      reason?: string | null;
    }) => liveClient.plansMembershipLifecycle(input),
    /** LIVE: reconciliation exceptions and the processor event ledger. */
    reconciliation: async (status: string | null = "open") =>
      liveClient.plansReconciliation(status),
    /** LIVE: resolve one exception with a required reason. */
    resolveException: async (input: {
      exceptionId: string;
      resolution: "resolved" | "dismissed";
      reason: string;
      expectedVersion: number;
    }) => liveClient.plansResolveException(input),
    /**
     * LIVE: the Stripe boundary's real state. `liveTransactionExecuted` is
     * false until a Stripe API transaction has ACTUALLY run — configuration
     * alone is never presented as proof the integration works.
     */
    stripeStatus: async () => liveClient.plansStripeStatus(),
    /**
     * UNAVAILABLE: no AI may price, refund, comp, cancel, alter an
     * entitlement, or resolve reconciliation. Every such RPC requires
     * auth.uid() and a human-held permission; there is no autonomous path.
     */
    autoResolveAI: notWired("Autonomous financial decisions (deliberately never built)"),
  },
  inventory: {
    /** LIVE: catalog products with per-location stock, suppliers, tax rates. */
    listProducts: async (filters: LiveBillingCatalogFilters = {}) =>
      liveClient.billingCatalog(filters),
    /** LIVE: create a catalog product (financial role enforced by the DB). */
    addProduct: async (input: {
      name: string;
      kind: LiveBillingProductKind;
      amountMinor: number;
      currency?: string | null;
      sku?: string | null;
      barcode?: string | null;
      supplierId?: string | null;
      costMinor?: number | null;
      taxRateId?: string | null;
      description?: string | null;
      trackInventory?: boolean | null;
      reorderThreshold?: number | null;
    }) => liveClient.billingUpsertProduct(input),
    /** LIVE: update a product under its expected version. */
    updateProduct: async (input: {
      id: string;
      expectedVersion: number;
      name?: string | null;
      kind?: LiveBillingProductKind | null;
      amountMinor?: number | null;
      currency?: string | null;
      sku?: string | null;
      barcode?: string | null;
      supplierId?: string | null;
      costMinor?: number | null;
      taxRateId?: string | null;
      description?: string | null;
      trackInventory?: boolean | null;
      reorderThreshold?: number | null;
    }) => liveClient.billingUpsertProduct(input),
    /** LIVE: archive a product; past invoice line snapshots are preserved. */
    archiveProduct: async (input: { id: string; expectedVersion: number }) =>
      liveClient.billingArchiveProduct(input),
    /** LIVE: create or update a location, supplier, or tax rate. */
    upsertReference: async (input: {
      entity: "location" | "supplier" | "taxRate";
      id?: string | null;
      name?: string | null;
      contactEmail?: string | null;
      phone?: string | null;
      notes?: string | null;
      rateBps?: number | null;
      active?: boolean;
      archive?: boolean;
    }) => liveClient.billingUpsertReference(input),
    /** LIVE: receive stock into a location; lands in the append-only ledger. */
    receiveStock: async (input: {
      locationId: string;
      productId: string;
      quantity: number;
      unitCostMinor?: number | null;
      supplierId?: string | null;
      reference?: string | null;
    }) => liveClient.billingReceiveStock(input),
    /**
     * LIVE: adjust stock with a REQUIRED reason. Damaged/expired can only
     * remove. An adjustment below zero is refused as a conflict.
     */
    adjustStock: async (input: {
      locationId: string;
      productId: string;
      delta: number;
      kind: LiveInventoryAdjustmentKind;
      reason: string;
    }) => liveClient.billingAdjustStock(input),
    /**
     * LIVE: the ONLY restock path after a sale. The condition is required
     * because only a resalable return re-enters sellable stock.
     */
    returnStock: async (input: {
      locationId: string;
      productId: string;
      quantity: number;
      condition: LiveInventoryReturnCondition;
      reason: string;
      invoiceId?: string | null;
    }) => liveClient.billingReturnStock(input),
    /** LIVE: the append-only movement ledger for one product. */
    history: async (input: { productId: string; locationId?: string | null; limit?: number }) =>
      liveClient.billingInventoryHistory(input),
    /**
     * UNAVAILABLE: there is no "set the number to X" write. Stock moves only
     * through receipts, reasoned adjustments, sales, and returns, so the
     * ledger always explains the current number.
     */
    setStock: notWired("Absolute stock overwrite (use receiveStock or adjustStock)"),
    /**
     * UNAVAILABLE: sales are not recorded directly. A sale is the settlement
     * of a finalized invoice, which commits the inventory movement exactly
     * once — see `billing.recordPayment`.
     */
    recordSale: notWired("Direct sale recording (use the checkout + payment flow)"),
    /** LIVE: product sales come from the billing workspace projection. */
    listSales: async (filters: LiveBillingWorkspaceFilters = {}) =>
      liveClient.billingWorkspace(filters),
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
