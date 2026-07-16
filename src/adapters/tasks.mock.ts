import type { ActionKind } from "./actions";
import type { Priority, ProvenanceData, Tone } from "./types";

/**
 * MOCK practitioner review queue. Synthetic data only. Shaped like a future
 * `api.tasks.getQueue` tRPC query. Row review state (resolve/snooze/…) is not
 * stored here — it lives in the demo session store, so the UI stays coherent
 * across a session without pretending to be backend persistence.
 */

export type QueueCategory =
  | "new-lab"
  | "extraction-review"
  | "reasoning-review"
  | "safety-alert"
  | "protocol-approval"
  | "experiment-approval"
  | "patient-message"
  | "assessment-review"
  | "overdue-followup"
  | "low-adherence"
  | "refill-request"
  | "import-review";

export interface QueueCategoryMeta {
  id: QueueCategory;
  label: string;
  tone: Tone;
}

export const QUEUE_CATEGORIES: QueueCategoryMeta[] = [
  { id: "safety-alert", label: "Safety alert", tone: "critical" },
  { id: "new-lab", label: "New lab results", tone: "navy" },
  { id: "extraction-review", label: "Extraction review", tone: "ai" },
  { id: "reasoning-review", label: "Clinical reasoning", tone: "ai" },
  { id: "protocol-approval", label: "Protocol approval", tone: "action" },
  { id: "experiment-approval", label: "Experiment approval", tone: "teal" },
  { id: "patient-message", label: "Patient messages", tone: "teal" },
  { id: "assessment-review", label: "Assessment review", tone: "slate" },
  { id: "overdue-followup", label: "Overdue follow-up", tone: "warning" },
  { id: "low-adherence", label: "Low adherence", tone: "warning" },
  { id: "refill-request", label: "Refill request", tone: "action" },
  { id: "import-review", label: "Import review", tone: "warning" },
];

export const CATEGORY_LABEL = Object.fromEntries(
  QUEUE_CATEGORIES.map((c) => [c.id, c.label]),
) as Record<QueueCategory, string>;

export const CATEGORY_TONE = Object.fromEntries(
  QUEUE_CATEGORIES.map((c) => [c.id, c.tone]),
) as Record<QueueCategory, Tone>;

export const PRACTITIONER_SELF = "Dr. Sarah Mitchell";

export interface QueueItem {
  id: string;
  category: QueueCategory;
  title: string;
  patientName: string;
  patientId: string;
  priority: Priority;
  /** Human due/age label, e.g. "Due today", "2 days overdue". */
  due: string;
  /** Signed age in days (negative = overdue) for sorting/labels. */
  dueInDays: number;
  provenance: ProvenanceData;
  /** Assigned practitioner; PRACTITIONER_SELF marks "my tasks". */
  assignee: string;
  /** Composer seeds when the item is converted to a note/report. */
  seeds: string[];
  /** Extra actions beyond the shared default set. */
  extraActions?: ActionKind[];
  /** True when this row came from the live backend (review_queue_items). */
  live?: boolean;
  /**
   * Settled state carried by the LIVE row itself (status column), so a
   * resolved/snoozed item still reads as settled after reload. Session
   * outcomes take precedence for within-session optimistic updates.
   */
  settledOutcome?: "resolved" | "snoozed";
}

