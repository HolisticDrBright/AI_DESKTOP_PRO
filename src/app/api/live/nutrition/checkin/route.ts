import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const SOURCES = ["patient_reported", "practitioner_recorded", "imported_device", "imported_app"];

/** POST — record an adherence check-in. The source is never optional. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) throw new Error("patientId is required");
    if (typeof b.observedOn !== "string" || !b.observedOn) throw new Error("observedOn is required");
    // Adherence is always something someone reported. There is no path that
    // records a check-in with no stated origin.
    if (typeof b.source !== "string" || !SOURCES.includes(b.source)) {
      throw new Error("a check-in must say where it came from");
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    if (num(b.weightValue) !== null && typeof b.weightUnit !== "string") {
      throw new Error("a weight must carry a unit");
    }

    const session = await getRequestSession();
    return nutritionLive.recordCheckin(
      {
        patientId: b.patientId,
        observedOn: b.observedOn,
        source: b.source,
        planVersionId: typeof b.planVersionId === "string" ? b.planVersionId : null,
        mealPlanAdherencePct: num(b.mealPlanAdherencePct),
        dietAdherencePct: num(b.dietAdherencePct),
        hungerRating: num(b.hungerRating),
        satietyRating: num(b.satietyRating),
        energyRating: num(b.energyRating),
        digestiveTolerance: num(b.digestiveTolerance),
        symptoms: Array.isArray(b.symptoms)
          ? b.symptoms.filter((s): s is string => typeof s === "string")
          : [],
        patientNote: typeof b.patientNote === "string" ? b.patientNote : null,
        weightValue: num(b.weightValue),
        weightUnit: typeof b.weightUnit === "string" ? b.weightUnit : null,
      },
      session.orgId,
      session.token,
    );
  });
}
