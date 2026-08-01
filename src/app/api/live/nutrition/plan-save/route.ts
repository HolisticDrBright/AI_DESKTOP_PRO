import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — save a draft plan version under optimistic concurrency. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new AdapterError("invalid", "planVersionId is required");
    }
    if (typeof b.expectedVersion !== "number") {
      throw new AdapterError("invalid", "expectedVersion is required");
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === "string" ? v : null);

    // Refused here as well as at the database, so the practitioner sees a
    // sentence rather than a SQLSTATE. An unlabelled energy number is exactly
    // the ambiguity this phase exists to remove.
    if (num(b.energyTargetValue) !== null && !str(b.energyTargetUnit)) {
      throw new AdapterError("invalid", "an energy target must carry a unit");
    }

    const session = await getRequestSession();
    return nutritionLive.savePlanVersion(
      {
        planVersionId: b.planVersionId,
        expectedVersion: b.expectedVersion,
        goals: Array.isArray(b.goals)
          ? b.goals.filter((g): g is string => typeof g === "string")
          : null,
        practitionerRationale: str(b.practitionerRationale),
        patientInstructions: str(b.patientInstructions),
        mealTimingGuidance: str(b.mealTimingGuidance),
        fastingInstructions: str(b.fastingInstructions),
        energyTargetValue: num(b.energyTargetValue),
        energyTargetUnit: str(b.energyTargetUnit),
        proteinG: num(b.proteinG),
        carbohydrateG: num(b.carbohydrateG),
        fatG: num(b.fatG),
        fiberG: num(b.fiberG),
        proteinPct: num(b.proteinPct),
        carbohydratePct: num(b.carbohydratePct),
        fatPct: num(b.fatPct),
        content: b.content ?? null,
        autosave: b.autosave === true,
      },
      session.orgId,
      session.token,
    );
  });
}
