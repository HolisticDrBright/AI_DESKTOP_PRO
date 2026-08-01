import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — sell a package. Drafts the purchase INVOICE only; entitlements are
 * granted when that invoice is actually paid, so an unpaid purchase can never
 * confer a benefit.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) throw new Error("patientId is required");
    if (typeof b.packageVersionId !== "string" || !b.packageVersionId) {
      throw new Error("packageVersionId is required");
    }
    const session = await getRequestSession();
    return plansLive.purchasePackage(
      {
        patientId: b.patientId,
        packageVersionId: b.packageVersionId,
        acceptanceMethod:
          typeof b.acceptanceMethod === "string" ? b.acceptanceMethod : "in_person",
      },
      session.orgId,
      session.token,
    );
  });
}
