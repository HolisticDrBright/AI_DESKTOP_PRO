import type { QueueCategory, QueueItem } from "./tasks.mock";
import type { LiveQueueItem } from "./live-types";
import type { Priority } from "./types";

/**
 * Map a live review_queue_items row to the QueueItem shape the Tasks screen
 * renders (client-safe, no runtime deps). Clinical fields are real; purely
 * presentational fields with no column yet get neutral, clearly-labelled
 * defaults — never fabricated clinical facts.
 */

const ITEM_TYPE_TO_CATEGORY: Record<string, QueueCategory> = {
  safety_alert: "safety-alert",
  abnormal_result: "new-lab",
  lab_extraction: "extraction-review",
  reasoning_snapshot: "reasoning-review",
  hypothesis: "reasoning-review",
  recommendation: "reasoning-review",
  protocol: "protocol-approval",
  experiment: "experiment-approval",
  patient_message: "patient-message",
  assessment: "assessment-review",
  overdue_followup: "overdue-followup",
  low_adherence: "low-adherence",
  refill_request: "refill-request",
};

const PRIORITY: Record<LiveQueueItem["priority"], Priority> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const DAY_MS = 86_400_000;

function dueLabel(dueAt: string | null): { due: string; dueInDays: number } {
  // Large positive keeps "no due date" out of the overdue filter AND out of
  // the due-today warning tone (0 would style it as due today).
  if (!dueAt) return { due: "No due date", dueInDays: 9999 };
  const days = Math.round((new Date(dueAt).getTime() - Date.now()) / DAY_MS);
  if (days < -1) return { due: `${-days} days overdue`, dueInDays: days };
  if (days === -1) return { due: "1 day overdue", dueInDays: days };
  if (days === 0) return { due: "Due today", dueInDays: 0 };
  if (days === 1) return { due: "Due tomorrow", dueInDays: 1 };
  return { due: `Due in ${days} days`, dueInDays: days };
}

export function mapLiveQueueItem(row: LiveQueueItem): QueueItem {
  const { due, dueInDays } = dueLabel(row.dueAt);
  return {
    id: row.id,
    category: ITEM_TYPE_TO_CATEGORY[row.itemType] ?? "assessment-review",
    title: row.title || "(untitled review item)",
    patientName: row.patientName ?? "Organization-level",
    patientId: row.patientId ?? "",
    priority: PRIORITY[row.priority] ?? "Medium",
    due,
    dueInDays,
    provenance: {
      sourceType: "practitioner-confirmed",
      sourceName: "Review queue · live record",
      lastUpdated: new Date(row.createdAt).toLocaleDateString(),
      review: row.status === "resolved" ? "reviewed" : "awaiting-review",
    },
    assignee: row.assigneeName ?? "Unassigned",
    seeds: [row.title],
    live: true,
    settledOutcome:
      row.status === "resolved" ? "resolved" : row.status === "snoozed" ? "snoozed" : undefined,
  };
}
