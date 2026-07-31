import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import type { LivePackageKind, LivePlanType } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const KINDS: LivePackageKind[] = [
  "visit_credits", "product_bundle", "lab_bundle", "program_bundle", "mixed",
];

/** POST — create, rename, or archive a plan. Archiving preserves history. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.planType !== "package" && b.planType !== "membership") {
      throw new Error("planType must be package or membership");
    }
    const session = await getRequestSession();
    return plansLive.upsertPlan(
      {
        planType: b.planType as LivePlanType,
        id: typeof b.id === "string" && b.id ? b.id : null,
        expectedVersion:
          typeof b.expectedVersion === "number" && Number.isFinite(b.expectedVersion)
            ? b.expectedVersion
            : null,
        name: typeof b.name === "string" ? b.name : null,
        description: typeof b.description === "string" ? b.description : null,
        kind: KINDS.includes(b.kind as LivePackageKind) ? (b.kind as LivePackageKind) : null,
        archive: b.archive === true,
      },
      session.orgId,
      session.token,
    );
  });
}
