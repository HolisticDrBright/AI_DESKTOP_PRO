if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { createHash } from "node:crypto";

/**
 * The starter diet template library (server-only).
 *
 * Eight dietary patterns a practice can install into its own template library
 * and then edit. Everything here is written for this product; none of it is
 * transcribed from a commercial handout, a published patient guide, or any
 * other copyrighted source.
 *
 * THREE RULES SHAPE EVERY ENTRY.
 *
 * 1. A template is EDUCATIONAL SCAFFOLDING, not a patient's plan. Each one
 *    installs with `requiresPractitionerReview: true`, and the install RPC
 *    refuses one that says otherwise. A patient plan is what you get after a
 *    practitioner personalises this against a real chart and approves it.
 *
 * 2. Nothing here is called evidence-based. This build carries no governed
 *    nutrition reference set, so every template is graded
 *    `practitioner_experience` and says so in its own words. The database
 *    agrees: a deferred constraint trigger refuses `governed_reference` unless
 *    a real reference row backs it, so the claim cannot be made by editing a
 *    string.
 *
 * 3. Each template states what it does NOT know — `missingInformationRequired`
 *    is the list a practitioner has to fill in before this is safe for anyone
 *    in particular. An empty list would be the dishonest answer.
 *
 * Sample days are ILLUSTRATIVE. They carry no energy or macro numbers, because
 * a number attached to a generic day would look like a target that had been
 * calculated for someone. Targets belong on the patient's plan, where a
 * practitioner sets them.
 */

export type Disposition = "emphasize" | "include" | "limit" | "avoid" | "conditional";

export interface StarterFoodRule {
  phaseNumber?: number;
  disposition: Disposition;
  scope?: "category" | "specific_food";
  label: string;
  portionGuidance?: string;
  frequencyGuidance?: string;
  preparationGuidance?: string;
  substitutions?: string[];
  /** Required by the database whenever disposition is `conditional`. */
  conditionNote?: string;
  rationale?: string;
  sortOrder?: number;
}

export interface StarterPhase {
  phaseNumber: number;
  name: string;
  description?: string;
  timingMode?: "relative" | "absolute";
  relativeStartDay?: number;
  relativeDurationDays?: number;
  reintroductionGuidance?: string;
}

export interface StarterMealItem {
  label: string;
  preparationNote?: string;
  substitutions?: string[];
  sortOrder?: number;
}

export interface StarterMeal {
  mealType: "breakfast" | "lunch" | "dinner" | "snack" | "meal" | "beverage";
  name?: string;
  notes?: string;
  sortOrder?: number;
  items: StarterMealItem[];
}

export interface StarterMealDay {
  phaseNumber?: number;
  dayNumber: number;
  label?: string;
  notes?: string;
  meals: StarterMeal[];
}

export interface StarterRecipe {
  name: string;
  servings?: number;
  ingredients: string[];
  method?: string;
  notes?: string;
  sortOrder?: number;
}

export interface StarterGroceryItem {
  category: string;
  label: string;
  quantityNote?: string;
  sortOrder?: number;
}

export interface StarterMeta {
  purpose: string;
  intendedUse: string;
  patientEducation: string;
  educationVsAdviceNote: string;
  cautionPopulations: string[];
  prerequisites: string[];
  missingInformationRequired: string[];
  evidenceGrade: "practitioner_experience" | "none";
  evidenceSummary: string;
  requiresPractitionerReview: true;
}

export interface StarterTemplate {
  slug: string;
  name: string;
  pattern: string;
  summary: string;
  meta: StarterMeta;
  content: {
    phases: StarterPhase[];
    foodRules: StarterFoodRule[];
    mealDays: StarterMealDay[];
    recipes: StarterRecipe[];
    groceryItems: StarterGroceryItem[];
  };
}

/** The sentence every template repeats, because it is the important one. */
const EDUCATION_VS_ADVICE =
  "This is educational scaffolding, not individualised medical advice. It becomes " +
  "advice only when a practitioner personalises it against this patient's chart, " +
  "resolves the safety review, and approves the resulting plan.";

const NO_GOVERNED_REFERENCE =
  "Graded practitioner_experience. This build carries no governed nutrition " +
  "reference set, so no claim here is backed by a citation and none should be " +
  "presented to a patient as evidence-based. Attach governed references and " +
  "re-grade the version if your practice loads them.";

/** Asked of every template, because none of them can answer it alone. */
const UNIVERSAL_UNKNOWNS = [
  "Recorded allergies and intolerances",
  "Current medications and supplements",
  "Pregnancy, lactation or plans to conceive",
  "Kidney and liver function",
  "Any history of disordered eating",
  "Budget, cooking ability, equipment and food access",
];

