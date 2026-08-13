import { NextRequest } from "next/server";
import { protocolTemplateLive } from "@/adapters/product-catalog.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — a structured diff of two TEMPLATE versions.
 *
 * They need not share a template. Whether a patient protocol version is
 * allowed on either side is decided by the database, not here.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      leftVersionId?: unknown;
      rightVersionId?: unknown;
    };
    if (typeof b.leftVersionId !== "string" || !b.leftVersionId) {
      throw new AdapterError("invalid", "A left version id is required.");
    }
    if (typeof b.rightVersionId !== "string" || !b.rightVersionId) {
      throw new AdapterError("invalid", "A right version id is required.");
    }
    const session = await getRequestSession();
    return protocolTemplateLive.compare(
      b.leftVersionId,
      b.rightVersionId,
      session.token,
    );
  });
}
