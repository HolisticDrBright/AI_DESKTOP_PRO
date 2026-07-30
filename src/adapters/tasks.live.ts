if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import type { LiveQueueItem, LiveResolveResult } from "./live-types";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./supabase-rest.server";

/**
 * Live `tasks` namespace (server-only).
 *
 * Reads the org's review queue through a Desktop-owned SECURITY INVOKER
 * Supabase function. RLS still decides which patient and org-level rows the
 * caller can see. Resolving calls the existing atomic
 * `resolve_review_queue_item` RPC, which stamps the actor and audit event
 * server-side and is idempotent for an already-resolved row.
 */

interface ReviewQueueRow {
  id: string;
  item_type: string;
  title: string;
  priority: LiveQueueItem["priority"];
  status: LiveQueueItem["status"];
  patient_id: string | null;
  patient_name: string | null;
  assignee_name: string | null;
  due_at: string | null;
  created_at: string;
}

export const tasksLive = {
  async getQueue(sessionToken?: string | null, orgId?: string | null): Promise<LiveQueueItem[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const rows = await clinicalRpc<ReviewQueueRow[]>(
      "list_review_queue",
      { _organization_id: resolveOrgId(orgId) },
      token,
    );
    return rows.map((row) => ({
      id: row.id,
      itemType: row.item_type,
      title: row.title,
      priority: row.priority,
      status: row.status,
      patientId: row.patient_id,
      patientName: row.patient_name,
      assigneeName: row.assignee_name,
      dueAt: row.due_at,
      createdAt: row.created_at,
    }));
  },

  async resolveItem(
    itemId: string,
    note?: string,
    sessionToken?: string | null,
  ): Promise<LiveResolveResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      id: string;
      status: string;
      previous_status: string;
      already_resolved: boolean;
      audit_event_id?: string;
    }>(
      "resolve_review_queue_item",
      { _item_id: itemId, _note: note ?? null },
      token,
    );
    return {
      id: result.id,
      status: result.status,
      previousStatus: result.previous_status,
      alreadyResolved: result.already_resolved,
      ...(result.audit_event_id ? { auditEventId: result.audit_event_id } : {}),
    };
  },
};
