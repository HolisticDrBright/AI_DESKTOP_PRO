/**
 * Review-to-action model.
 *
 * Defines the clinical actions that can hang off cards, alerts, queue items,
 * hypotheses, lab abnormalities, experiment conclusions and protocol approvals,
 * plus a MOCK executor. There is **no real persistence here** — `executeAction`
 * only records to an in-memory log and returns a human-readable outcome. It is
 * the isolated boundary that a tRPC mutation will replace (`api.actions.execute`).
 *
 * Clinical guardrails encoded in the descriptors:
 *  - destructive / patient-facing actions set `confirm` (the UI must confirm);
 *  - patient-facing clinical content actions set `patientFacing` so the UI can
 *    keep them gated behind practitioner review.
 */
import type { Tone } from "./types";
import {
  recordAuditEntry,
  setReviewOutcome,
  type ReviewOutcome,
} from "./session-store";

export type ActionKind =
  | "approve"
  | "modify"
  | "reject"
  | "request_data"
  | "create_task"
  | "schedule_appointment"
  | "message_patient"
  | "add_to_note"
  | "insert_into_report"
  | "order_lab"
  | "open_source"
  | "view_audit"
  | "accept_hypothesis"
  | "add_evidence"
  | "add_contradiction"
  | "convert_to_task"
  | "convert_to_experiment"
  // review-queue + labs
  | "resolve"
  | "assign"
  | "snooze"
  | "change_priority"
  | "mark_reviewed"
  | "flag"
  | "request_recheck"
  | "configure_range"
  | "open_patient"
  // dispensary / inventory
  | "receive_stock"
  | "record_sale"
  // lab ordering
  | "order_panel_added"
  | "order_panel_removed"
  | "order_prepared"
  | "order_reviewed";

export type ActionIcon =
  | "check"
  | "pencil"
  | "x"
  | "help"
  | "clipboard-plus"
  | "calendar-plus"
  | "message"
  | "note"
  | "file-plus"
  | "flask"
  | "external"
  | "history"
  | "plus"
  | "minus"
  | "git-branch"
  | "user"
  | "clock"
  | "flag"
  | "check-check"
  | "rotate"
  | "sliders";

export interface ActionDescriptor {
  kind: ActionKind;
  label: string;
  icon: ActionIcon;
  tone: Tone;
  /** Requires an explicit confirmation step before executing. */
  confirm?: boolean;
  /** Short confirmation prompt shown in the dialog. */
  confirmText?: string;
  /** Produces or sends patient-facing clinical content (keep review-gated). */
  patientFacing?: boolean;
  /** Irreversible / state-changing in a way the user should double-check. */
  destructive?: boolean;
}

export const ACTIONS: Record<ActionKind, ActionDescriptor> = {
  approve: {
    kind: "approve", label: "Approve", icon: "check", tone: "positive",
    confirm: true, confirmText: "Approve this item? It will be recorded as practitioner-reviewed.",
  },
  modify: { kind: "modify", label: "Modify", icon: "pencil", tone: "action" },
  reject: {
    kind: "reject", label: "Reject", icon: "x", tone: "critical",
    confirm: true, destructive: true, confirmText: "Reject this item? This is recorded and cannot be silently undone.",
  },
  request_data: { kind: "request_data", label: "Request data", icon: "help", tone: "warning" },
  create_task: { kind: "create_task", label: "Create task", icon: "clipboard-plus", tone: "action" },
  schedule_appointment: { kind: "schedule_appointment", label: "Schedule", icon: "calendar-plus", tone: "action" },
  message_patient: {
    kind: "message_patient", label: "Message patient", icon: "message", tone: "teal",
    confirm: true, patientFacing: true, confirmText: "Send a message to the patient? Patient-facing content requires your review.",
  },
  add_to_note: { kind: "add_to_note", label: "Add to note", icon: "note", tone: "action" },
  insert_into_report: { kind: "insert_into_report", label: "Insert into report", icon: "file-plus", tone: "action" },
  order_lab: {
    kind: "order_lab", label: "Order / reorder lab", icon: "flask", tone: "action",
    confirm: true, confirmText: "Place a lab order? This is an outward-facing clinical action.",
  },
  open_source: { kind: "open_source", label: "Open source", icon: "external", tone: "slate" },
  view_audit: { kind: "view_audit", label: "Audit history", icon: "history", tone: "slate" },
  accept_hypothesis: {
    kind: "accept_hypothesis", label: "Accept", icon: "check", tone: "positive",
    confirm: true, confirmText: "Accept this hypothesis into the reviewed clinical picture?",
  },
  add_evidence: { kind: "add_evidence", label: "Add evidence", icon: "plus", tone: "positive" },
  add_contradiction: { kind: "add_contradiction", label: "Add contradiction", icon: "minus", tone: "critical" },
  convert_to_task: { kind: "convert_to_task", label: "Convert to task", icon: "clipboard-plus", tone: "action" },
  convert_to_experiment: { kind: "convert_to_experiment", label: "Convert to experiment", icon: "git-branch", tone: "ai" },
  resolve: {
    kind: "resolve", label: "Resolve", icon: "check-check", tone: "positive",
    confirm: true, confirmText: "Resolve this item? It will be marked done and recorded in the session audit log.",
  },
  assign: { kind: "assign", label: "Assign", icon: "user", tone: "action" },
  snooze: { kind: "snooze", label: "Snooze", icon: "clock", tone: "slate" },
  change_priority: { kind: "change_priority", label: "Change priority", icon: "flag", tone: "warning" },
  mark_reviewed: { kind: "mark_reviewed", label: "Mark reviewed", icon: "check-check", tone: "positive" },
  flag: { kind: "flag", label: "Flag for review", icon: "flag", tone: "warning" },
  request_recheck: {
    kind: "request_recheck", label: "Request recheck", icon: "rotate", tone: "action",
    confirm: true, confirmText: "Request a recheck for this marker? This is an outward-facing clinical action.",
  },
  configure_range: { kind: "configure_range", label: "Configure optimal range", icon: "sliders", tone: "slate" },
  open_patient: { kind: "open_patient", label: "Open patient", icon: "user", tone: "action" },
  receive_stock: { kind: "receive_stock", label: "Receive stock", icon: "plus", tone: "positive" },
  record_sale: { kind: "record_sale", label: "Dispense / sale", icon: "check-check", tone: "teal" },
  order_panel_added: { kind: "order_panel_added", label: "Lab panel added", icon: "plus", tone: "action" },
  order_panel_removed: { kind: "order_panel_removed", label: "Lab panel removed", icon: "minus", tone: "slate" },
  order_prepared: { kind: "order_prepared", label: "Lab order draft prepared", icon: "flask", tone: "action" },
  order_reviewed: { kind: "order_reviewed", label: "Lab order reviewed", icon: "check-check", tone: "positive" },
};

