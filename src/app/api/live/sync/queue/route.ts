import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import type { LiveSyncOutboundResourceType } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { connectionId, resourceType, resourceId, withdraw?, reason? }.
 * Queue (or withdraw) a resource export. The envelope payload is built by
 * the database; without a provider the queue action refuses durably.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      connectionId?: unknown;
      resourceType?: unknown;
      resourceId?: unknown;
      withdraw?: unknown;
      reason?: unknown;
    };
    if (
      typeof b.connectionId !== "string" ||
      typeof b.resourceType !== "string" ||
      typeof b.resourceId !== "string"
    ) {
      throw new Error("connectionId, resourceType, and resourceId are required");
    }
    const session = await getRequestSession();
    if (b.withdraw === true) {
      if (typeof b.reason !== "string" || !b.reason.trim()) {
        throw new Error("withdrawal requires a reason");
      }
      return patientSyncLive.withdrawResource(
        {
          connectionId: b.connectionId,
          resourceType: b.resourceType as LiveSyncOutboundResourceType,
          resourceId: b.resourceId,
          reason: b.reason,
        },
        session.token,
      );
    }
    return patientSyncLive.queueExport(
      {
        connectionId: b.connectionId,
        resourceType: b.resourceType as LiveSyncOutboundResourceType,
        resourceId: b.resourceId,
      },
      session.token,
    );
  });
}
