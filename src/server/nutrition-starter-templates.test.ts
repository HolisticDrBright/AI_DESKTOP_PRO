import { describe, expect, it } from "vitest";
import {
  STARTER_TEMPLATES,
  getStarterTemplate,
  starterContentHash,
} from "./nutrition-starter-templates";

/**
 * These are the claims the starter library makes about itself. They are the
 * kind of thing that stays true right up until someone adds a ninth template in
 * a hurry, so they are asserted rather than trusted.
 */
describe("the starter diet template library", () => {
  it("ships the eight patterns the phase specifies, each with a distinct slug", () => {
    expect(STARTER_TEMPLATES).toHaveLength(8);
    const slugs = STARTER_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(8);
    expect(new Set(STARTER_TEMPLATES.map((t) => t.pattern)).size).toBe(8);
  });

  it("requires practitioner review on every template, without exception", () => {
    for (const template of STARTER_TEMPLATES) {
      expect(template.meta.requiresPractitionerReview, template.slug).toBe(true);
    }
  });

  it("never claims a governed reference, because none is loaded in this build", () => {
    for (const template of STARTER_TEMPLATES) {
      // The database enforces this too: a deferred constraint trigger refuses
      // `governed_reference` without a real reference row. This test catches it
      // at the source, before an install attempt fails at commit.
      expect(template.meta.evidenceGrade, template.slug).not.toBe("governed_reference");
      expect(template.meta.evidenceSummary, template.slug).toMatch(/no governed/i);
    }
  });

  it("states what it does not know — an empty unknowns list would be the dishonest answer", () => {
    for (const template of STARTER_TEMPLATES) {
      expect(template.meta.missingInformationRequired.length, template.slug).toBeGreaterThan(3);
      expect(template.meta.cautionPopulations.length, template.slug).toBeGreaterThan(0);
      expect(template.meta.prerequisites.length, template.slug).toBeGreaterThan(0);
      expect(template.meta.educationVsAdviceNote, template.slug).toMatch(
        /not individualised medical advice/i,
      );
    }
  });

  it("gives every conditional rule the condition it is conditional on", () => {
    // Not a style preference: the database check constraint rejects a
    // `conditional` rule with no condition_note, so a missing one would fail
    // the install rather than install something ambiguous.
    for (const template of STARTER_TEMPLATES) {
      for (const rule of template.content.foodRules) {
        if (rule.disposition === "conditional") {
          expect(rule.conditionNote, `${template.slug}: ${rule.label}`).toBeTruthy();
        }
      }
    }
  });

  it("carries content the publish gate will accept", () => {
    // `publish_nutrition_template_version` refuses a version with neither food
    // guidance nor a meal plan.
    for (const template of STARTER_TEMPLATES) {
      const { foodRules, mealDays } = template.content;
      expect(foodRules.length + mealDays.length, template.slug).toBeGreaterThan(0);
    }
  });

  it("points every phased rule and day at a phase that exists", () => {
    for (const template of STARTER_TEMPLATES) {
      const numbers = new Set(template.content.phases.map((p) => p.phaseNumber));
      for (const rule of template.content.foodRules) {
        if (rule.phaseNumber !== undefined) {
          expect(numbers.has(rule.phaseNumber), `${template.slug}: ${rule.label}`).toBe(true);
        }
      }
      for (const day of template.content.mealDays) {
        if (day.phaseNumber !== undefined) {
          expect(numbers.has(day.phaseNumber), `${template.slug} day ${day.dayNumber}`).toBe(true);
        }
      }
    }
  });

  it("keeps energy and macro numbers off the sample days", () => {
    // A number on a generic day reads as a target calculated for someone.
    // Targets belong on a patient's plan, set by the practitioner.
    const serialised = JSON.stringify(STARTER_TEMPLATES.map((t) => t.content.mealDays));
    expect(serialised).not.toMatch(/kcal|kJ|"proteinG"|"energyValue"/);
  });

  it("hashes deterministically, distinctly, and independently of key order", () => {
    const hashes = STARTER_TEMPLATES.map(starterContentHash);
    expect(new Set(hashes).size).toBe(8);
    // Same input twice is the same hash — this is what makes a re-install a
    // no-op instead of a gratuitous v2.
    expect(STARTER_TEMPLATES.map(starterContentHash)).toEqual(hashes);

    const first = STARTER_TEMPLATES[0];
    const reordered = {
      ...first,
      meta: Object.fromEntries(
        Object.entries(first.meta).reverse(),
      ) as typeof first.meta,
    };
    expect(starterContentHash(reordered)).toBe(starterContentHash(first));
  });

  it("looks templates up by slug and reports a miss honestly", () => {
    expect(getStarterTemplate("low-fodmap")?.pattern).toBe("low_fodmap");
    expect(getStarterTemplate("not-a-template")).toBeUndefined();
  });
});
