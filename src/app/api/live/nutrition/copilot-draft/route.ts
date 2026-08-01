import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { CopilotDisabledError, draftPlanFromTemplate } from "@/server/nutrition-copilot";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — draft suggestions for a plan version from its source template.
 *
 * Reads only. The copilot writes nothing: the route fetches the governed
 * inputs, hands them to a deterministic assembler, and returns labelled draft
 * suggestions. Whether any of them become part of the plan is a separate,
 * practitioner-initiated save.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.planVersionId !== "string" || !b.planVersionId) {
      throw new AdapterError("invalid", "planVersionId is required");
    }
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new AdapterError("invalid", "patientId is required");
    }
    const session = await getRequestSession();

    const [content, patient] = await Promise.all([
      nutritionLive.getVersionContent(
        { planVersionId: b.planVersionId },
        session.orgId,
        session.token,
      ),
      nutritionLive.getPatientNutrition(b.patientId, session.orgId, session.token),
    ]);

    const version = patient.plans
      .flatMap((p) => p.versions)
      .find((v) => v.id === b.planVersionId);
    if (!version) throw new AdapterError("not_found");

    try {
      return draftPlanFromTemplate({
        template: {
          templateName: version.sourceTemplateName ?? "this plan",
          versionNumber: version.sourceTemplateVersion ?? 1,
          // A plan built from a starter template inherits its review
          // requirement; one authored from scratch still needs review.
          requiresPractitionerReview: true,
          foodRules: content.foodRules.map((r) => ({
            disposition: r.disposition as
              | "emphasize"
              | "include"
              | "limit"
              | "avoid"
              | "conditional",
            label: r.label,
            conditionNote: r.conditionNote,
          })),
        },
        constraints: version.constraints.map((c) => ({
          kind: c.kind,
          label: c.label,
          severity: c.severity,
          source: c.source,
        })),
      });
    } catch (e) {
      // A deliberately disabled boundary is UNAVAILABLE, not a crash. Reporting
      // it as 500 would read as a fault and invite a retry; the honest answer is
      // that the copilot is off, and why.
      if (e instanceof CopilotDisabledError) {
        throw new AdapterError("unavailable", `${e.message} ${e.problems.join(" ")}`.trim());
      }
      throw e;
    }
  });
}