/**
 * Actions that SETTLE a review, and the outcome they record. When an action's
 * context carries a `reviewKey`, executing it writes this outcome to the demo
 * review store so the UI reflects the settled state immediately.
 */
export const ACTION_REVIEW_OUTCOME: Partial<Record<ActionKind, ReviewOutcome>> = {
  approve: "approved",
  accept_hypothesis: "accepted",
  reject: "rejected",
  resolve: "resolved",
  mark_reviewed: "reviewed",
  flag: "flagged",
  snooze: "snoozed",
};

export interface ActionContext {
  /** What the action targets, e.g. "hypothesis", "lab result". */
  subjectType: string;
  /** Human label of the subject, e.g. "Inflammatory burden". */
  subjectLabel: string;
  patientName?: string;
  /** Supporting facts to seed a composer draft (evidence, values). */
  seeds?: string[];
  /** Stable key for the reviewable subject (e.g. "snapshot:p-78435"). When set,
   *  settling actions record their outcome to the demo review store. */
  reviewKey?: string;
}

/** Review actions that open the note/report composer instead of recording. */
export const COMPOSER_ACTIONS: Partial<Record<ActionKind, import("./types").DraftKind>> = {
  add_to_note: "soap-note",
  insert_into_report: "reasoning-summary",
  message_patient: "patient-message",
};

export interface ActionResult {
  ok: boolean;
  /** Human-readable outcome, announced to assistive tech and shown as a toast. */
  message: string;
}

/**
 * MOCK executor. Records the action to the demo session audit store, settles
 * any linked review, and returns an outcome message. Preserves
 * practitioner-review semantics: patient-facing actions are marked as requiring
 * review, never auto-finalized. Replace with `api.actions.execute` (tRPC).
 */
export async function executeAction(
  kind: ActionKind,
  ctx: ActionContext,
  timestamp: string,
): Promise<ActionResult> {
  const d = ACTIONS[kind];
  const outcome = ACTION_REVIEW_OUTCOME[kind];

  recordAuditEntry({
    at: timestamp,
    kind,
    subjectType: ctx.subjectType,
    subjectLabel: ctx.subjectLabel,
    patientName: ctx.patientName,
    reviewed: !d.patientFacing,
    outcome,
  });

  // Settle the visible review state when the action targets a reviewable subject.
  if (ctx.reviewKey && outcome) setReviewOutcome(ctx.reviewKey, outcome);

  const suffix = d.patientFacing ? " — queued for your review before it reaches the patient" : "";
  return {
    ok: true,
    message: `${d.label}: ${ctx.subjectType} “${ctx.subjectLabel}”${suffix}. (demo — not persisted)`,
  };
}
