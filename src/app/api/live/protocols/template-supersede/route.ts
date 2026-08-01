import { NextRequest } from "next/server";
import { protocolTemplateLive } from "@/adapters/product-catalog.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — point a template at its successor.
 *
 * Never a delete. Protocols already started from the template have to keep
 * resolving, so the row stays readable and simply stops being offered as a
 * starting point. Cycle detection lives in the database.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      templateId?: unknown;
      successorTemplateId?: unknown;
      reason?: unknown;
    };
    if (typeof b.templateId !== "string" || !b.templateId) {
      throw new AdapterError("invalid", "A template id is required.");
    }
    if (typeof b.successorTemplateId !== "string" || !b.successorTemplateId) {
      throw new AdapterError("invalid", "A successor template id is required.");
    }
    if (typeof b.reason !== "string" || !b.reason.trim()) {
      throw new AdapterError(
        "invalid",
        "Say why this template is being superseded.",
      );
    }
    const session = await getRequestSession();
    return protocolTemplateLive.supersede(
      b.templateId,
      b.successorTemplateId,
      b.reason,
      session.token,
    );
  });
}
