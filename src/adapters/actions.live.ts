if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { ACTIVE_ORG_ID } from "./config";
import type { LiveAuditEvent, LiveTaskResult } from "./live-types";

/**
 * Live `actions` namespace (server-only).
 *
 * The persistent audit + downstream-task write path. Backed by the tRPC
 * backend's `clinical.actions.*` procedures, which call the append-only
 * `record_audit_event` / `create_review_task` SECURITY DEFINER RPCs
 * (migration 0013) as the authenticated practitioner. Callers pass only
 * PHI-safe safe_message + metadata; the RPCs stamp actor ids server-side.
 */

export interface RecordAuditInput {
  action: string;
  resourceType?: string;
  resourceId?: string;
  safeMessage?: string;
  patientId?: string;
  metadata?: Record<string, unknown>;
  organizationId?: string;
}

export const actionsLive = {
  recordAudit(input: RecordAuditInput, sessionToken?: string | null): Promise<{ id: string }> {
    return trpcMutation<{ id: string }>("clinical.actions.recordAudit", {
      organizationId: input.organizationId ?? ACTIVE_ORG_ID,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      safeMessage: input.safeMessage ?? null,
      patientId: input.patientId ?? null,
      metadata: input.metadata ?? {},
    }, sessionToken);
  },

  listAuditEvents(
    organizationId?: string,
    limit = 50,
    sessionToken?: string | null,
  ): Promise<LiveAuditEvent[]> {
    return trpcQuery<LiveAuditEvent[]>("clinical.actions.listAuditEvents", {
      organizationId: organizationId ?? ACTIVE_ORG_ID,
      limit,
    }, sessionToken);
  },

  createReviewTask(input: {
    patientId: string;
    title: string;
    itemType?: string;
    priority?: "low" | "medium" | "high";
    refId?: string;
  }, sessionToken?: string | null): Promise<LiveTaskResult> {
    return trpcMutation<LiveTaskResult>("clinical.actions.createReviewTask", {
      patientId: input.patientId,
      title: input.title,
      itemType: input.itemType ?? "abnormal_result",
      priority: input.priority ?? "medium",
      refId: input.refId ?? null,
    }, sessionToken);
  },
};