const QUEUE: QueueItem[] = [
  {
    id: "q-1001",
    category: "safety-alert",
    title: "High AM cortisol (21.3 µg/dL) with elevated hs-CRP",
    patientName: "Alexandra Morgan",
    patientId: "p-78435",
    priority: "High",
    due: "Due today",
    dueInDays: 0,
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", review: "awaiting-review", confidence: 86 },
    assignee: PRACTITIONER_SELF,
    seeds: ["High AM cortisol (21.3 µg/dL)", "Elevated hs-CRP (2.8 mg/L)"],
    extraActions: ["message_patient"],
  },
  {
    id: "q-1002",
    category: "new-lab",
    title: "New Quest panel imported — 12 markers",
    patientName: "Michael Johnson",
    patientId: "p-64201",
    priority: "Medium",
    due: "Due in 1 day",
    dueInDays: 1,
    provenance: { sourceType: "imported-record", sourceName: "Quest · Jun 30", dateRange: "Single panel", review: "awaiting-review", confidence: 74 },
    assignee: PRACTITIONER_SELF,
    seeds: ["New Quest panel: 12 markers", "ApoB 112 mg/dL, HbA1c 5.7%"],
  },
  {
    id: "q-1003",
    category: "extraction-review",
    title: "3 low-confidence markers need confirmation",
    patientName: "Michael Johnson",
    patientId: "p-64201",
    priority: "Medium",
    due: "Due in 2 days",
    dueInDays: 2,
    provenance: { sourceType: "ai-inference", sourceName: "Extraction engine", dateRange: "Lab PDF p.2", review: "not-reviewed", confidence: 41, conflicts: 1 },
    assignee: PRACTITIONER_SELF,
    seeds: ["Low-confidence extraction: fasting insulin, ApoB, Omega-3"],
  },
  {
    id: "q-1004",
    category: "reasoning-review",
    title: "Reasoning snapshot updated — 3 hypotheses await review",
    patientName: "Priya Sharma",
    patientId: "p-59318",
    priority: "High",
    due: "Due today",
    dueInDays: 0,
    provenance: { sourceType: "ai-inference", sourceName: "Reasoning engine", dateRange: "Labs Jul 8 · wearables 30 d", review: "awaiting-review", confidence: 81 },
    assignee: PRACTITIONER_SELF,
    seeds: ["Iron-deficiency anemia (strength 88)", "Ferritin 9 ng/mL below range"],
  },
  {
    id: "q-1005",
    category: "protocol-approval",
    title: "Iron repletion protocol — phase 1 pending approval",
    patientName: "Priya Sharma",
    patientId: "p-59318",
    priority: "High",
    due: "1 day overdue",
    dueInDays: -1,
    provenance: { sourceType: "practitioner-confirmed", sourceName: "Draft protocol", dateRange: "Created Jul 14", review: "awaiting-review" },
    assignee: PRACTITIONER_SELF,
    seeds: ["Iron protocol phase 1", "Recheck CBC + ferritin in 4 weeks"],
  },
  {
    id: "q-1006",
    category: "experiment-approval",
    title: "Berberine 500 mg N-of-1 design ready to approve",
    patientName: "Marcus Webb",
    patientId: "p-52984",
    priority: "Medium",
    due: "Due in 3 days",
    dueInDays: 3,
    provenance: { sourceType: "practitioner-confirmed", sourceName: "N-of-1 designer", dateRange: "2-week protocol", review: "awaiting-review" },
    assignee: "Health Coach",
    seeds: ["Berberine 500 mg experiment", "Two-week CGM trial"],
  },
  {
    id: "q-1007",
    category: "patient-message",
    title: "Patient asked about evening supplement timing",
    patientName: "Dana Whitfield",
    patientId: "p-66473",
    priority: "Low",
    due: "Due in 1 day",
    dueInDays: 1,
    provenance: { sourceType: "patient-reported", sourceName: "Patient portal", dateRange: "Received Jul 14", review: "awaiting-review" },
    assignee: PRACTITIONER_SELF,
    seeds: ["Patient question: evening supplement timing"],
    extraActions: ["message_patient"],
  },
  {
    id: "q-1008",
    category: "assessment-review",
    title: "PSS-10 stress assessment submitted",
    patientName: "Dana Whitfield",
    patientId: "p-66473",
    priority: "Low",
    due: "Due in 4 days",
    dueInDays: 4,
    provenance: { sourceType: "patient-reported", sourceName: "Assessment · PSS-10", dateRange: "Submitted Jul 13", review: "awaiting-review", confidence: 100 },
    assignee: "Registered Dietitian",
    seeds: ["PSS-10 stress assessment result"],
  },
  {
    id: "q-1009",
    category: "overdue-followup",
    title: "Check-ins stopped Jul 6 — re-engagement needed",
    patientName: "Marcus Webb",
    patientId: "p-52984",
    priority: "High",
    due: "3 days overdue",
    dueInDays: -3,
    provenance: { sourceType: "measured", sourceName: "Adherence tracker", dateRange: "Last 21 days", review: "awaiting-review" },
    assignee: PRACTITIONER_SELF,
    seeds: ["Daily check-ins stopped Jul 6", "HbA1c trending up (5.9%)"],
  },
  {
    id: "q-1010",
    category: "low-adherence",
    title: "Supplement adherence 46% over 2 weeks",
    patientName: "Michael Johnson",
    patientId: "p-64201",
    priority: "Medium",
    due: "Due in 2 days",
    dueInDays: 2,
    provenance: { sourceType: "measured", sourceName: "Adherence tracker", dateRange: "Last 14 days", review: "awaiting-review", confidence: 92 },
    assignee: "Health Coach",
    seeds: ["Supplement adherence 46%", "Simplify and restart stack"],
  },
  {
    id: "q-1011",
    category: "refill-request",
    title: "Magnesium glycinate refill requested",
    patientName: "Jessica Parker",
    patientId: "p-71126",
    priority: "Low",
    due: "Due in 5 days",
    dueInDays: 5,
    provenance: { sourceType: "patient-reported", sourceName: "Patient portal", dateRange: "Requested Jul 12", review: "awaiting-review" },
    assignee: PRACTITIONER_SELF,
    seeds: ["Refill: magnesium glycinate"],
  },
  {
    id: "q-1012",
    category: "import-review",
    title: "Practice Better import — 2 records queued for review",
    patientName: "Alexandra Morgan",
    patientId: "p-78435",
    priority: "Medium",
    due: "Due in 1 day",
    dueInDays: 1,
    provenance: { sourceType: "imported-record", sourceName: "Practice Better export", dateRange: "Imported today", review: "awaiting-review" },
    assignee: PRACTITIONER_SELF,
    seeds: ["Practice Better import: 2 records", "source_record_id preserved"],
  },
];

export function getTaskQueue(): QueueItem[] {
  return QUEUE;
}
