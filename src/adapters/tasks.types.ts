import type { ActionKind } from "./actions";
import type { Priority, ProvenanceData, Tone } from "./types";

/**
 * Review-queue vocabulary shared by the live adapter, the mapper, and the UI.
 *
 * Extracted from `tasks.mock.ts` so the clinical runtime never imports a mock
 * module: these are category labels and row shapes, not data. The synthetic
 * queue rows themselves stay in `tasks.mock.ts`, which is test-fixture-only.
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
  /** Assigned practitioner display name; "You" for the signed-in caller. */
  assignee: string;
  /** Composer seeds when the item is converted to a note/report. */
  seeds: string[];
  /** Extra actions beyond the shared default set. */
  extraActions?: ActionKind[];
  /** True when this row came from the live backend (review_queue_items). */
  live?: boolean;
  /**
   * Settled state carried by the LIVE row itself (status column), so a
   * resolved/snoozed item still reads as settled after reload. In-memory
   * optimistic outcomes take precedence within a render session.
   */
  settledOutcome?: "resolved" | "snoozed";
}
