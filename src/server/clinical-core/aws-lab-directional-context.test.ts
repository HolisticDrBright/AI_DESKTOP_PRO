import { describe, expect, test } from "vitest";
import { assessLabBiomarker, assessRangeDirection, buildDirectionalLabContext, type DirectionalLabBiomarker } from "./aws-lab-directional-context";

function marker(overrides: Partial<DirectionalLabBiomarker> = {}): DirectionalLabBiomarker {
  return {
    biomarkerId: "11111111-1111-4111-8111-111111111111",
    canonicalName: "Ferritin",
    value: 100,
    unit: "ng/mL",
    labMin: 30,
    labMax: 250,
    functionalMin: 40,
    functionalMax: 150,
    status: "optimal",
    ...overrides,
  };
}

describe("deterministic lab direction and relationship context", () => {
  test.each([
    [10, 20, 40, "below"],
    [30, 20, 40, "within"],
    [50, 20, 40, "above"],
    [50, null, 40, "above"],
    [10, 20, null, "below"],
    [30, null, 40, "unknown"],
    [30, 20, null, "unknown"],
    [30, null, null, "unknown"],
    [30, 40, 20, "unknown"],
  ] as const)("classifies %s against %s–%s as %s", (value, min, max, expected) => {
    expect(assessRangeDirection(value, min, max)).toBe(expected);
  });

  test("keeps reporting and functional directions separate", () => {
    expect(assessLabBiomarker(marker({ value: 35 }))).toEqual({
      reportingDirection: "within",
      functionalDirection: "below",
      primaryDirection: "below",
      primaryBasis: "functional",
      sourceStatusAlignment: "conflicts",
    });
  });

  test.each([
    ["Vitamin D", 120, "above"],
    ["Vitamin B12", 1200, "above"],
    ["Folate", 30, "above"],
    ["Magnesium", 12, "above"],
    ["Zinc", 180, "above"],
  ])("does not reinterpret high %s as low", (canonicalName, value, expected) => {
    expect(assessLabBiomarker(marker({ canonicalName, value, labMin: 1, labMax: 10, functionalMin: 2, functionalMax: 8 })).primaryDirection).toBe(expected);
  });

  test("builds non-diagnostic review-together groups only from measured members", () => {
    const context = buildDirectionalLabContext([
      marker({ canonicalName: "Ferritin", value: 300 }),
      marker({ biomarkerId: "22222222-2222-4222-8222-222222222222", canonicalName: "Serum Iron", value: 190, unit: "mcg/dL", labMin: 50, labMax: 170, functionalMin: null, functionalMax: null, status: "critical" }),
      marker({ biomarkerId: "33333333-3333-4333-8333-333333333333", canonicalName: "TSH", value: 5, unit: "mIU/L", labMin: 0.4, labMax: 4.5, functionalMin: null, functionalMax: null, status: "suboptimal" }),
    ]);
    expect(context.biomarkers[0]?.rangeAssessment.primaryDirection).toBe("above");
    expect(context.relationshipGroups).toEqual([
      expect.objectContaining({
        groupId: "iron_studies",
        biomarkerIds: expect.arrayContaining([
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ]),
        instruction: "review_together_not_a_diagnosis",
      }),
    ]);
  });

  test("does not invent a relationship group from one marker or all-within markers", () => {
    const context = buildDirectionalLabContext([
      marker({ canonicalName: "TSH", value: 2, labMin: 0.4, labMax: 4.5, functionalMin: null, functionalMax: null }),
      marker({ biomarkerId: "22222222-2222-4222-8222-222222222222", canonicalName: "Free T4", value: 1.2, unit: "ng/dL", labMin: 0.8, labMax: 1.8, functionalMin: null, functionalMax: null }),
    ]);
    expect(context.relationshipGroups).toEqual([]);
  });
});
