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
  LiveConversation,
  LiveInbox,
  LiveInboxFilters,
  LiveInboxMutationResult,
  LiveBillingCatalog,
  LiveBillingCatalogFilters,
  LiveBillingMutationResult,
  LiveBillingProductKind,
  LiveBillingWorkspace,
  LiveBillingWorkspaceFilters,
  LiveCardPaymentIntent,
  LiveInventoryAdjustmentKind,
  LiveInventoryMovement,
  LiveInventoryReturnCondition,
  LiveInvoice,
  LiveInvoiceLineInput,
  LiveManualPaymentMethod,
  LivePatientBilling,
  LiveMembershipAction,
  LivePackageKind,
  LivePatientEntitlements,
  LivePlanLibrary,
  LivePlanMutationResult,
  LivePlanType,
  LiveReconciliationWorkspace,
  LiveStripeStatus,
  LiveNutritionAdherenceSummary,
  LiveNutritionCopilotDraft,
  LiveNutritionMutationResult,
  LiveNutritionProviderStatus,
  LiveNutritionTemplateLibrary,
  LiveNutritionVersionContent,
  LivePatientNutrition,
  LiveInboxTodaySummary,
  LiveMessageChannel,
  LivePatientMessages,
  LiveThreadCategory,
  LiveThreadPriority,
  LiveProgramDraftPayload,
  LiveProgramEnrollmentStatus,
  LiveProgramLibrary,
  LiveProgramMutationResult,
  LiveProgramOfferPaymentMode,
  LiveProgramStudio,
  LiveProgramTemplate,
  LivePatientPrograms,
  ReviewDecision,
  LiveOrgSyncOperations,
  LivePatientSync,
  LiveSyncMutationResult,
  LiveSyncOutboundResourceType,
  LiveSyncScope,
  LiveKnowledgeImportPreview,
  LiveKnowledgeImportPreviewResult,
  LiveKnowledgeImportCommitResult,
  LiveCommercialDisclosure,
  LiveProtocolCopilotDraft,
  LiveProtocolCopilotStatus,
  LiveProductCatalog,
  LiveProductLabelDetail,
  LiveProtocolTemplateDetail,
  LiveTemplateComparison,
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

  /* ---------------------------------------------- programs (phase 3) */
  programLibrary: (input: { query?: string | null; status?: string | null; limit?: number }) =>
    liveFetch<LiveProgramLibrary>("programs/library", { method: "POST", body: input }),

  programStudio: (programId: string) =>
    liveFetch<LiveProgramStudio>("programs/studio", { method: "POST", body: { programId } }),

  listProgramTemplates: (includeArchived = false) =>
    liveFetch<LiveProgramTemplate[]>("programs/templates", {
      method: "POST",
      body: { includeArchived },
    }),

  createProgram: (input: { name: string; fromTemplateId?: string | null }) =>
    liveFetch<LiveProgramMutationResult>("programs/create", { method: "POST", body: input }),

  saveProgramDraft: (input: {
    versionId: string;
    payload: LiveProgramDraftPayload;
    expectedUpdatedAt: string | null;
  }) => liveFetch<LiveProgramMutationResult>("programs/save", { method: "POST", body: input }),

  programVersionAction: (input: {
    action: "submit" | "return" | "approve" | "publish" | "revise" | "archive" | "restore";
    versionId?: string;
    programId?: string;
    note?: string | null;
  }) => liveFetch<LiveProgramMutationResult>("programs/version-action", {
    method: "POST",
    body: input,
  }),

  programTemplateAction: (input: {
    action: "create" | "approve" | "archive" | "restore";
    name?: string;
    description?: string | null;
    fromVersionId?: string | null;
    versionId?: string;
    templateId?: string;
  }) => liveFetch<LiveProgramMutationResult>("programs/template-action", {
    method: "POST",
    body: input,
  }),

  upsertProgramOffer: (input: {
    programId: string;
    offerId?: string | null;
    name?: string | null;
    priceCents?: number;
    currency?: string;
    accessDurationDays?: number | null;
    paymentMode?: LiveProgramOfferPaymentMode;
    enrollmentOpen?: boolean;
    status?: "active" | "retired";
  }) => liveFetch<LiveProgramMutationResult>("programs/offer", { method: "POST", body: input }),

  programEnroll: (input: {
    programId: string;
    patientId: string;
    offerId?: string | null;
    activate?: boolean;
    compReason?: string | null;
  }) => liveFetch<LiveProgramMutationResult>("programs/enrollment", {
    method: "POST",
    body: { action: "enroll", ...input },
  }),

  programEnrollmentStatus: (input: {
    enrollmentId: string;
    status: LiveProgramEnrollmentStatus;
    reason?: string | null;
  }) => liveFetch<LiveProgramMutationResult>("programs/enrollment", {
    method: "POST",
    body: { action: "status", ...input },
  }),

  programRecordProgress: (input: {
    enrollmentId: string;
    kind: "lesson_completed" | "check_in" | "quiz_response" | "adherence";
    lessonId?: string | null;
    blockId?: string | null;
    payload?: Record<string, unknown>;
    needsReview?: boolean;
  }) => liveFetch<LiveProgramMutationResult>("programs/progress", {
    method: "POST",
    body: { action: "record", ...input },
  }),

  programReviewProgress: (progressId: string) =>
    liveFetch<LiveProgramMutationResult>("programs/progress", {
      method: "POST",
      body: { action: "review", progressId },
    }),

  patientPrograms: (patientId: string) =>
    liveFetch<LivePatientPrograms>("programs/patient", { method: "POST", body: { patientId } }),

  /* ---------------------------------------------- inbox (phase 4) */
  inboxList: (filters: LiveInboxFilters) =>
    liveFetch<LiveInbox>("inbox/list", { method: "POST", body: filters }),

  inboxThread: (conversationId: string) =>
    liveFetch<LiveConversation>("inbox/thread", { method: "POST", body: { conversationId } }),

  inboxCreateThread: (input: {
    patientId: string;
    subject: string;
    category?: LiveThreadCategory;
    priority?: LiveThreadPriority;
  }) => liveFetch<LiveInboxMutationResult>("inbox/create", { method: "POST", body: input }),

  inboxSaveDraft: (input: {
    conversationId: string;
    body: string;
    messageId?: string | null;
    expectedVersion?: number | null;
  }) => liveFetch<LiveInboxMutationResult>("inbox/draft", { method: "POST", body: input }),

  inboxCancelDraft: (messageId: string) =>
    liveFetch<LiveInboxMutationResult>("inbox/draft", {
      method: "POST",
      body: { cancel: true, messageId },
    }),

  inboxSend: (input: { messageId: string; channel?: LiveMessageChannel }) =>
    liveFetch<LiveInboxMutationResult>("inbox/send", { method: "POST", body: input }),

  inboxMarkRead: (conversationId: string) =>
    liveFetch<LiveInboxMutationResult>("inbox/read", { method: "POST", body: { conversationId } }),

  inboxWorkflow: (input: {
    conversationId: string;
    action: "assign" | "queue" | "priority" | "category" | "status" | "follow_up";
    expectedVersion: number;
    value?: string | null;
    at?: string | null;
    note?: string | null;
  }) => liveFetch<LiveInboxMutationResult>("inbox/workflow", { method: "POST", body: input }),

  inboxCreateTask: (input: {
    messageId: string;
    title?: string | null;
    priority?: "low" | "medium" | "high";
  }) => liveFetch<LiveInboxMutationResult>("inbox/task", { method: "POST", body: input }),

  inboxAppendToNote: (input: { messageId: string; encounterId: string; section?: string }) =>
    liveFetch<LiveInboxMutationResult>("inbox/note", { method: "POST", body: input }),

  inboxSetPreferences: (input: {
    patientId: string;
    preferredChannel?: "in_app" | "email" | "sms" | "none";
    emailOk?: boolean;
    smsOk?: boolean;
    pushOk?: boolean;
    doNotContact?: boolean;
    consentId?: string | null;
    note?: string | null;
  }) => liveFetch<LiveInboxMutationResult>("inbox/preferences", { method: "POST", body: input }),

  inboxRegisterAttachment: (input: {
    conversationId: string;
    fileName: string;
    contentType: string;
    byteSize?: number | null;
    messageId?: string | null;
  }) => liveFetch<LiveInboxMutationResult>("inbox/attachment", { method: "POST", body: input }),

  inboxReviewAiSuggestion: (reviewId: string, decision: "accept" | "dismiss") =>
    liveFetch<LiveInboxMutationResult>("inbox/ai-review", {
      method: "POST",
      body: { reviewId, decision },
    }),

  inboxPatientMessages: (patientId: string) =>
    liveFetch<LivePatientMessages>("inbox/patient", { method: "POST", body: { patientId } }),

  inboxTodaySummary: () =>
    liveFetch<LiveInboxTodaySummary>("inbox/today", { method: "POST", body: {} }),

  inboxPatientEncounters: (patientId: string) =>
    liveFetch<{
      encounterId: string;
      visitType: string | null;
      status: string;
      startedAt: string | null;
    }[]>("inbox/encounters", { method: "POST", body: { patientId } }),

  syncOverview: (patientId: string) =>
    liveFetch<LivePatientSync>("sync/overview", { method: "POST", body: { patientId } }),

  syncOrgOperations: () =>
    liveFetch<LiveOrgSyncOperations>("sync/org", { method: "POST", body: {} }),

  syncCreateInvitation: (patientId: string) =>
    liveFetch<LiveSyncMutationResult>("sync/invite", { method: "POST", body: { patientId } }),

  syncConnectionAction: (input: {
    connectionId: string;
    action: "pause" | "resume" | "revoke";
    expectedVersion: number;
    reason?: string | null;
  }) => liveFetch<LiveSyncMutationResult>("sync/connection", { method: "POST", body: input }),

  syncSetConsentScope: (input: {
    connectionId: string;
    scope: LiveSyncScope;
    grant: boolean;
    artifactTitle?: string | null;
    artifactVersion?: string | null;
    jurisdiction?: string | null;
    method?: string;
    authority?: string;
  }) => liveFetch<LiveSyncMutationResult>("sync/consent", { method: "POST", body: input }),

  syncQueueExport: (input: {
    connectionId: string;
    resourceType: LiveSyncOutboundResourceType;
    resourceId: string;
  }) => liveFetch<LiveSyncMutationResult>("sync/queue", { method: "POST", body: input }),

  syncWithdrawResource: (input: {
    connectionId: string;
    resourceType: LiveSyncOutboundResourceType;
    resourceId: string;
    reason: string;
  }) =>
    liveFetch<LiveSyncMutationResult>("sync/queue", {
      method: "POST",
      body: { ...input, withdraw: true },
    }),

  syncRetryEvent: (eventId: string, reason: string) =>
    liveFetch<LiveSyncMutationResult>("sync/retry", { method: "POST", body: { eventId, reason } }),

  syncCancelEvent: (eventId: string, reason: string) =>
    liveFetch<LiveSyncMutationResult>("sync/retry", {
      method: "POST",
      body: { eventId, reason, action: "cancel" },
    }),

  syncResolveConflict: (input: {
    conflictId: string;
    resolution:
      | "resolved_keep_desktop"
      | "resolved_keep_external"
      | "resolved_manual"
      | "dismissed";
    note: string;
    expectedVersion: number;
  }) => liveFetch<LiveSyncMutationResult>("sync/conflict", { method: "POST", body: input }),

  syncReviewInbound: (input: { eventId: string; action: "accept" | "reject"; note?: string | null }) =>
    liveFetch<LiveSyncMutationResult>("sync/review", { method: "POST", body: input }),

  syncRecordCorrection: (input: {
    inboundEventId: string;
    overlay: Record<string, unknown>;
    reason: string;
  }) => liveFetch<LiveSyncMutationResult>("sync/review", { method: "POST", body: input }),

  /* ------------------------------------------- billing (phase 8A) */
  billingWorkspace: (filters: LiveBillingWorkspaceFilters) =>
    liveFetch<LiveBillingWorkspace>("billing/workspace", { method: "POST", body: filters }),

  billingInvoice: (invoiceId: string) =>
    liveFetch<LiveInvoice>("billing/invoice", { method: "POST", body: { invoiceId } }),

  billingPatient: (patientId: string) =>
    liveFetch<LivePatientBilling>("billing/patient", { method: "POST", body: { patientId } }),

  billingCatalog: (filters: LiveBillingCatalogFilters) =>
    liveFetch<LiveBillingCatalog>("billing/catalog", { method: "POST", body: filters }),

  billingInventoryHistory: (input: {
    productId: string;
    locationId?: string | null;
    limit?: number;
  }) => liveFetch<LiveInventoryMovement[]>("billing/inventory-history", {
    method: "POST",
    body: input,
  }),

  billingUpsertProduct: (input: {
    id?: string | null;
    expectedVersion?: number | null;
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
  }) => liveFetch<LiveBillingMutationResult>("billing/product", { method: "POST", body: input }),

  billingArchiveProduct: (input: { id: string; expectedVersion: number }) =>
    liveFetch<LiveBillingMutationResult>("billing/product", {
      method: "POST",
      body: { action: "archive", ...input },
    }),

  billingUpsertReference: (input: {
    entity: "location" | "supplier" | "taxRate";
    id?: string | null;
    name?: string | null;
    contactEmail?: string | null;
    phone?: string | null;
    notes?: string | null;
    rateBps?: number | null;
    active?: boolean;
    archive?: boolean;
  }) => liveFetch<LiveBillingMutationResult>("billing/reference", { method: "POST", body: input }),

  billingReceiveStock: (input: {
    locationId: string;
    productId: string;
    quantity: number;
    unitCostMinor?: number | null;
    supplierId?: string | null;
    reference?: string | null;
  }) => liveFetch<LiveBillingMutationResult>("billing/inventory", {
    method: "POST",
    body: { action: "receive", ...input },
  }),

  billingAdjustStock: (input: {
    locationId: string;
    productId: string;
    delta: number;
    kind: LiveInventoryAdjustmentKind;
    reason: string;
  }) => liveFetch<LiveBillingMutationResult>("billing/inventory", {
    method: "POST",
    body: { action: "adjust", ...input },
  }),

  billingReturnStock: (input: {
    locationId: string;
    productId: string;
    quantity: number;
    condition: LiveInventoryReturnCondition;
    reason: string;
    invoiceId?: string | null;
  }) => liveFetch<LiveBillingMutationResult>("billing/inventory", {
    method: "POST",
    body: { action: "return", ...input },
  }),

  billingCreateDraft: (input: {
    patientId: string;
    appointmentId?: string | null;
    locationId?: string | null;
  }) => liveFetch<LiveInvoice>("billing/draft", { method: "POST", body: input }),

  billingSaveDraft: (input: {
    invoiceId: string;
    expectedVersion: number;
    locationId?: string | null;
    lines: LiveInvoiceLineInput[];
  }) => liveFetch<LiveInvoice>("billing/save", { method: "POST", body: input }),

  billingFinalize: (input: { invoiceId: string; expectedVersion: number }) =>
    liveFetch<LiveInvoice>("billing/finalize", { method: "POST", body: input }),

  billingVoid: (input: { invoiceId: string; expectedVersion: number; reason: string }) =>
    liveFetch<LiveInvoice>("billing/void", { method: "POST", body: input }),

  billingRecordPayment: (input: {
    invoiceId: string;
    expectedVersion: number;
    amountMinor: number;
    method: LiveManualPaymentMethod;
    reference?: string | null;
    idempotencyKey?: string | null;
  }) => liveFetch<LiveInvoice>("billing/payment", { method: "POST", body: input }),

  billingGrantCredit: (input: { patientId: string; amountMinor: number; reason: string }) =>
    liveFetch<LiveBillingMutationResult>("billing/credit", {
      method: "POST",
      body: { action: "grant", ...input },
    }),

  billingApplyCredit: (input: {
    invoiceId: string;
    expectedVersion: number;
    amountMinor: number;
  }) => liveFetch<LiveInvoice>("billing/credit", {
    method: "POST",
    body: { action: "apply", ...input },
  }),

  billingRefund: (input: {
    paymentId: string;
    amountMinor: number;
    reason: string;
    method?: string | null;
  }) => liveFetch<LiveInvoice>("billing/refund", { method: "POST", body: input }),

  billingStartCardPayment: (input: {
    invoiceId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }) => liveFetch<LiveCardPaymentIntent>("billing/card", { method: "POST", body: input }),

  /* ------------------------------------------- plans etc (phase 8B) */
  plansLibrary: (includeArchived = false) =>
    liveFetch<LivePlanLibrary>("plans/library", {
      method: "POST",
      body: { includeArchived },
    }),

  plansPatient: (patientId: string) =>
    liveFetch<LivePatientEntitlements>("plans/patient", {
      method: "POST",
      body: { patientId },
    }),

  plansUpsert: (input: {
    planType: LivePlanType;
    id?: string | null;
    expectedVersion?: number | null;
    name?: string | null;
    description?: string | null;
    kind?: LivePackageKind | null;
    archive?: boolean;
  }) => liveFetch<LivePlanMutationResult>("plans/plan", { method: "POST", body: input }),

  plansCreateVersion: (input: Record<string, unknown> & { planType: LivePlanType; planId: string; priceMinor: number }) =>
    liveFetch<LivePlanMutationResult>("plans/version", { method: "POST", body: input }),

  plansPublishVersion: (input: { planType: LivePlanType; versionId: string }) =>
    liveFetch<LivePlanMutationResult>("plans/publish", { method: "POST", body: input }),

  plansSetPolicy: (input: {
    noShowPolicy: string;
    lateCancelPolicy: string;
    lateCancelWindowHours: number;
    consumeOn: string;
  }) => liveFetch<LivePlanMutationResult>("plans/policy", { method: "POST", body: input }),

  plansPurchase: (input: {
    patientId: string;
    packageVersionId: string;
    acceptanceMethod?: string;
  }) => liveFetch<LivePlanMutationResult>("plans/purchase", { method: "POST", body: input }),

  plansGrantForInvoice: (invoiceId: string) =>
    liveFetch<LivePlanMutationResult>("plans/grant", { method: "POST", body: { invoiceId } }),

  plansAssignComplimentary: (input: {
    patientId: string;
    planType: LivePlanType;
    versionId: string;
    reason: string;
    expiresAt?: string | null;
  }) => liveFetch<LivePlanMutationResult>("plans/complimentary", { method: "POST", body: input }),

  plansReserveCredit: (input: {
    entitlementId: string;
    appointmentId: string;
    quantity?: number;
  }) => liveFetch<LivePlanMutationResult>("plans/reserve", { method: "POST", body: input }),

  plansSettleCredit: (input: {
    appointmentId: string;
    outcome: string;
    reason?: string | null;
  }) => liveFetch<LivePlanMutationResult>("plans/settle", { method: "POST", body: input }),

  plansRestoreCredit: (input: { entitlementId: string; quantity: number; reason: string }) =>
    liveFetch<LivePlanMutationResult>("plans/restore", { method: "POST", body: input }),

  plansExpireCredits: () =>
    liveFetch<LivePlanMutationResult>("plans/expire", { method: "POST", body: {} }),

  plansRevokeForRefund: (input: { invoiceId: string; reason: string }) =>
    liveFetch<LivePlanMutationResult>("plans/revoke", { method: "POST", body: input }),

  plansMembershipLifecycle: (input: {
    patientMembershipId: string;
    action: LiveMembershipAction;
    expectedVersion: number;
    reason?: string | null;
  }) => liveFetch<LivePlanMutationResult>("plans/membership", { method: "POST", body: input }),

  plansReconciliation: (status: string | null = "open") =>
    liveFetch<LiveReconciliationWorkspace>("plans/reconciliation", {
      method: "POST",
      body: { status },
    }),

  plansResolveException: (input: {
    exceptionId: string;
    resolution: "resolved" | "dismissed";
    reason: string;
    expectedVersion: number;
  }) => liveFetch<LivePlanMutationResult>("plans/reconciliation", {
    method: "POST",
    body: { action: "resolve", ...input },
  }),

  plansStripeStatus: () =>
    liveFetch<LiveStripeStatus>("plans/stripe-status", { method: "POST", body: {} }),

  /* ------------------------------------------------ nutrition (phase 9A) */

  nutritionTemplates: (includeArchived = false) =>
    liveFetch<LiveNutritionTemplateLibrary>("nutrition/templates", {
      method: "POST",
      body: { includeArchived },
    }),

  nutritionVersionContent: (input: {
    templateVersionId?: string | null;
    planVersionId?: string | null;
  }) =>
    liveFetch<LiveNutritionVersionContent>("nutrition/content", {
      method: "POST",
      body: input,
    }),

  nutritionForPatient: (patientId: string) =>
    liveFetch<LivePatientNutrition>("nutrition/patient", {
      method: "POST",
      body: { patientId },
    }),

  nutritionAdherence: (patientId: string, days = 30) =>
    liveFetch<LiveNutritionAdherenceSummary>("nutrition/adherence", {
      method: "POST",
      body: { patientId, days },
    }),

  nutritionUpsertTemplate: (input: Record<string, unknown> & { name: string }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/template", { method: "POST", body: input }),

  nutritionCreateTemplateVersion: (input: Record<string, unknown> & { templateId: string }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/template-version", {
      method: "POST",
      body: input,
    }),

  nutritionSaveTemplateContent: (input: { templateVersionId: string; content: unknown }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/template-content", {
      method: "POST",
      body: input,
    }),

  nutritionPublishTemplateVersion: (templateVersionId: string) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/template-publish", {
      method: "POST",
      body: { templateVersionId },
    }),

  nutritionArchiveTemplate: (input: { templateId: string; reason: string }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/template-archive", {
      method: "POST",
      body: input,
    }),

  nutritionInstallStarters: () =>
    liveFetch<{ installed: Array<{ slug: string; outcome: string }> }>(
      "nutrition/starter-install",
      { method: "POST", body: {} },
    ),

  nutritionCreatePlan: (input: {
    patientId: string;
    title: string;
    sourceTemplateVersionId?: string | null;
  }) => liveFetch<LiveNutritionMutationResult>("nutrition/plan", { method: "POST", body: input }),

  nutritionSavePlanVersion: (
    input: Record<string, unknown> & { planVersionId: string; expectedVersion: number },
  ) => liveFetch<LiveNutritionMutationResult>("nutrition/plan-save", { method: "POST", body: input }),

  nutritionSetConstraints: (input: { planVersionId: string; constraints: unknown[] }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/constraints", {
      method: "POST",
      body: input,
    }),

  nutritionEvaluateSafety: (planVersionId: string) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/safety-evaluate", {
      method: "POST",
      body: { planVersionId },
    }),

  nutritionRaiseSafetyFlag: (input: {
    planVersionId: string;
    kind: string;
    severity: "review" | "blocking";
    detail: string;
  }) => liveFetch<LiveNutritionMutationResult>("nutrition/safety-raise", {
    method: "POST",
    body: input,
  }),

  nutritionResolveSafetyFlag: (input: {
    flagId: string;
    action: "acknowledge" | "override" | "resolve";
    reason?: string | null;
  }) => liveFetch<LiveNutritionMutationResult>("nutrition/safety-resolve", {
    method: "POST",
    body: input,
  }),

  nutritionSubmit: (planVersionId: string) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/submit", {
      method: "POST",
      body: { planVersionId },
    }),

  nutritionApprove: (input: { planVersionId: string; note?: string | null }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/approve", { method: "POST", body: input }),

  nutritionActivate: (planVersionId: string) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/activate", {
      method: "POST",
      body: { planVersionId },
    }),

  nutritionLifecycle: (input: {
    planId: string;
    action: "pause" | "resume" | "complete" | "discontinue";
    reason?: string | null;
  }) => liveFetch<LiveNutritionMutationResult>("nutrition/lifecycle", {
    method: "POST",
    body: input,
  }),

  nutritionRevise: (input: { planVersionId: string; reason: string }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/revise", { method: "POST", body: input }),

  nutritionAddAmendment: (input: { planVersionId: string; body: string; reason: string }) =>
    liveFetch<LiveNutritionMutationResult>("nutrition/amendment", { method: "POST", body: input }),

  nutritionRecordCheckin: (
    input: Record<string, unknown> & { patientId: string; observedOn: string; source: string },
  ) => liveFetch<LiveNutritionMutationResult>("nutrition/checkin", { method: "POST", body: input }),

  nutritionReviewCheckin: (input: {
    checkinId: string;
    state: "reviewed" | "needs_followup";
  }) => liveFetch<LiveNutritionMutationResult>("nutrition/checkin-review", {
    method: "POST",
    body: input,
  }),

  nutritionCopilotDraft: (input: { planVersionId: string; patientId: string }) =>
    liveFetch<LiveNutritionCopilotDraft>("nutrition/copilot-draft", {
      method: "POST",
      body: input,
    }),

  nutritionProviderStatus: () =>
    liveFetch<LiveNutritionProviderStatus>("nutrition/provider-status", {
      method: "POST",
      body: {},
    }),

  /* ------------------------- Phase 9B: governed import pipeline ------- */

  /** Stage a preview. Writes nothing governed — the server proves this. */
  knowledgeImportPreview: (input: {
    sourceKind: string | null;
    sourceName: string;
    schemaVersion: string;
    items: unknown[];
    attestsNoPhi: boolean;
    sourceFilename?: string | null;
    sourceByteSize?: number | null;
    sourceRevision?: string | null;
  }) =>
    liveFetch<LiveKnowledgeImportPreviewResult>("knowledge/import-preview", {
      method: "POST",
      body: input,
    }),

  knowledgeImportDetail: (batchId: string) =>
    liveFetch<LiveKnowledgeImportPreview>("knowledge/import-detail", {
      method: "POST",
      body: { batchId },
    }),

  knowledgeImportResolve: (input: {
    itemId: string;
    resolution: "keep_existing" | "take_incoming" | "skip";
    note: string;
  }) =>
    liveFetch<{ ok: true; itemId: string; resolution: string }>(
      "knowledge/import-resolve",
      { method: "POST", body: input },
    ),

  /**
   * Commit a reviewed batch.
   *
   * `expectedCounts` carries the numbers the reviewer actually looked at, so a
   * preview that changed underneath them fails rather than applying a
   * different set of rows than the one on screen.
   */
  knowledgeImportCommit: (input: {
    batchId: string;
    expectedCounts?: { added: number; changed: number } | null;
    note?: string | null;
  }) =>
    liveFetch<LiveKnowledgeImportCommitResult>("knowledge/import-commit", {
      method: "POST",
      body: input,
    }),

  knowledgeImportCancel: (input: { batchId: string; reason: string }) =>
    liveFetch<{ ok: true; batchId: string; status: string }>(
      "knowledge/import-cancel",
      { method: "POST", body: input },
    ),

  /** A SEPARATE call. Commercial data never rides inside a clinical payload. */
  commercialLinks: (
    input: { labelVersionId: string } | { protocolVersionId: string },
  ) =>
    liveFetch<LiveCommercialDisclosure>("knowledge/commercial-links", {
      method: "POST",
      body: input,
    }),

  protocolCopilotStatus: () =>
    liveFetch<LiveProtocolCopilotStatus>("knowledge/copilot-status", {
      method: "POST",
      body: {},
    }),

  protocolCopilotDraft: (input: { patientId: string; versionId: string }) =>
    liveFetch<LiveProtocolCopilotDraft>("knowledge/copilot-draft", {
      method: "POST",
      body: input,
    }),

  /* ------------------- Phase 9B: the product catalog registry ---------- */

  /**
   * The catalog list. The response keeps the server's `clinical` /
   * `commercial` split rather than flattening it, so a renderer has to reach
   * across a named boundary to touch commercial data instead of finding it
   * beside a clinical field.
   */
  productCatalog: (
    input: { query?: string | null; status?: string | null; limit?: number } = {},
  ) =>
    liveFetch<LiveProductCatalog>("knowledge/catalog", {
      method: "POST",
      body: input,
    }),

  productLabelDetail: (input: { labelVersionId: string }) =>
    liveFetch<LiveProductLabelDetail>("knowledge/catalog-detail", {
      method: "POST",
      body: input,
    }),

  /** Whether the caller may verify at all is decided by the database. */
  verifyProductLabel: (input: {
    labelVersionId: string;
    verificationNote: string;
  }) =>
    liveFetch<{ ok: true }>("knowledge/catalog-verify", {
      method: "POST",
      body: input,
    }),

  /* ------------------- Phase 9B: template lifecycle -------------------- */

  protocolTemplateDetail: (input: { templateId: string }) =>
    liveFetch<LiveProtocolTemplateDetail>("protocols/template-detail", {
      method: "POST",
      body: input,
    }),

  protocolTemplateCompare: (input: {
    leftVersionId: string;
    rightVersionId: string;
  }) =>
    liveFetch<LiveTemplateComparison>("protocols/template-compare", {
      method: "POST",
      body: input,
    }),

  protocolTemplateSafetyReview: (input: {
    versionId: string;
    outcome: "passed" | "concerns" | "blocked";
    note: string;
  }) =>
    liveFetch<{
      ok: true;
      reviewId: string;
      outcome: string;
      unsourcedDoseCount: number;
      message: string;
    }>("protocols/template-safety", { method: "POST", body: input }),

  protocolTemplateSupersede: (input: {
    templateId: string;
    successorTemplateId: string;
    reason: string;
  }) =>
    liveFetch<{
      ok: true;
      templateId: string;
      supersededBy: string;
      message: string;
    }>("protocols/template-supersede", { method: "POST", body: input }),
};
