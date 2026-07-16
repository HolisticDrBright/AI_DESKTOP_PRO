if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { ACTIVE_ORG_ID } from "./config";
import type { LiveQueueItem, LiveResolveResult } from "./live-types";

/**
 * Live `tasks` namespace (server-only).
 *
 * Reads the org's review queue and resolves items through the authenticated
 * tRPC backend's `clinical.tasks.*` procedures (RLS-scoped: the caller only
 * sees items for patients they can access). Resolving calls the
 * `resolve_review_queue_item` SECURITY DEFINER RPC (migration 0014), which
 * updates the row's status and appends the audit_events row atomically,
 * stamping the actor server-side. Idempotent on already-resolved items.
 */
export const tasksLive = {
  getQueue(): Promise<LiveQueueItem[]> {
    return trpcQuery<LiveQueueItem[]>("clinical.tasks.getQueue", {
      organizationId: ACTIVE_ORG_ID,
    });
  },

  resolveItem(itemId: string, note?: string): Promise<LiveResolveResult> {
    return trpcMutation<LiveResolveResult>("clinical.tasks.resolve", { itemId, note });
  },
};
