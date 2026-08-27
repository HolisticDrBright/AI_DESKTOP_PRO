if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveNutritionAdherenceSummary,
  LiveNutritionMutationResult,
  LiveNutritionTemplateLibrary,
  LiveNutritionVersionContent,
  LivePatientNutrition,
} from "./live-types";

/**
 * Live nutrition assessment, templates, plans & adherence (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in practitioner, so
 * the database enforces membership, the clinical-role gate on authoring and
 * approving, patient access, tenant agreement on every referenced row, and
 * expected-version concurrency.
 *
 * Boundaries this namespace can NEVER cross, because the RPCs have no such
 * code path:
 *
 *   - the browser cannot approve a plan whose safety review has not been run,
 *     or one that still carries an unresolved blocking flag. The check is in
 *     the definer function, so skipping the safety screen changes nothing;
 *   - the browser cannot edit an approved or active version. The immutability
 *     triggers refuse it even for a direct writer, so "revise" is always a new
 *     draft and the plan the patient was given stays readable;
 *   - a template edit cannot reach a delivered plan. Plans hold a snapshot;
 *   - nothing here can mark a template evidence-based. The deferred constraint
 *     trigger refuses a governed-reference grade without an actual reference;
 *   - adherence cannot be inferred. Every check-in carries a required source.
 */
