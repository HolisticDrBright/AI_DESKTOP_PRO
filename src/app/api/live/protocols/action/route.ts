import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { action, ... } — protocol lifecycle actions.
 *
 * `approve` and `activate` are DISTINCT actions on purpose: approving freezes a
 * version, activating puts it in effect. Neither implies the other, and the UI
 * confirms activation separately.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();

    switch (b.action) {
      case "approve": {
        if (typeof b.versionId !== "string") {
          throw new AdapterError("invalid", "A version id is required.");
        }
        return protocolsLive.approveVersion(
          b.versionId,
          typeof b.reviewNote === "string" ? b.reviewNote : null,
          session.token,
        );
      }
      case "activate": {
        if (typeof b.versionId !== "string") {
          throw new AdapterError("invalid", "A version id is required.");
        }
        return protocolsLive.activateVersion(b.versionId, session.token);
      }
      case "revise": {
        if (typeof b.versionId !== "string") {
          throw new AdapterError("invalid", "A version id is required.");
        }
        return protocolsLive.reviseVersion(b.versionId, session.token);
      }
      case "lifecycle": {
        if (typeof b.protocolId !== "string") {
          throw new AdapterError("invalid", "A protocol id is required.");
        }
        if (
          b.status !== "active" && b.status !== "paused" &&
          b.status !== "completed" && b.status !== "discontinued"
        ) {
          throw new AdapterError("invalid", "Unknown protocol status.");
        }
        return protocolsLive.setLifecycle(
          b.protocolId,
          b.status,
          typeof b.reason === "string" ? b.reason : null,
          session.token,
        );
      }
      default:
        throw new AdapterError("invalid", "Unknown protocol action.");
    }
  });
}
