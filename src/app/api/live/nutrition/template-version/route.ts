import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — draft the next template version. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.templateId !== "string" || !b.templateId) throw new AdapterError("invalid", "templateId is required");
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const session = await getRequestSession();
    return nutritionLive.createTemplateVersion(
      {
        templateId: b.templateId,
        purpose: typeof b.purpose === "string" ? b.purpose : null,
        intendedUse: typeof b.intendedUse === "string" ? b.intendedUse : null,
        patientEducation: typeof b.patientEducation === "string" ? b.patientEducation : null,
        educationVsAdviceNote:
          typeof b.educationVsAdviceNote === "string" ? b.educationVsAdviceNote : null,
        cautionPopulations: strings(b.cautionPopulations),
        prerequisites: strings(b.prerequisites),
        missingInformationRequired: strings(b.missingInformationRequired),
        evidenceGrade: typeof b.evidenceGrade === "string" ? b.evidenceGrade : null,
        evidenceSummary: typeof b.evidenceSummary === "string" ? b.evidenceSummary : null,
        copyFromVersionId: typeof b.copyFromVersionId === "string" ? b.copyFromVersionId : null,
      },
      session.orgId,
      session.token,
    );
  });
}
