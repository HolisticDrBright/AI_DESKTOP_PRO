import { NextRequest } from "next/server";
import { productCatalogLive } from "@/adapters/product-catalog.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — record that a named person checked this exact label.
 *
 * The note is required here as well as in the adapter: a verification with no
 * statement of what was checked is not evidence of anything. The DATABASE
 * decides whether the caller may verify at all (owner/admin), so a practitioner
 * reaching this route is refused there rather than here.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      labelVersionId?: unknown;
      verificationNote?: unknown;
    };
    if (typeof b.labelVersionId !== "string" || !b.labelVersionId) {
      throw new AdapterError("invalid", "A label version id is required.");
    }
    if (typeof b.verificationNote !== "string" || !b.verificationNote.trim()) {
      throw new AdapterError(
        "invalid",
        "Say what you checked. A verification with no note is not evidence.",
      );
    }
    const session = await getRequestSession();
    await productCatalogLive.verifyLabel(
      b.labelVersionId,
      b.verificationNote,
      session.token,
    );
    return { ok: true as const };
  });
}
