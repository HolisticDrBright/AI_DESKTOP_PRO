import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import type { LivePlanType } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const num = (v: unknown, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * POST — draft the next plan version. Terms live on the version so publishing
 * freezes them; an accepted version can never be rewritten.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.planType !== "package" && b.planType !== "membership") {
      throw new Error("planType must be package or membership");
    }
    if (typeof b.planId !== "string" || !b.planId) throw new Error("planId is required");
    if (typeof b.priceMinor !== "number" || !Number.isFinite(b.priceMinor)) {
      throw new Error("priceMinor is required");
    }
    const session = await getRequestSession();
    return plansLive.createPlanVersion(
      {
        planType: b.planType as LivePlanType,
        planId: b.planId,
        priceMinor: b.priceMinor,
        currency: typeof b.currency === "string" && b.currency ? b.currency : "USD",
        creditQuantity: num(b.creditQuantity, 0),
        creditMode: b.creditMode === "multi_use" ? "multi_use" : "single_use",
        expiresAfterDays:
          typeof b.expiresAfterDays === "number" && Number.isFinite(b.expiresAfterDays)
            ? b.expiresAfterDays
            : null,
        intervalUnit: typeof b.intervalUnit === "string" ? b.intervalUnit : "month",
        intervalCount: num(b.intervalCount, 1),
        trialDays: num(b.trialDays, 0),
        includedCredits: num(b.includedCredits, 0),
        minimumCommitmentPeriods: num(b.minimumCommitmentPeriods, 0),
        gracePeriodDays: num(b.gracePeriodDays, 0),
        eligibleProductIds: ids(b.eligibleProductIds),
        eligibleLocationIds: ids(b.eligibleLocationIds),
        eligiblePractitionerIds: ids(b.eligiblePractitionerIds),
        transferPolicy:
          typeof b.transferPolicy === "string" ? b.transferPolicy : "non_transferable",
        termsSummary: typeof b.termsSummary === "string" ? b.termsSummary : null,
      },
      session.orgId,
      session.token,
    );
  });
}