export const nutritionLive = {
  /* ------------------------------------------------------------- reads */

  async listTemplates(
    includeArchived: boolean,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionTemplateLibrary> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveNutritionTemplateLibrary>(
      "list_nutrition_templates",
      { _organization_id: resolveOrgId(organizationId), _include_archived: includeArchived },
      token,
    );
  },

  async getVersionContent(
    input: { templateVersionId?: string | null; planVersionId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionVersionContent> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveNutritionVersionContent>(
      "get_nutrition_version_content",
      {
        _organization_id: resolveOrgId(organizationId),
        _template_version_id: input.templateVersionId ?? null,
        _plan_version_id: input.planVersionId ?? null,
      },
      token,
    );
  },

  async getPatientNutrition(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePatientNutrition> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientNutrition>(
      "get_patient_nutrition",
      { _organization_id: resolveOrgId(organizationId), _patient_id: patientId },
      token,
    );
  },

  async getAdherenceSummary(
    input: { patientId: string; days: number },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionAdherenceSummary> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveNutritionAdherenceSummary>(
      "get_nutrition_adherence_summary",
      {
        _organization_id: resolveOrgId(organizationId),
        _patient_id: input.patientId,
        _days: input.days,
      },
      token,
    );
  },

  /* -------------------------------------------------------- templates */

  async upsertTemplate(
    input: {
      templateId?: string | null;
      name: string;
      pattern?: string;
      summary?: string | null;
      expectedVersion?: number | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const id = await clinicalRpc<string>(
      "upsert_nutrition_template",
      {
        _organization_id: resolveOrgId(organizationId),
        _name: input.name,
        _pattern: input.pattern ?? "custom",
        _summary: input.summary ?? null,
        _template_id: input.templateId ?? null,
        _expected_version: input.expectedVersion ?? null,
      },
      token,
    );
    return { templateId: id };
  },

  async createTemplateVersion(
    input: {
      templateId: string;
      purpose?: string | null;
      intendedUse?: string | null;
      patientEducation?: string | null;
      educationVsAdviceNote?: string | null;
      cautionPopulations?: string[];
      prerequisites?: string[];
      missingInformationRequired?: string[];
      evidenceGrade?: string | null;
      evidenceSummary?: string | null;
      copyFromVersionId?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const id = await clinicalRpc<string>(
      "create_nutrition_template_version",
      {
        _organization_id: resolveOrgId(organizationId),
        _template_id: input.templateId,
        _purpose: input.purpose ?? null,
        _intended_use: input.intendedUse ?? null,
        _patient_education: input.patientEducation ?? null,
        _education_vs_advice_note: input.educationVsAdviceNote ?? null,
        _caution_populations: input.cautionPopulations ?? [],
        _prerequisites: input.prerequisites ?? [],
        _missing_information_required: input.missingInformationRequired ?? [],
        _evidence_grade: input.evidenceGrade ?? null,
        _evidence_summary: input.evidenceSummary ?? null,
        // Never exposed as a caller option: a template is review-gated.
        _requires_practitioner_review: true,
        _copy_from_version_id: input.copyFromVersionId ?? null,
      },
      token,
    );
    return { versionId: id };
  },

  async saveTemplateContent(
    input: { templateVersionId: string; content: unknown },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "save_nutrition_template_content",
      {
        _organization_id: resolveOrgId(organizationId),
        _template_version_id: input.templateVersionId,
        _content: input.content,
      },
      token,
    );
    return { ok: true };
  },

  async publishTemplateVersion(
    templateVersionId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "publish_nutrition_template_version",
      {
        _organization_id: resolveOrgId(organizationId),
        _template_version_id: templateVersionId,
      },
      token,
    );
    return { ok: true };
  },

  async archiveTemplate(
    input: { templateId: string; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "archive_nutrition_template",
      {
        _organization_id: resolveOrgId(organizationId),
        _template_id: input.templateId,
        _reason: input.reason,
      },
      token,
    );
    return { ok: true };
  },

  /* ------------------------------------------------------------ plans */

  async createPlan(
    input: { patientId: string; title: string; sourceTemplateVersionId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveNutritionMutationResult>(
      "create_nutrition_plan",
      {
        _organization_id: resolveOrgId(organizationId),
        _patient_id: input.patientId,
        _title: input.title,
        _source_template_version_id: input.sourceTemplateVersionId ?? null,
      },
      token,
    );
  },

  async savePlanVersion(
    input: {
      planVersionId: string;
      expectedVersion: number;
      goals?: string[] | null;
      practitionerRationale?: string | null;
      patientInstructions?: string | null;
      mealTimingGuidance?: string | null;
      fastingInstructions?: string | null;
      energyTargetValue?: number | null;
      energyTargetUnit?: string | null;
      proteinG?: number | null;
      carbohydrateG?: number | null;
      fatG?: number | null;
      fiberG?: number | null;
      proteinPct?: number | null;
      carbohydratePct?: number | null;
      fatPct?: number | null;
      content?: unknown;
      autosave?: boolean;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const version = await clinicalRpc<number>(
      "save_nutrition_plan_version",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_version_id: input.planVersionId,
        _expected_version: input.expectedVersion,
        _goals: input.goals ?? null,
        _practitioner_rationale: input.practitionerRationale ?? null,
        _patient_instructions: input.patientInstructions ?? null,
        _meal_timing_guidance: input.mealTimingGuidance ?? null,
        _fasting_instructions: input.fastingInstructions ?? null,
        _energy_target_value: input.energyTargetValue ?? null,
        _energy_target_unit: input.energyTargetUnit ?? null,
        _protein_g: input.proteinG ?? null,
        _carbohydrate_g: input.carbohydrateG ?? null,
        _fat_g: input.fatG ?? null,
        _fiber_g: input.fiberG ?? null,
        _protein_pct: input.proteinPct ?? null,
        _carbohydrate_pct: input.carbohydratePct ?? null,
        _fat_pct: input.fatPct ?? null,
        _content: input.content ?? null,
        _autosave: input.autosave === true,
      },
      token,
    );
    return { version };
  },

  async setConstraints(
    input: { planVersionId: string; constraints: unknown[] },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const count = await clinicalRpc<number>(
      "set_nutrition_plan_constraints",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_version_id: input.planVersionId,
        _constraints: input.constraints,
      },
      token,
    );
    return { count };
  },

  /* ---------------------------------------------------- safety review */

  async evaluateSafety(
    planVersionId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveNutritionMutationResult>(
      "evaluate_nutrition_plan_safety",
      { _organization_id: resolveOrgId(organizationId), _plan_version_id: planVersionId },
      token,
    );
  },

  async raiseSafetyFlag(
    input: { planVersionId: string; kind: string; severity: string; detail: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const id = await clinicalRpc<string>(
      "raise_nutrition_safety_flag",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_version_id: input.planVersionId,
        _kind: input.kind,
        _severity: input.severity,
        _detail: input.detail,
      },
      token,
    );
    return { id };
  },

  async resolveSafetyFlag(
    input: { flagId: string; action: string; reason?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "resolve_nutrition_safety_flag",
      {
        _organization_id: resolveOrgId(organizationId),
        _flag_id: input.flagId,
        _action: input.action,
        _reason: input.reason ?? null,
      },
      token,
    );
    return { ok: true };
  },

  /* -------------------------------------------------------- lifecycle */

  async submitPlanVersion(
    planVersionId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "submit_nutrition_plan_version",
      { _organization_id: resolveOrgId(organizationId), _plan_version_id: planVersionId },
      token,
    );
    return { ok: true };
  },

  async approvePlanVersion(
    input: { planVersionId: string; note?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "approve_nutrition_plan_version",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_version_id: input.planVersionId,
        _note: input.note ?? null,
      },
      token,
    );
    return { ok: true };
  },

  async activatePlanVersion(
    planVersionId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "activate_nutrition_plan_version",
      { _organization_id: resolveOrgId(organizationId), _plan_version_id: planVersionId },
      token,
    );
    return { ok: true };
  },

  async setPlanLifecycle(
    input: { planId: string; action: string; reason?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "set_nutrition_plan_lifecycle",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_id: input.planId,
        _action: input.action,
        _reason: input.reason ?? null,
      },
      token,
    );
    return { ok: true };
  },

  async revisePlanVersion(
    input: { planVersionId: string; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const id = await clinicalRpc<string>(
      "revise_nutrition_plan_version",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_version_id: input.planVersionId,
        _reason: input.reason,
      },
      token,
    );
    return { planVersionId: id };
  },

  async addAmendment(
    input: { planVersionId: string; body: string; reason: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const id = await clinicalRpc<string>(
      "add_nutrition_amendment",
      {
        _organization_id: resolveOrgId(organizationId),
        _plan_version_id: input.planVersionId,
        _body: input.body,
        _reason: input.reason,
      },
      token,
    );
    return { id };
  },

  /* -------------------------------------------------------- adherence */

  async recordCheckin(
    input: {
      patientId: string;
      observedOn: string;
      source: string;
      planVersionId?: string | null;
      mealPlanAdherencePct?: number | null;
      dietAdherencePct?: number | null;
      hungerRating?: number | null;
      satietyRating?: number | null;
      energyRating?: number | null;
      digestiveTolerance?: number | null;
      symptoms?: string[];
      patientNote?: string | null;
      weightValue?: number | null;
      weightUnit?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const id = await clinicalRpc<string>(
      "record_nutrition_checkin",
      {
        _organization_id: resolveOrgId(organizationId),
        _patient_id: input.patientId,
        _observed_on: input.observedOn,
        _source: input.source,
        _plan_version_id: input.planVersionId ?? null,
        _meal_plan_adherence_pct: input.mealPlanAdherencePct ?? null,
        _diet_adherence_pct: input.dietAdherencePct ?? null,
        _hunger_rating: input.hungerRating ?? null,
        _satiety_rating: input.satietyRating ?? null,
        _energy_rating: input.energyRating ?? null,
        _digestive_tolerance: input.digestiveTolerance ?? null,
        _symptoms: input.symptoms ?? [],
        _patient_note: input.patientNote ?? null,
        _weight_value: input.weightValue ?? null,
        _weight_unit: input.weightUnit ?? null,
      },
      token,
    );
    return { id };
  },

  async reviewCheckin(
    input: { checkinId: string; state: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveNutritionMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "review_nutrition_checkin",
      {
        _organization_id: resolveOrgId(organizationId),
        _checkin_id: input.checkinId,
        _state: input.state,
      },
      token,
    );
    return { ok: true };
  },
};

/* --------------------------------------------------- starter library */

/**
 * Install the starter diet templates into this organization.
 *
 * Goes through the same governed path a practitioner uses and is idempotent on
 * a content hash, so re-running it when nothing changed reports `unchanged`
 * rather than minting a version that differs in nothing.
 */
export async function installStarterTemplates(
  organizationId?: string | null,
  sessionToken?: string | null,
): Promise<Array<{ slug: string; outcome: string }>> {
  const { STARTER_TEMPLATES, starterContentHash } = await import(
    "@/server/nutrition-starter-templates"
  );
  const token = await getClinicalAccessToken(sessionToken);
  const orgId = resolveOrgId(organizationId);
  const results: Array<{ slug: string; outcome: string }> = [];

  for (const template of STARTER_TEMPLATES) {
    const result = await clinicalRpc<{ outcome: string }>(
      "install_nutrition_starter_template",
      {
        _organization_id: orgId,
        _slug: template.slug,
        _name: template.name,
        _pattern: template.pattern,
        _summary: template.summary,
        _meta: template.meta,
        _content: template.content,
        _content_hash: starterContentHash(template),
      },
      token,
    );
    results.push({ slug: template.slug, outcome: result?.outcome ?? "installed" });
  }
  return results;
}
