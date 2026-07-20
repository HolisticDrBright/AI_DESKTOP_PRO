/**
 * Registry parity — proves the desktop platform scores against EXACTLY the
 * same clinical content as the mobile app:
 *
 *  1. the vendored registry JSON is byte-identical to the canonical copy
 *     (sha256 of the file bytes equals the pin shared by both repos);
 *  2. the database migration seeds the SAME content hash, so
 *     submit_assessment's hash verification and this bundle agree;
 *  3. the shared golden fixtures (boundary cases at the 25/50 band edges,
 *     special answers, insufficient completeness, unknown-question rejection,
 *     lab-rule dedupe) produce identical results through the desktop port.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import goldenFixtures from "./golden-fixtures.v1.json";
import {
  legacyScoreV1,
  listApprovedProducts,
  listDraftableProducts,
  partitionKnownProductIds,
  QUESTIONNAIRE,
  LAB_CATALOG,
  LAB_RULES,
  PROTOCOL_TEMPLATES,
  recommendLabs,
  REGISTRY_CONTENT_SHA256,
  resolveProductByName,
  scoreSubmission,
  SUPPLEMENT_REGISTRY,
  type SubmittedAnswer,
} from "./index";

const HERE = join(__dirname);

/** Legacy (pre-registry) question IDs, category by category — the migration contract. */
const LEGACY_PREFIXES: Record<string, string> = {
  thyroid: "thy", adrenal: "adr", hormones: "horm", gut_digestive: "gut",
  gallbladder: "gb", blood_sugar: "bs", autoimmune: "ai", parasites: "par",
  lyme: "lyme", mold: "mold", heavy_metals: "hm", viral: "vir",
  methylation: "meth", emf: "emf", leaky_gut: "lg",
};

describe("cross-repo content parity", () => {
  it("vendored registry JSON is byte-identical to the canonical content (sha256 pin)", () => {
    const bytes = readFileSync(join(HERE, "registry-content.v1.json"));
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(hash).toBe(REGISTRY_CONTENT_SHA256);
  });

  it("the clinical migration seeds the same content hash the runtime pins", () => {
    const sql = readFileSync(
      join(HERE, "../../../supabase/migrations/20260720000027_assessments_clinical_registry.sql"),
      "utf8",
    );
    expect(sql).toContain(REGISTRY_CONTENT_SHA256);
  });

  it("preserves all 15 categories and 150 question IDs from the legacy questionnaire", () => {
    expect(QUESTIONNAIRE.categories).toHaveLength(15);
    const allIds = QUESTIONNAIRE.categories.flatMap((c) => c.questions.map((q) => q.id));
    expect(allIds).toHaveLength(150);
    expect(new Set(allIds).size).toBe(150);
    for (const c of QUESTIONNAIRE.categories) {
      expect(c.questions).toHaveLength(10);
      const prefix = LEGACY_PREFIXES[c.id];
      expect(prefix, `unknown category ${c.id}`).toBeTruthy();
      c.questions.forEach((q, i) => expect(q.id).toBe(`${prefix}_${i + 1}`));
    }
  });

  it("every lab rule references an existing, active lab and a real category", () => {
    const labIds = new Set(LAB_CATALOG.map((l) => l.id));
    const categoryIds = new Set(QUESTIONNAIRE.categories.map((c) => c.id));
    for (const r of LAB_RULES.rules) {
      expect(labIds.has(r.labId), `rule lab ${r.labId}`).toBe(true);
      expect(categoryIds.has(r.categoryId), `rule category ${r.categoryId}`).toBe(true);
    }
    const covered = new Set(LAB_RULES.rules.map((r) => r.categoryId));
    for (const id of categoryIds) expect(covered.has(id), `category ${id} uncovered`).toBe(true);
  });

  it("no order link is marked reviewed (all carried links await practitioner review)", () => {
    for (const lab of LAB_CATALOG) {
      expect(
        lab.orderLink.reviewStatus === "unreviewed" || lab.orderLink.reviewStatus === "not_applicable",
      ).toBe(true);
    }
  });
});

