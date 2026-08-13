import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET — the declared source-file inventory, including files never read. */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return importReviewLive.sourceInventory(session.orgId, session.token);
  });
}

/**
 * POST — declare a source file.
 *
 * The availability rules are the database's and are not restated here beyond
 * shape checks: a duplicate rule in an adapter is a rule that drifts.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.declaredName !== "string" || !b.declaredName.trim()) {
      throw new AdapterError("invalid", "A declared file name is required.");
    }
    if (b.availability !== "available" && b.availability !== "unavailable") {
      throw new AdapterError("invalid", "Availability must be available or unavailable.");
    }
    const session = await getRequestSession();
    return importReviewLive.recordSourceFile(
      {
        declaredName: b.declaredName,
        sourceKind: typeof b.sourceKind === "string" ? b.sourceKind : null,
        availability: b.availability,
        contentSha256: typeof b.contentSha256 === "string" ? b.contentSha256 : null,
        byteSize: typeof b.byteSize === "number" ? b.byteSize : null,
        unavailableReason:
          typeof b.unavailableReason === "string" ? b.unavailableReason : null,
      },
      session.orgId,
      session.token,
    );
  });
}