export const STARTER_TEMPLATES: StarterTemplate[] = [
  /* ------------------------------------------------------- low FODMAP */
  {
    slug: "low-fodmap",
    name: "Low FODMAP — structured elimination and reintroduction",
    pattern: "low_fodmap",
    summary:
      "A time-limited reduction of fermentable carbohydrates, followed by " +
      "systematic reintroduction to find the individual's own triggers.",
    meta: {
      purpose:
        "To reduce fermentable carbohydrate load for a defined period, then " +
        "reintroduce each group one at a time so the patient learns which " +
        "groups they actually react to and at what quantity.",
      intendedUse:
        "Digestive symptom investigation in adults, under practitioner " +
        "supervision, with a planned end date. The elimination phase is a " +
        "diagnostic instrument, not a destination.",
      patientEducation:
        "The restrictive phase is temporary and deliberately short. Its job is " +
        "to quiet symptoms enough that reintroduction gives a clear answer. " +
        "Staying in elimination indefinitely narrows the diet without " +
        "producing any further information, and it is the most common way this " +
        "approach goes wrong.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Any history of restrictive eating or disordered eating",
        "Underweight or unintended weight loss",
        "Pregnancy and lactation",
        "Children and adolescents",
        "Anyone already eating a narrow range of foods",
      ],
      prerequisites: [
        "Red-flag digestive symptoms investigated rather than assumed",
        "Coeliac disease considered before gluten-containing grains are reduced",
        "A named practitioner responsible for reintroduction",
        "A defined elimination end date agreed at the start",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Baseline symptom pattern and severity",
        "Which foods the patient has already excluded on their own",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary: NO_GOVERNED_REFERENCE,
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Elimination",
          description:
            "Reduce high-fermentable-carbohydrate foods across all groups while " +
            "keeping total intake, protein and variety adequate.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 28,
          reintroductionGuidance:
            "Do not extend beyond the agreed end date without a clinical reason " +
            "recorded on the plan.",
        },
        {
          phaseNumber: 2,
          name: "Reintroduction",
          description:
            "Reintroduce one group at a time in escalating portions over three " +
            "days, with a washout before the next, keeping the rest of the diet " +
            "unchanged so the test means something.",
          timingMode: "relative",
          relativeStartDay: 29,
          relativeDurationDays: 42,
          reintroductionGuidance:
            "One group at a time. Two at once produces a result you cannot " +
            "attribute. Record portion, timing and symptoms for each challenge.",
        },
        {
          phaseNumber: 3,
          name: "Personalisation",
          description:
            "Rebuild the widest diet the patient's own results allow, excluding " +
            "only what reproducibly caused symptoms at a realistic portion.",
          timingMode: "relative",
          relativeStartDay: 71,
          relativeDurationDays: 30,
        },
      ],
      foodRules: [
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Well-tolerated proteins",
          portionGuidance: "A protein source at each meal.",
          rationale:
            "Protein is not the variable under test, so keeping it steady makes " +
            "the elimination easier to sustain and the result easier to read.",
          sortOrder: 1,
        },
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Lower-fermentable vegetables",
          portionGuidance: "Aim for variety across the week rather than volume in a day.",
          substitutions: ["Rotate colours and families to keep intake varied"],
          sortOrder: 2,
        },
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Lower-fermentable fruits",
          portionGuidance: "Usually one portion at a time rather than several together.",
          rationale: "Portion size, not the fruit itself, is often what determines tolerance.",
          sortOrder: 3,
        },
        {
          phaseNumber: 1,
          disposition: "include",
          label: "Suitable grains and starches",
          portionGuidance: "At most meals, to keep energy intake adequate.",
          sortOrder: 4,
        },
        {
          phaseNumber: 1,
          disposition: "limit",
          label: "Onion and garlic bulbs",
          preparationGuidance:
            "Infused oils carry the flavour without the fermentable fraction, " +
            "which is usually the difference between a workable elimination and " +
            "an abandoned one.",
          substitutions: ["Garlic-infused oil", "Chives", "Green tops of spring onion"],
          sortOrder: 5,
        },
        {
          phaseNumber: 1,
          disposition: "limit",
          label: "Wheat, rye and barley in large portions",
          rationale:
            "Reduced as a fermentable load during elimination. This is not a " +
            "gluten-free diet and is not a test for coeliac disease.",
          sortOrder: 6,
        },
        {
          phaseNumber: 1,
          disposition: "limit",
          label: "Legumes and pulses",
          portionGuidance: "Small portions of well-rinsed tinned pulses are often tolerated.",
          sortOrder: 7,
        },
        {
          phaseNumber: 1,
          disposition: "limit",
          label: "Lactose-containing dairy",
          substitutions: ["Lactose-free milk and yoghurt", "Firm aged cheeses"],
          sortOrder: 8,
        },
        {
          phaseNumber: 1,
          disposition: "limit",
          label: "Polyol sweeteners and sugar alcohols",
          rationale: "Frequently overlooked because they appear in gums, mints and medicines.",
          sortOrder: 9,
        },
        {
          phaseNumber: 1,
          disposition: "conditional",
          label: "Coffee and alcohol",
          conditionNote:
            "Only restrict if the patient's own record links them to symptoms; " +
            "they are not fermentable carbohydrates and restricting them by " +
            "default just makes the diet harder for no diagnostic gain.",
          sortOrder: 10,
        },
        {
          phaseNumber: 2,
          disposition: "conditional",
          label: "Single-group challenge food",
          conditionNote:
            "One group per challenge window, in escalating portions, with the " +
            "rest of the diet held constant.",
          frequencyGuidance: "Three days of challenge, then a washout before the next group.",
          sortOrder: 11,
        },
        {
          phaseNumber: 3,
          disposition: "emphasize",
          label: "Every group the patient tolerated",
          rationale:
            "The end state should be the widest diet the results support. " +
            "Restriction that the challenges did not justify is a cost with no " +
            "corresponding benefit.",
          sortOrder: 12,
        },
      ],
      mealDays: [
        {
          phaseNumber: 1,
          dayNumber: 1,
          label: "Illustrative elimination day",
          notes:
            "Portions are deliberately absent. A practitioner sets amounts on the " +
            "patient's plan, where the targets have actually been calculated.",
          meals: [
            {
              mealType: "breakfast",
              name: "Oats with lactose-free yoghurt",
              sortOrder: 1,
              items: [
                { label: "Rolled oats", sortOrder: 1 },
                { label: "Lactose-free natural yoghurt", sortOrder: 2 },
                { label: "Blueberries", sortOrder: 3 },
                { label: "Pumpkin seeds", sortOrder: 4 },
              ],
            },
            {
              mealType: "lunch",
              name: "Rice bowl with chicken and courgette",
              sortOrder: 2,
              items: [
                { label: "Cooked white or brown rice", sortOrder: 1 },
                { label: "Grilled chicken thigh", sortOrder: 2 },
                { label: "Courgette", preparationNote: "Sautéed in garlic-infused oil", sortOrder: 3 },
                { label: "Carrot", preparationNote: "Grated raw", sortOrder: 4 },
              ],
            },
            {
              mealType: "dinner",
              name: "Baked salmon with potatoes and green beans",
              sortOrder: 3,
              items: [
                { label: "Salmon fillet", sortOrder: 1 },
                { label: "Potatoes", preparationNote: "Roasted with herbs", sortOrder: 2 },
                { label: "Green beans", sortOrder: 3 },
                { label: "Olive oil and lemon", sortOrder: 4 },
              ],
            },
            {
              mealType: "snack",
              name: "Afternoon",
              sortOrder: 4,
              items: [
                { label: "Rice cakes", sortOrder: 1 },
                { label: "Peanut butter", sortOrder: 2 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "Garlic-infused oil",
          servings: 12,
          ingredients: ["Olive oil", "Whole peeled garlic cloves"],
          method:
            "Warm the oil gently with the cloves until fragrant, then remove and " +
            "discard every piece of garlic before storing. The flavour is " +
            "oil-soluble; the fermentable fraction is not, so what stays behind " +
            "in the oil is the part you wanted.",
          notes:
            "Refrigerate and use within a week. Home-infused oils carry a botulism " +
            "risk if stored at room temperature — this is a food-safety point, not " +
            "a digestive one.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Protein", label: "Chicken, fish, eggs, firm tofu", sortOrder: 1 },
        { category: "Grains", label: "Rice, oats, suitable breads", sortOrder: 2 },
        { category: "Vegetables", label: "Carrot, courgette, green beans, spinach", sortOrder: 3 },
        { category: "Fruit", label: "Blueberries, strawberries, kiwi, orange", sortOrder: 4 },
        { category: "Dairy", label: "Lactose-free milk and yoghurt, aged cheese", sortOrder: 5 },
        { category: "Store cupboard", label: "Olive oil, garlic-infused oil, herbs", sortOrder: 6 },
      ],
    },
  },

  /* ------------------------------------------------------------- AIP */
  {
    slug: "autoimmune-elimination",
    name: "Autoimmune elimination (AIP-style)",
    pattern: "aip",
    summary:
      "A broad, time-limited elimination used to investigate food-related " +
      "symptom patterns in autoimmune conditions, with structured reintroduction.",
    meta: {
      purpose:
        "To remove a wide set of commonly-implicated foods for a defined period " +
        "and then reintroduce them systematically, so that any food-related " +
        "component of the patient's symptoms can be identified rather than guessed at.",
      intendedUse:
        "Adults with an established autoimmune diagnosis, alongside — never " +
        "instead of — their medical care, with a planned reintroduction schedule " +
        "agreed before the elimination starts.",
      patientEducation:
        "This is one of the most restrictive patterns in the library, and that " +
        "restriction is the whole cost of it. It is worth paying only if " +
        "reintroduction actually happens. Nutrient adequacy needs active " +
        "attention throughout, and the diet does not replace any prescribed " +
        "treatment.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Any history of restrictive eating or disordered eating",
        "Underweight or unintended weight loss",
        "Pregnancy and lactation",
        "Children and adolescents",
        "Anyone with limited food budget or access, for whom this is often unachievable",
      ],
      prerequisites: [
        "An established autoimmune diagnosis and ongoing medical care",
        "A named practitioner responsible for reintroduction",
        "A nutrient adequacy plan, particularly calcium and fibre",
        "Agreement that prescribed treatment continues unchanged",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Current disease activity and treatment plan",
        "Baseline weight trend",
        "Prior elimination attempts and what came of them",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary: NO_GOVERNED_REFERENCE,
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Elimination",
          description:
            "Remove the excluded groups while deliberately maximising variety " +
            "within what remains.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 30,
          reintroductionGuidance:
            "If there is no symptom change at all by the end of this phase, that " +
            "is a result: reintroduce and stop, rather than extending.",
        },
        {
          phaseNumber: 2,
          name: "Staged reintroduction",
          description:
            "Reintroduce groups one at a time, generally least-implicated first, " +
            "with several days between challenges.",
          timingMode: "relative",
          relativeStartDay: 31,
          relativeDurationDays: 60,
          reintroductionGuidance:
            "Record each challenge with its date, portion and outcome. A food " +
            "that produced no symptoms comes back into the diet permanently.",
        },
        {
          phaseNumber: 3,
          name: "Maintenance",
          description:
            "The widest sustainable diet consistent with the reintroduction results.",
          timingMode: "relative",
          relativeStartDay: 91,
          relativeDurationDays: 90,
        },
      ],
      foodRules: [
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Vegetables other than nightshades",
          portionGuidance: "The largest component of most plates.",
          rationale: "Variety carries the micronutrient load that the excluded groups used to.",
          sortOrder: 1,
        },
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Fish and shellfish",
          frequencyGuidance: "Several times a week where budget and access allow.",
          sortOrder: 2,
        },
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Well-tolerated meats and poultry",
          sortOrder: 3,
        },
        {
          phaseNumber: 1,
          disposition: "include",
          label: "Root vegetables and starchy tubers",
          rationale:
            "Energy has to come from somewhere once grains and legumes are out; " +
            "this is where it usually comes from.",
          sortOrder: 4,
        },
        { phaseNumber: 1, disposition: "include", label: "Fruit", sortOrder: 5 },
        { phaseNumber: 1, disposition: "avoid", label: "Grains and pseudo-grains", sortOrder: 6 },
        { phaseNumber: 1, disposition: "avoid", label: "Legumes and pulses", sortOrder: 7 },
        { phaseNumber: 1, disposition: "avoid", label: "Dairy", sortOrder: 8 },
        { phaseNumber: 1, disposition: "avoid", label: "Eggs", sortOrder: 9 },
        {
          phaseNumber: 1,
          disposition: "avoid",
          label: "Nightshade vegetables",
          rationale: "Includes the paprika and chilli in most spice blends, which is easy to miss.",
          sortOrder: 10,
        },
        { phaseNumber: 1, disposition: "avoid", label: "Nuts and seeds", sortOrder: 11 },
        {
          phaseNumber: 1,
          disposition: "conditional",
          label: "Coffee",
          conditionNote:
            "Excluded in the strictest interpretations. Keep it if the patient's " +
            "own history does not implicate it — an unnecessary exclusion is a " +
            "real cost against no benefit.",
          sortOrder: 12,
        },
        {
          phaseNumber: 2,
          disposition: "conditional",
          label: "Single reintroduction food",
          conditionNote: "One group per challenge window, several days apart.",
          sortOrder: 13,
        },
      ],
      mealDays: [
        {
          phaseNumber: 1,
          dayNumber: 1,
          label: "Illustrative elimination day",
          meals: [
            {
              mealType: "breakfast",
              name: "Savoury breakfast bowl",
              sortOrder: 1,
              items: [
                { label: "Roasted sweet potato", sortOrder: 1 },
                { label: "Sautéed greens", sortOrder: 2 },
                { label: "Smoked salmon", sortOrder: 3 },
                { label: "Avocado", sortOrder: 4 },
              ],
            },
            {
              mealType: "lunch",
              name: "Large salad with chicken",
              sortOrder: 2,
              items: [
                { label: "Mixed leaves, cucumber, carrot, beetroot", sortOrder: 1 },
                { label: "Roast chicken", sortOrder: 2 },
                { label: "Olive oil and lemon dressing", sortOrder: 3 },
              ],
            },
            {
              mealType: "dinner",
              name: "Braised beef with root vegetables",
              sortOrder: 3,
              items: [
                { label: "Slow-braised beef", sortOrder: 1 },
                { label: "Carrot, parsnip and swede", sortOrder: 2 },
                { label: "Steamed broccoli", sortOrder: 3 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "Nightshade-free herb rub",
          servings: 10,
          ingredients: ["Dried oregano", "Dried thyme", "Garlic powder", "Sea salt", "Lemon zest"],
          method:
            "Combine and store airtight. Use anywhere a recipe calls for a spice " +
            "blend — most commercial blends contain paprika, which is the usual " +
            "way a nightshade gets back onto the plate unnoticed.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Protein", label: "Fish, shellfish, poultry, red meat", sortOrder: 1 },
        { category: "Vegetables", label: "Leafy greens, brassicas, roots, squash", sortOrder: 2 },
        { category: "Fruit", label: "Berries, apples, citrus, bananas", sortOrder: 3 },
        { category: "Fats", label: "Olive oil, coconut oil, avocado", sortOrder: 4 },
        { category: "Seasoning", label: "Fresh and dried herbs, sea salt", sortOrder: 5 },
      ],
    },
  },

  /* ------------------------------------------------------- GAPS-style */
  {
    slug: "staged-gut-protocol",
    name: "GAPS-style staged gut protocol",
    pattern: "gaps_style",
    summary:
      "A staged reintroduction protocol beginning with easily-digested foods " +
      "and broadening in defined steps. Highly restrictive at the start.",
    meta: {
      purpose:
        "To begin from a narrow set of easily-digested foods and widen in " +
        "defined stages, so that tolerance is rebuilt in an order the " +
        "practitioner can observe and adjust.",
      intendedUse:
        "Adults under close supervision, where a staged approach has been " +
        "clinically justified for this particular patient and the early stages " +
        "will be short.",
      patientEducation:
        "The opening stages are severely restrictive and are not nutritionally " +
        "complete. That is tolerable only because they are brief and supervised. " +
        "If progression stalls, the correct response is to reassess the approach " +
        "with your practitioner, not to sit in an early stage for longer.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Any history of restrictive eating or disordered eating",
        "Underweight, frail or nutritionally depleted patients",
        "Pregnancy and lactation",
        "Children and adolescents",
        "Diabetes or any condition needing steady carbohydrate intake",
      ],
      prerequisites: [
        "An explicit clinical rationale recorded for this patient",
        "Close supervision with scheduled review points",
        "A nutrient adequacy plan and an agreed maximum time in the early stages",
        "Weight and symptom monitoring from the start",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Baseline weight and recent weight trend",
        "Diabetes status and any glucose-lowering treatment",
        "Who is supervising progression, and how often they will review",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary:
        NO_GOVERNED_REFERENCE +
        " This pattern is more restrictive than most in the library and its " +
        "staged structure is a clinical convention rather than a validated " +
        "protocol; treat the caution list as the important part of this template.",
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Stage 1 — broths and soft-cooked foods",
          description:
            "Well-cooked meats and vegetables in broth. Not nutritionally " +
            "complete; intended to be short.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 5,
          reintroductionGuidance:
            "Move on as soon as tolerance allows. Extending this stage is a " +
            "decision that needs a recorded clinical reason.",
        },
        {
          phaseNumber: 2,
          name: "Stage 2 — added fats and egg yolk",
          description: "Broaden fat sources and add egg yolk if tolerated.",
          timingMode: "relative",
          relativeStartDay: 6,
          relativeDurationDays: 7,
        },
        {
          phaseNumber: 3,
          name: "Stage 3 — vegetables and fermented foods",
          description: "Widen vegetables and introduce small amounts of fermented foods.",
          timingMode: "relative",
          relativeStartDay: 13,
          relativeDurationDays: 14,
        },
        {
          phaseNumber: 4,
          name: "Stage 4 — broadening",
          description:
            "Continue widening towards a varied whole-food diet, reintroducing " +
            "grains, legumes and dairy deliberately and one at a time.",
          timingMode: "relative",
          relativeStartDay: 27,
          relativeDurationDays: 60,
          reintroductionGuidance:
            "The destination is a varied diet. A protocol that never reaches " +
            "stage 4 has not worked, whatever the symptoms are doing.",
        },
      ],
      foodRules: [
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Meat and vegetable broths",
          frequencyGuidance: "At each meal during the opening stage.",
          sortOrder: 1,
        },
        {
          phaseNumber: 1,
          disposition: "emphasize",
          label: "Well-cooked soft vegetables",
          preparationGuidance: "Cooked until soft; peeled and deseeded at this stage.",
          sortOrder: 2,
        },
        { phaseNumber: 1, disposition: "include", label: "Tender cooked meat and fish", sortOrder: 3 },
        { phaseNumber: 1, disposition: "avoid", label: "Raw vegetables and salads", sortOrder: 4 },
        { phaseNumber: 2, disposition: "include", label: "Egg yolk", sortOrder: 5 },
        { phaseNumber: 2, disposition: "include", label: "Animal fats and olive oil", sortOrder: 6 },
        { phaseNumber: 3, disposition: "include", label: "A wider range of vegetables", sortOrder: 7 },
        {
          phaseNumber: 3,
          disposition: "conditional",
          label: "Fermented vegetables",
          conditionNote:
            "Start with a spoonful and increase only if tolerated; fermented " +
            "foods are frequently the step where symptoms worsen.",
          sortOrder: 8,
        },
        {
          phaseNumber: 4,
          disposition: "conditional",
          label: "Grains, legumes and dairy",
          conditionNote:
            "Reintroduce one at a time with several days between, recording each " +
            "outcome.",
          sortOrder: 9,
        },
        {
          disposition: "limit",
          label: "Added sugars and refined foods",
          rationale: "Consistent across all stages of this pattern.",
          sortOrder: 10,
        },
      ],
      mealDays: [
        {
          phaseNumber: 1,
          dayNumber: 1,
          label: "Illustrative opening-stage day",
          notes:
            "This day is not nutritionally complete and is not intended to be " +
            "repeated for long. Duration is a clinical decision recorded on the " +
            "patient's plan.",
          meals: [
            {
              mealType: "breakfast",
              name: "Broth with soft vegetables",
              sortOrder: 1,
              items: [
                { label: "Meat broth", sortOrder: 1 },
                { label: "Soft-cooked carrot and marrow", sortOrder: 2 },
              ],
            },
            {
              mealType: "lunch",
              name: "Poached chicken in broth",
              sortOrder: 2,
              items: [
                { label: "Poached chicken", sortOrder: 1 },
                { label: "Broth", sortOrder: 2 },
                { label: "Soft-cooked courgette", sortOrder: 3 },
              ],
            },
            {
              mealType: "dinner",
              name: "Fish soup",
              sortOrder: 3,
              items: [
                { label: "White fish", sortOrder: 1 },
                { label: "Broth with soft-cooked vegetables", sortOrder: 2 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "Simple meat broth",
          servings: 8,
          ingredients: ["Bones with some meat attached", "Water", "Carrot", "Onion", "Bay leaf", "Salt"],
          method:
            "Cover the bones with cold water, bring to a bare simmer and hold " +
            "there for several hours. Skim as needed, strain, and cool quickly " +
            "before refrigerating.",
          notes: "Refrigerate up to three days or freeze in portions.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Broth", label: "Bones, stewing meat, whole chicken", sortOrder: 1 },
        { category: "Vegetables", label: "Carrot, marrow, courgette, squash", sortOrder: 2 },
        { category: "Protein", label: "White fish, chicken, eggs (stage 2 onward)", sortOrder: 3 },
        { category: "Fats", label: "Olive oil, ghee, animal fats", sortOrder: 4 },
      ],
    },
  },

  /* -------------------------------------------------------- ketogenic */
  {
    slug: "therapeutic-ketogenic",
    name: "Ketogenic (therapeutic, supervised)",
    pattern: "ketogenic",
    summary:
      "A very-low-carbohydrate, high-fat pattern intended for supervised " +
      "therapeutic use, with explicit medication and monitoring requirements.",
    meta: {
      purpose:
        "To hold carbohydrate low enough to shift the body's predominant fuel " +
        "toward fat and ketones, for a clinical indication that has been " +
        "recorded for this patient.",
      intendedUse:
        "Supervised therapeutic use in adults, with medication review BEFORE " +
        "starting and monitoring arranged in advance.",
      patientEducation:
        "The medication interaction is the part that matters most. If you take " +
        "insulin, a sulfonylurea, or a medicine for blood pressure, the dose that " +
        "was right last week may be too high within days of starting — that is " +
        "the diet working, and it is exactly why the prescriber has to be " +
        "involved before you begin, not after something goes wrong.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Type 1 diabetes, and type 2 diabetes on insulin or sulfonylureas",
        "Taking SGLT2 inhibitors — risk of euglycaemic ketoacidosis",
        "Pregnancy and lactation",
        "Kidney or liver impairment",
        "History of pancreatitis or a disorder of fat metabolism",
        "History of disordered eating",
        "Children and adolescents outside a specialist service",
      ],
      prerequisites: [
        "Recorded clinical indication for this patient",
        "Medication review with the prescriber BEFORE the first day",
        "An agreed monitoring plan, including glucose where relevant",
        "Baseline kidney and liver function",
        "An agreed review point and a plan for stopping",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Diabetes status and every glucose-lowering medicine with its dose",
        "Blood pressure medication and current readings",
        "Baseline lipids, kidney and liver function",
        "Who is adjusting medication doses during the transition",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary:
        NO_GOVERNED_REFERENCE +
        " The medication cautions above are the reason this template exists in " +
        "supervised form only; do not soften them when personalising it.",
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Preparation",
          description:
            "Medication review, baseline bloods, monitoring arranged, and the " +
            "stopping plan agreed. Nothing changes on the plate yet.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 7,
        },
        {
          phaseNumber: 2,
          name: "Adaptation",
          description:
            "Carbohydrate reduced to the agreed level. Expect transient fatigue, " +
            "headache and reduced exercise capacity; attend to fluid and salt.",
          timingMode: "relative",
          relativeStartDay: 8,
          relativeDurationDays: 21,
          reintroductionGuidance:
            "Medication doses often need adjusting during this window. That is " +
            "the prescriber's decision, made against monitoring — not the " +
            "patient's, made against how they feel.",
        },
        {
          phaseNumber: 3,
          name: "Maintenance and review",
          description:
            "Hold the pattern to the agreed review point, then decide " +
            "deliberately whether to continue.",
          timingMode: "relative",
          relativeStartDay: 29,
          relativeDurationDays: 60,
        },
      ],
      foodRules: [
        {
          phaseNumber: 2,
          disposition: "emphasize",
          label: "Non-starchy vegetables",
          portionGuidance: "Generous volume at most meals.",
          rationale:
            "The commonest deficiencies on this pattern are fibre and potassium, " +
            "and this is where both come from.",
          sortOrder: 1,
        },
        {
          phaseNumber: 2,
          disposition: "emphasize",
          label: "Fish, eggs, poultry and meat",
          portionGuidance: "Adequate but not unlimited; protein is not the variable being pushed.",
          sortOrder: 2,
        },
        {
          phaseNumber: 2,
          disposition: "emphasize",
          label: "Olive oil, avocado, nuts and seeds",
          sortOrder: 3,
        },
        {
          phaseNumber: 2,
          disposition: "include",
          label: "Low-sugar fruits in small portions",
          portionGuidance: "Berries, in an amount that fits the carbohydrate ceiling.",
          sortOrder: 4,
        },
        { phaseNumber: 2, disposition: "avoid", label: "Grains and grain products", sortOrder: 5 },
        { phaseNumber: 2, disposition: "avoid", label: "Sugars, syrups and sweetened drinks", sortOrder: 6 },
        { phaseNumber: 2, disposition: "avoid", label: "Starchy vegetables and most legumes", sortOrder: 7 },
        { phaseNumber: 2, disposition: "avoid", label: "Most fruit other than berries", sortOrder: 8 },
        {
          phaseNumber: 2,
          disposition: "conditional",
          label: "Added salt and fluids",
          conditionNote:
            "Usually INCREASED during adaptation to offset early fluid and sodium " +
            "loss — unless blood pressure, heart failure or kidney disease makes " +
            "that inappropriate, in which case the prescriber decides.",
          sortOrder: 9,
        },
        {
          disposition: "conditional",
          label: "Alcohol",
          conditionNote:
            "Increases hypoglycaemia risk for anyone on glucose-lowering " +
            "medication; agree with the prescriber before including it.",
          sortOrder: 10,
        },
      ],
      mealDays: [
        {
          phaseNumber: 2,
          dayNumber: 1,
          label: "Illustrative adaptation-phase day",
          notes:
            "No energy or macro figures appear here on purpose. The carbohydrate " +
            "ceiling and the protein target are set on the patient's plan by the " +
            "practitioner who calculated them.",
          meals: [
            {
              mealType: "breakfast",
              name: "Eggs with spinach",
              sortOrder: 1,
              items: [
                { label: "Eggs", preparationNote: "Cooked in olive oil or butter", sortOrder: 1 },
                { label: "Spinach", sortOrder: 2 },
                { label: "Avocado", sortOrder: 3 },
              ],
            },
            {
              mealType: "lunch",
              name: "Salad with mackerel",
              sortOrder: 2,
              items: [
                { label: "Mixed leaves, cucumber, celery", sortOrder: 1 },
                { label: "Tinned mackerel", sortOrder: 2 },
                { label: "Olive oil and vinegar", sortOrder: 3 },
                { label: "Pumpkin seeds", sortOrder: 4 },
              ],
            },
            {
              mealType: "dinner",
              name: "Chicken thighs with roasted vegetables",
              sortOrder: 3,
              items: [
                { label: "Chicken thighs", sortOrder: 1 },
                { label: "Courgette, aubergine and peppers", preparationNote: "Roasted in olive oil", sortOrder: 2 },
                { label: "Green salad", sortOrder: 3 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "Olive oil and herb dressing",
          servings: 8,
          ingredients: ["Olive oil", "Red wine vinegar", "Dijon mustard", "Dried oregano", "Salt and pepper"],
          method: "Shake together in a jar and keep refrigerated.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Protein", label: "Eggs, oily fish, chicken, beef", sortOrder: 1 },
        { category: "Vegetables", label: "Leafy greens, courgette, cauliflower, peppers", sortOrder: 2 },
        { category: "Fats", label: "Olive oil, butter, avocado, nuts, seeds", sortOrder: 3 },
        { category: "Fruit", label: "Berries in small portions", sortOrder: 4 },
      ],
    },
  },

  /* ---------------------------------------------------- Mediterranean */
  {
    slug: "mediterranean-pattern",
    name: "Mediterranean pattern",
    pattern: "mediterranean",
    summary:
      "A broad, unrestrictive whole-food pattern built on vegetables, legumes, " +
      "olive oil, fish and whole grains. The least restrictive template here.",
    meta: {
      purpose:
        "To shift the overall shape of the diet toward vegetables, legumes, " +
        "whole grains, fish and olive oil, without excluding food groups.",
      intendedUse:
        "General dietary improvement for adults, and a sensible destination for " +
        "patients coming off a restrictive pattern.",
      patientEducation:
        "There is nothing to eliminate here. The change is in proportions: more " +
        "plants, more legumes, fish more often, olive oil as the main fat, and " +
        "less in the way of processed meat and refined sugar. Because nothing is " +
        "forbidden, this is usually the easiest pattern to keep going.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Anyone on warfarin — a large change in leafy-green intake affects control",
        "Chronic kidney disease, where potassium and protein may need limiting",
        "Fish allergy and shellfish allergy",
      ],
      prerequisites: [
        "Allergies checked, particularly fish and nuts",
        "Anticoagulant therapy identified before greens increase",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Kidney function if potassium or protein needs limiting",
        "Anticoagulant therapy",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary: NO_GOVERNED_REFERENCE,
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Establish",
          description:
            "Change proportions gradually rather than rebuilding every meal at once.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 28,
        },
        {
          phaseNumber: 2,
          name: "Sustain",
          description: "Hold the pattern and widen variety within it.",
          timingMode: "relative",
          relativeStartDay: 29,
          relativeDurationDays: 90,
        },
      ],
      foodRules: [
        {
          disposition: "emphasize",
          label: "Vegetables",
          portionGuidance: "At lunch and dinner, aiming for several colours across the day.",
          sortOrder: 1,
        },
        {
          disposition: "emphasize",
          label: "Legumes and pulses",
          frequencyGuidance: "Several times a week.",
          rationale: "The single change that most reliably shifts fibre intake.",
          sortOrder: 2,
        },
        { disposition: "emphasize", label: "Extra virgin olive oil", portionGuidance: "The main added fat.", sortOrder: 3 },
        { disposition: "emphasize", label: "Fish, including oily fish", frequencyGuidance: "Twice a week or more.", sortOrder: 4 },
        { disposition: "emphasize", label: "Whole grains", sortOrder: 5 },
        { disposition: "include", label: "Nuts and seeds", portionGuidance: "A small handful most days.", sortOrder: 6 },
        { disposition: "include", label: "Fruit", frequencyGuidance: "Daily, as the usual sweet option.", sortOrder: 7 },
        { disposition: "include", label: "Yoghurt and cheese", portionGuidance: "Moderate amounts.", sortOrder: 8 },
        { disposition: "include", label: "Poultry and eggs", frequencyGuidance: "Moderately.", sortOrder: 9 },
        { disposition: "limit", label: "Red meat", frequencyGuidance: "Occasional rather than routine.", sortOrder: 10 },
        { disposition: "limit", label: "Processed meat", sortOrder: 11 },
        { disposition: "limit", label: "Refined grains, sugary foods and sweetened drinks", sortOrder: 12 },
        {
          disposition: "conditional",
          label: "Wine with meals",
          conditionNote:
            "Traditional to the pattern but not a recommendation. Do not suggest " +
            "alcohol to anyone who does not already drink, and omit it entirely " +
            "where medication, pregnancy or history make it inappropriate.",
          sortOrder: 13,
        },
      ],
      mealDays: [
        {
          phaseNumber: 1,
          dayNumber: 1,
          label: "Illustrative day",
          meals: [
            {
              mealType: "breakfast",
              name: "Yoghurt with fruit and nuts",
              sortOrder: 1,
              items: [
                { label: "Natural yoghurt", sortOrder: 1 },
                { label: "Seasonal fruit", sortOrder: 2 },
                { label: "Walnuts", sortOrder: 3 },
                { label: "Wholegrain toast with olive oil", sortOrder: 4 },
              ],
            },
            {
              mealType: "lunch",
              name: "Chickpea and vegetable salad",
              sortOrder: 2,
              items: [
                { label: "Chickpeas", sortOrder: 1 },
                { label: "Tomato, cucumber, red onion, parsley", sortOrder: 2 },
                { label: "Feta", sortOrder: 3 },
                { label: "Olive oil and lemon", sortOrder: 4 },
              ],
            },
            {
              mealType: "dinner",
              name: "Baked fish with vegetables and barley",
              sortOrder: 3,
              items: [
                { label: "White fish or sardines", sortOrder: 1 },
                { label: "Roasted courgette, pepper and fennel", sortOrder: 2 },
                { label: "Pearl barley", sortOrder: 3 },
              ],
            },
            {
              mealType: "snack",
              name: "Afternoon",
              sortOrder: 4,
              items: [
                { label: "Fruit", sortOrder: 1 },
                { label: "A small handful of almonds", sortOrder: 2 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "White bean and tomato braise",
          servings: 4,
          ingredients: [
            "Tinned white beans",
            "Tinned tomatoes",
            "Onion",
            "Garlic",
            "Olive oil",
            "Oregano",
            "Parsley",
          ],
          method:
            "Soften the onion and garlic in olive oil, add tomatoes and oregano " +
            "and simmer until thickened, then fold in the drained beans and warm " +
            "through. Finish with parsley and a further spoonful of olive oil.",
          notes: "Keeps three days refrigerated; good hot or at room temperature.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Vegetables", label: "Tomatoes, courgette, peppers, leafy greens, fennel", sortOrder: 1 },
        { category: "Legumes", label: "Chickpeas, white beans, lentils", sortOrder: 2 },
        { category: "Grains", label: "Wholegrain bread, barley, bulgur", sortOrder: 3 },
        { category: "Protein", label: "Sardines, white fish, eggs, chicken", sortOrder: 4 },
        { category: "Fats", label: "Extra virgin olive oil, walnuts, almonds", sortOrder: 5 },
        { category: "Dairy", label: "Natural yoghurt, feta", sortOrder: 6 },
      ],
    },
  },

  /* ------------------------------------------------- lower carbohydrate */
  {
    slug: "lower-carbohydrate",
    name: "Lower-carbohydrate pattern",
    pattern: "low_carbohydrate",
    summary:
      "A moderate reduction in carbohydrate, less restrictive than ketogenic, " +
      "with the same medication-review requirement.",
    meta: {
      purpose:
        "To reduce carbohydrate — particularly refined carbohydrate — to a " +
        "moderate level the patient can sustain, without the constraints of a " +
        "ketogenic pattern.",
      intendedUse:
        "Adults for whom a moderate carbohydrate reduction has been clinically " +
        "justified, with medication reviewed before starting.",
      patientEducation:
        "This is a proportional change, not an elimination: fruit, legumes and " +
        "some whole grains stay in. If you take medication for diabetes or blood " +
        "pressure, the prescriber still needs to know before you start, because " +
        "doses often need to come down.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Diabetes treated with insulin or sulfonylureas",
        "Taking SGLT2 inhibitors",
        "Pregnancy and lactation",
        "Kidney impairment",
        "History of disordered eating",
      ],
      prerequisites: [
        "Medication review with the prescriber before starting",
        "Glucose monitoring arranged where relevant",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Diabetes status and every glucose-lowering medicine with its dose",
        "Blood pressure medication and current readings",
        "Habitual carbohydrate intake, so the reduction is real and measurable",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary: NO_GOVERNED_REFERENCE,
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Reduce refined carbohydrate",
          description:
            "Remove sugary drinks, confectionery and refined grain products first. " +
            "This is usually most of the benefit for least of the difficulty.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 14,
        },
        {
          phaseNumber: 2,
          name: "Set the working level",
          description:
            "Reduce total carbohydrate to the agreed level and hold it, adjusting " +
            "against monitoring rather than against how a given day felt.",
          timingMode: "relative",
          relativeStartDay: 15,
          relativeDurationDays: 60,
        },
      ],
      foodRules: [
        { disposition: "emphasize", label: "Non-starchy vegetables", portionGuidance: "At most meals.", sortOrder: 1 },
        { disposition: "emphasize", label: "Protein at each meal", rationale: "Steadies appetite through the reduction.", sortOrder: 2 },
        { disposition: "include", label: "Legumes", portionGuidance: "Moderate portions.", sortOrder: 3 },
        { disposition: "include", label: "Whole fruit", portionGuidance: "One or two portions daily.", sortOrder: 4 },
        { disposition: "include", label: "Whole grains", portionGuidance: "Smaller portions than habitual.", sortOrder: 5 },
        { disposition: "include", label: "Nuts, seeds, olive oil", sortOrder: 6 },
        { disposition: "limit", label: "Bread, rice, pasta and potatoes", portionGuidance: "Reduced portions rather than removal.", sortOrder: 7 },
        { disposition: "avoid", label: "Sugary drinks and fruit juice", sortOrder: 8 },
        { disposition: "avoid", label: "Confectionery and sweetened breakfast cereals", sortOrder: 9 },
        {
          disposition: "conditional",
          label: "Alcohol",
          conditionNote:
            "Raises hypoglycaemia risk for anyone on glucose-lowering medication; " +
            "agree with the prescriber.",
          sortOrder: 10,
        },
      ],
      mealDays: [
        {
          phaseNumber: 2,
          dayNumber: 1,
          label: "Illustrative day",
          meals: [
            {
              mealType: "breakfast",
              name: "Eggs and vegetables",
              sortOrder: 1,
              items: [
                { label: "Eggs", sortOrder: 1 },
                { label: "Mushrooms and spinach", sortOrder: 2 },
                { label: "One slice of wholegrain toast", sortOrder: 3 },
              ],
            },
            {
              mealType: "lunch",
              name: "Lentil and vegetable soup with salad",
              sortOrder: 2,
              items: [
                { label: "Lentil soup", sortOrder: 1 },
                { label: "Green salad with olive oil", sortOrder: 2 },
              ],
            },
            {
              mealType: "dinner",
              name: "Chicken with roasted vegetables",
              sortOrder: 3,
              items: [
                { label: "Chicken breast or thigh", sortOrder: 1 },
                { label: "Roasted broccoli, peppers and onion", sortOrder: 2 },
                { label: "A small portion of new potatoes", sortOrder: 3 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "Lentil and vegetable soup",
          servings: 4,
          ingredients: ["Brown or green lentils", "Carrot", "Celery", "Onion", "Stock", "Olive oil", "Bay leaf"],
          method:
            "Soften the vegetables in olive oil, add the rinsed lentils, stock and " +
            "bay, and simmer until the lentils are tender. Season at the end.",
          notes: "Freezes well in portions.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Protein", label: "Eggs, chicken, fish, tofu", sortOrder: 1 },
        { category: "Vegetables", label: "Broccoli, spinach, peppers, mushrooms, salad", sortOrder: 2 },
        { category: "Legumes", label: "Lentils, chickpeas", sortOrder: 3 },
        { category: "Fats", label: "Olive oil, nuts, seeds", sortOrder: 4 },
      ],
    },
  },

  /* --------------------------------------- elimination & reintroduction */
  {
    slug: "elimination-reintroduction",
    name: "Structured elimination and reintroduction",
    pattern: "elimination_reintroduction",
    summary:
      "A general-purpose framework for testing suspected food triggers: remove " +
      "a defined short list, then challenge each one on its own.",
    meta: {
      purpose:
        "To test specific suspected food triggers by removing a short, named " +
        "list for a defined period and then challenging each one separately, so " +
        "the answer is attributable.",
      intendedUse:
        "Adults with a specific suspicion worth testing. The practitioner names " +
        "the foods when personalising; this template supplies the method, not " +
        "the list.",
      patientEducation:
        "The value of this approach comes almost entirely from the challenge " +
        "phase. Removing foods and never testing them produces a narrower diet " +
        "and no new information — which is the worst of both outcomes. Keep the " +
        "list short and the timeline firm.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Any history of restrictive eating or disordered eating",
        "Known IgE-mediated food allergy — a challenge can be dangerous and must not be planned here",
        "Children and adolescents",
        "Pregnancy and lactation",
        "Anyone already eating a narrow range of foods",
      ],
      prerequisites: [
        "IgE-mediated allergy excluded before any challenge is planned",
        "A short, explicitly named exclusion list rather than a general clear-out",
        "A defined elimination end date and a booked challenge schedule",
        "A symptom record the patient will actually keep",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Which specific foods are suspected, and on what basis",
        "Baseline symptom pattern, severity and timing",
        "Any previous reaction severe enough to make a challenge unsafe",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary:
        NO_GOVERNED_REFERENCE +
        " Note particularly that this template must never be used to challenge a " +
        "food involved in a known IgE-mediated allergy.",
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Baseline",
          description:
            "Record symptoms on the usual diet for a week, so there is something " +
            "to compare against.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 7,
        },
        {
          phaseNumber: 2,
          name: "Elimination",
          description:
            "Remove only the named foods. Everything else stays exactly as it was.",
          timingMode: "relative",
          relativeStartDay: 8,
          relativeDurationDays: 21,
          reintroductionGuidance:
            "If symptoms are unchanged at the end of this phase, the suspected " +
            "foods are probably not the cause. Reintroduce them and look elsewhere.",
        },
        {
          phaseNumber: 3,
          name: "Challenge",
          description:
            "Reintroduce one food at a time in increasing portions over three " +
            "days, then wait before the next.",
          timingMode: "relative",
          relativeStartDay: 29,
          relativeDurationDays: 28,
          reintroductionGuidance:
            "A positive challenge should be repeated once before it becomes a " +
            "permanent exclusion. One bad day is not a result.",
        },
      ],
      foodRules: [
        {
          phaseNumber: 2,
          disposition: "conditional",
          label: "The named suspected foods",
          conditionNote:
            "The practitioner lists these on the patient's plan. This template " +
            "deliberately names none, because a generic exclusion list is how a " +
            "targeted test turns into an untargeted restriction.",
          sortOrder: 1,
        },
        {
          phaseNumber: 2,
          disposition: "emphasize",
          label: "Everything else the patient normally eats",
          rationale:
            "Holding the rest of the diet constant is what makes the result " +
            "interpretable.",
          sortOrder: 2,
        },
        {
          phaseNumber: 2,
          disposition: "include",
          label: "A direct substitute for each removed food",
          rationale:
            "Replacing what was removed protects both nutrient intake and the " +
            "patient's willingness to finish the test.",
          sortOrder: 3,
        },
        {
          phaseNumber: 3,
          disposition: "conditional",
          label: "One challenge food at a time",
          conditionNote:
            "Increasing portions across three days, with the rest of the diet " +
            "unchanged and a washout before the next food.",
          sortOrder: 4,
        },
      ],
      mealDays: [
        {
          phaseNumber: 3,
          dayNumber: 1,
          label: "Illustrative challenge day",
          notes:
            "The challenge food goes in at a known portion at a known time. " +
            "Everything else on the day is what the patient was already eating " +
            "during elimination.",
          meals: [
            {
              mealType: "breakfast",
              name: "Usual elimination-phase breakfast",
              notes: "Unchanged from the elimination phase.",
              sortOrder: 1,
              items: [{ label: "As eaten during elimination", sortOrder: 1 }],
            },
            {
              mealType: "lunch",
              name: "Challenge portion",
              notes: "Small measured portion of the single challenge food, recorded with the time.",
              sortOrder: 2,
              items: [
                { label: "Challenge food, small portion", sortOrder: 1 },
                { label: "Usual elimination-phase lunch", sortOrder: 2 },
              ],
            },
            {
              mealType: "dinner",
              name: "Usual elimination-phase dinner",
              sortOrder: 3,
              items: [{ label: "As eaten during elimination", sortOrder: 1 }],
            },
          ],
        },
      ],
      recipes: [],
      groceryItems: [
        { category: "Substitutes", label: "A direct replacement for each excluded food", sortOrder: 1 },
        { category: "Challenge", label: "The single challenge food in a plain, unmixed form", quantityNote: "Plain form only, so the challenge tests one thing", sortOrder: 2 },
      ],
    },
  },

  /* ------------------------------------------------- anti-inflammatory */
  {
    slug: "anti-inflammatory-pattern",
    name: "Anti-inflammatory pattern",
    pattern: "anti_inflammatory",
    summary:
      "A whole-food pattern emphasising oily fish, vegetables, legumes, olive " +
      "oil, herbs and spices, with refined and heavily processed foods reduced.",
    meta: {
      purpose:
        "To shift the overall diet toward whole foods commonly used in this " +
        "context — oily fish, vegetables, legumes, olive oil, herbs and spices — " +
        "while reducing refined and heavily processed foods.",
      intendedUse:
        "General dietary improvement for adults alongside medical care, not as a " +
        "treatment for any named inflammatory condition.",
      patientEducation:
        "The name describes the intent, not a proven effect. This is a varied " +
        "whole-food pattern with nothing excluded, and it does not replace any " +
        "treatment you have been prescribed. If a food you eat often is genuinely " +
        "a problem for you, that is a question for a structured elimination and " +
        "challenge, not for a general pattern like this one.",
      educationVsAdviceNote: EDUCATION_VS_ADVICE,
      cautionPopulations: [
        "Anyone on warfarin — a large change in leafy-green intake affects control",
        "Fish and shellfish allergy",
        "Chronic kidney disease, where potassium and protein may need limiting",
        "Anyone on high-dose fish-oil supplements alongside anticoagulants",
      ],
      prerequisites: [
        "Allergies checked",
        "Anticoagulant therapy identified before greens or fish oil increase",
        "Agreement that this sits alongside, not instead of, medical care",
      ],
      missingInformationRequired: [
        ...UNIVERSAL_UNKNOWNS,
        "Anticoagulant therapy and any fish-oil supplementation",
        "Kidney function if potassium or protein needs limiting",
        "Whether a specific food trigger is suspected — which needs a different template",
      ],
      evidenceGrade: "practitioner_experience",
      evidenceSummary:
        NO_GOVERNED_REFERENCE +
        " The pattern name is conventional shorthand and should not be presented " +
        "to a patient as a demonstrated anti-inflammatory effect.",
      requiresPractitionerReview: true,
    },
    content: {
      phases: [
        {
          phaseNumber: 1,
          name: "Establish",
          description: "Introduce the emphasis foods before worrying about what to reduce.",
          timingMode: "relative",
          relativeStartDay: 1,
          relativeDurationDays: 28,
        },
        {
          phaseNumber: 2,
          name: "Sustain",
          description: "Hold the pattern and widen variety within it.",
          timingMode: "relative",
          relativeStartDay: 29,
          relativeDurationDays: 90,
        },
      ],
      foodRules: [
        { disposition: "emphasize", label: "Oily fish", frequencyGuidance: "Two to three times a week.", sortOrder: 1 },
        { disposition: "emphasize", label: "Leafy greens and brassicas", portionGuidance: "Daily.", sortOrder: 2 },
        { disposition: "emphasize", label: "Berries and other deeply coloured fruit", sortOrder: 3 },
        { disposition: "emphasize", label: "Extra virgin olive oil", portionGuidance: "The main added fat.", sortOrder: 4 },
        { disposition: "emphasize", label: "Herbs and spices", preparationGuidance: "Used generously in ordinary cooking, not taken as supplements.", sortOrder: 5 },
        { disposition: "include", label: "Legumes and pulses", frequencyGuidance: "Several times a week.", sortOrder: 6 },
        { disposition: "include", label: "Nuts and seeds", portionGuidance: "A small handful most days.", sortOrder: 7 },
        { disposition: "include", label: "Whole grains", sortOrder: 8 },
        { disposition: "include", label: "Fermented foods", portionGuidance: "Small amounts, if enjoyed and tolerated.", sortOrder: 9 },
        { disposition: "limit", label: "Processed meat", sortOrder: 10 },
        { disposition: "limit", label: "Refined grains and added sugars", sortOrder: 11 },
        { disposition: "limit", label: "Sweetened drinks", sortOrder: 12 },
        {
          disposition: "conditional",
          label: "High-dose fish-oil supplements",
          conditionNote:
            "Not part of this template. If considered, it needs a separate " +
            "decision — particularly for anyone on an anticoagulant.",
          sortOrder: 13,
        },
      ],
      mealDays: [
        {
          phaseNumber: 1,
          dayNumber: 1,
          label: "Illustrative day",
          meals: [
            {
              mealType: "breakfast",
              name: "Berry and seed porridge",
              sortOrder: 1,
              items: [
                { label: "Oats", sortOrder: 1 },
                { label: "Mixed berries", sortOrder: 2 },
                { label: "Ground flaxseed", sortOrder: 3 },
                { label: "Walnuts", sortOrder: 4 },
              ],
            },
            {
              mealType: "lunch",
              name: "Lentil salad with greens",
              sortOrder: 2,
              items: [
                { label: "Puy lentils", sortOrder: 1 },
                { label: "Rocket and watercress", sortOrder: 2 },
                { label: "Roasted red pepper", sortOrder: 3 },
                { label: "Olive oil, lemon and parsley", sortOrder: 4 },
              ],
            },
            {
              mealType: "dinner",
              name: "Spiced salmon with greens",
              sortOrder: 3,
              items: [
                { label: "Salmon", preparationNote: "Rubbed with turmeric, cumin and black pepper", sortOrder: 1 },
                { label: "Steamed kale and broccoli", sortOrder: 2 },
                { label: "Brown rice", sortOrder: 3 },
              ],
            },
          ],
        },
      ],
      recipes: [
        {
          name: "Everyday spice rub",
          servings: 12,
          ingredients: ["Ground turmeric", "Ground cumin", "Ground coriander", "Black pepper", "Dried thyme"],
          method:
            "Combine and store airtight. Use on fish, poultry or roasted " +
            "vegetables. Black pepper is included because it is traditionally " +
            "paired with turmeric in cooking.",
          sortOrder: 1,
        },
      ],
      groceryItems: [
        { category: "Protein", label: "Salmon, sardines, mackerel, lentils, chickpeas", sortOrder: 1 },
        { category: "Vegetables", label: "Kale, broccoli, rocket, peppers, onions", sortOrder: 2 },
        { category: "Fruit", label: "Berries, cherries, oranges", sortOrder: 3 },
        { category: "Fats", label: "Extra virgin olive oil, walnuts, flaxseed", sortOrder: 4 },
        { category: "Seasoning", label: "Turmeric, ginger, cumin, coriander, herbs", sortOrder: 5 },
      ],
    },
  },
];

/**
 * A stable hash of everything that gets stored, so re-installing an unchanged
 * template is a no-op rather than a new version. Key order is normalised, so a
 * cosmetic reordering of this file does not read as a content change.
 */
export function starterContentHash(template: StarterTemplate): string {
  return createHash("sha256")
    .update(stableStringify({ meta: template.meta, content: template.content }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function getStarterTemplate(slug: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.slug === slug);
}