describe("supplement approval gate (desktop)", () => {
  it("authoritative list not found ⇒ every product pending_verification, zero approved", () => {
    expect(SUPPLEMENT_REGISTRY.authoritativeListStatus).toBe("not_found");
    expect(SUPPLEMENT_REGISTRY.products).toHaveLength(15);
    for (const p of SUPPLEMENT_REGISTRY.products) {
      expect(p.approvalState).toBe("pending_verification");
    }
    expect(listApprovedProducts()).toEqual([]);
    expect(listDraftableProducts()).toHaveLength(15);
  });

  it("resolves known product names; rejects invented ones", () => {
    expect(resolveProductByName("GlucoPrime")?.id).toBe("prod_glucoprime");
    expect(resolveProductByName("ProOmega 2000 Nordic Naturals")?.id).toBe("prod_proomega_2000");
    expect(resolveProductByName("Miracle Detox Ultra")).toBeNull();
  });

  it("partitions invented product IDs out", () => {
    const r = partitionKnownProductIds(["prod_glucoprime", "prod_fake_x", "prod_gut_shield"]);
    expect(r.known).toEqual(["prod_glucoprime", "prod_gut_shield"]);
    expect(r.unknown).toEqual(["prod_fake_x"]);
  });

  it("protocol templates reference registry product IDs only", () => {
    for (const t of PROTOCOL_TEMPLATES) {
      const { unknown } = partitionKnownProductIds(t.items.map((i) => i.supplementId));
      expect(unknown).toEqual([]);
    }
  });
});

type FixtureCase = {
  name: string;
  answers: SubmittedAnswer[];
  expected?: Record<
    string,
    { percent: number | null; rounded: number | null; band: string; answered: number; completeness: number }
  >;
  expectedLegacyV1?: Record<string, number>;
  expectedElevated?: string[];
  expectedModerateOrHigher?: string[];
  expectedRecommendedLabIds?: string[];
  expectedUnknownQuestionIds?: string[];
  expectedGutZoomerSourceCategories?: string[];
};

describe("scoring.v2 golden fixtures (shared with mobile — identical assertions)", () => {
  const cases = (goldenFixtures as unknown as { cases: FixtureCase[] }).cases;

  it("has the boundary + partial-answer cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const c of cases) {
    it(c.name, () => {
      const result = scoreSubmission(c.answers);
      expect(result.scoringVersion).toBe("scoring.v2");
      expect(result.questionnaireVersion).toBe("q.v1");

      for (const [categoryId, exp] of Object.entries(c.expected ?? {})) {
        const cat = result.categories.find((x) => x.categoryId === categoryId);
        expect(cat, categoryId).toBeTruthy();
        expect(cat!.band).toBe(exp.band);
        expect(cat!.answered).toBe(exp.answered);
        expect(cat!.completeness).toBeCloseTo(exp.completeness, 10);
        if (exp.percent === null) expect(cat!.percent).toBeNull();
        else expect(cat!.percent).toBeCloseTo(exp.percent, 10);
        expect(cat!.rounded).toBe(exp.rounded);
      }
      if (c.expectedElevated) expect(result.elevatedCategoryIds).toEqual(c.expectedElevated);
      if (c.expectedModerateOrHigher) {
        expect(result.moderateOrHigherCategoryIds).toEqual(c.expectedModerateOrHigher);
      }
      if (c.expectedUnknownQuestionIds) {
        expect(result.unknownQuestionIds).toEqual(c.expectedUnknownQuestionIds);
      }
      if (c.expectedRecommendedLabIds) {
        const labs = recommendLabs(result);
        expect(labs.recommendations.map((r) => r.labId).sort()).toEqual(
          [...c.expectedRecommendedLabIds].sort(),
        );
      }
      if (c.expectedGutZoomerSourceCategories) {
        const gz = recommendLabs(result).recommendations.find((r) => r.labId === "lab_gut_zoomer");
        expect(gz?.sourceCategoryIds.sort()).toEqual(
          [...c.expectedGutZoomerSourceCategories].sort(),
        );
      }
      for (const [categoryId, legacyExpected] of Object.entries(c.expectedLegacyV1 ?? {})) {
        const legacy = legacyScoreV1(c.answers).find((x) => x.categoryId === categoryId);
        expect(legacy?.percentage).toBe(legacyExpected);
      }
    });
  }

  it("never scores an unanswered question as zero (v2 vs legacy demonstration)", () => {
    const answers: SubmittedAnswer[] = [
      { questionId: "mold_1", value: 4 },
      { questionId: "mold_2", value: 4 },
      { questionId: "mold_3", value: 4 },
      { questionId: "mold_4", value: 4 },
      { questionId: "mold_5", value: 4 },
      { questionId: "mold_6", value: 4 },
    ];
    const v2 = scoreSubmission(answers).categories.find((x) => x.categoryId === "mold")!;
    expect(v2.percent).toBe(100);
    expect(v2.completeness).toBeCloseTo(0.6, 10);
    const v1 = legacyScoreV1(answers).find((x) => x.categoryId === "mold")!;
    expect(v1.percentage).toBe(60);
  });
});
