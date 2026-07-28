"use client";

/**
 * Nutrition behind a TYPED Passio-shaped adapter boundary.
 *
 * `NutritionAdapter` is the contract a real Passio-backed implementation
 * will satisfy SERVER-SIDE (the Passio key never ships in client code —
 * the live adapter will call a backend route, exactly like labs/tRPC).
 * `passioMockAdapter` is the demo implementation: deterministic synthetic
 * entries; capture methods (photo/barcode/voice) simulate parsed results
 * without touching camera, microphone, or network.
 */
import { createSessionStore, newSessionId } from "./session-kv";
import { recordAuditEntry } from "./session-store";

export type CaptureMethod = "photo" | "barcode" | "voice" | "search" | "label" | "manual";

export interface FoodItem {
  name: string;
  qty: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
}

export interface NutritionEntry {
  id: string;
  patientId: string;
  meal: "breakfast" | "lunch" | "dinner" | "snack";
  dayLabel: "Today" | "Yesterday";
  atLabel: string;
  method: CaptureMethod;
  description: string;
  items: FoodItem[];
  /** Parser completeness 0–100 (labeled as parsing confidence, not clinical). */
  confidence: number;
  status: "parsed" | "needs-review" | "corrected" | "confirmed";
  thumbSeed?: string;
  sessionAdded?: boolean;
}

export interface MacroTargets {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  micros: { name: string; target: string; current: string; ok: boolean }[];
}

export interface MealPlan {
  id: string;
  name: string;
  linkedProtocol: string;
  adherencePct: number;
  days: { day: string; meals: string[] }[];
}

export interface DietPlan {
  id?: string;
  templateId?: string;
  category?: string;
  name: string;
  pattern: string;
  status: "active" | "draft";
  reviewLabel: string;
  practitioner: string;
  goals: string[];
  dailyStructure: { meal: string; target: string; example: string }[];
  emphasize: string[];
  limit: string[];
  avoid: string[];
  restrictions: string[];
  hydration: string;
  notes: string[];
  summary?: string;
  phases?: { name: string; duration: string; focus: string }[];
  appropriateFor?: string[];
  cautions?: string[];
  evidenceLabel?: string;
  sourceLabel?: string;
  sourceUrl?: string;
}

export interface DietPlanTemplate extends Omit<DietPlan, "id" | "templateId" | "status" | "reviewLabel" | "practitioner"> {
  id: string;
  category: string;
  evidenceLabel: string;
  appropriateFor: string[];
  cautions: string[];
  phases: { name: string; duration: string; focus: string }[];
  sourceLabel: string;
  sourceUrl: string;
}

export interface NutritionTrends {
  labels: string[];
  kcal: number[];
  proteinG: number[];
  fiberG: number[];
  adherencePct: number[];
}

export interface NutritionAdapter {
  listEntries(patientId: string): NutritionEntry[];
  captureEntry(
    patientId: string,
    patientName: string,
    method: CaptureMethod,
    query: string,
  ): { ok: boolean; entry?: NutritionEntry; message: string };
  correctEntry(
    entryId: string,
    patientId: string,
    patientName: string,
    patch: { description?: string; items?: FoodItem[] },
  ): { ok: boolean; message: string };
  confirmEntry(entryId: string, patientId: string, patientName: string): { ok: boolean; message: string };
  targets(patientId: string): MacroTargets;
  dietPlan(patientId: string): DietPlan | null;
  listDietPlanTemplates(): DietPlanTemplate[];
  assignDietPlan(patientId: string, patientName: string, templateId: string): DietPlan | null;
  saveDietPlan(patientId: string, patientName: string, plan: DietPlan): DietPlan;
  approveDietPlan(patientId: string, patientName: string): DietPlan | null;
  mealPlans(patientId: string): MealPlan[];
  trends(patientId: string): NutritionTrends;
}

const F = (name: string, qty: string, kcal: number, p: number, c: number, f: number, fb: number): FoodItem => ({
  name, qty, kcal, proteinG: p, carbsG: c, fatG: f, fiberG: fb,
});

const SEED_ENTRIES: NutritionEntry[] = [
  {
    id: "ne-1", patientId: "p-78435", meal: "breakfast", dayLabel: "Today", atLabel: "7:15 AM",
    method: "photo", description: "Greek yogurt bowl with berries and walnuts",
    items: [F("Greek yogurt (2%)", "170 g", 130, 17, 8, 4, 0), F("Blueberries", "3/4 cup", 63, 1, 16, 0, 3), F("Walnuts", "14 g", 92, 2, 2, 9, 1)],
    confidence: 92, status: "parsed", thumbSeed: "yogurt-bowl",
  },
  {
    id: "ne-2", patientId: "p-78435", meal: "lunch", dayLabel: "Today", atLabel: "12:40 PM",
    method: "barcode", description: "Lentil soup (packaged) + side salad",
    items: [F("Lentil soup", "1 carton", 240, 14, 38, 4, 9), F("Mixed-greens salad, olive oil", "1 bowl", 180, 3, 8, 15, 3)],
    confidence: 88, status: "parsed", thumbSeed: "lentil-soup",
  },
  {
    id: "ne-3", patientId: "p-78435", meal: "dinner", dayLabel: "Yesterday", atLabel: "7:05 PM",
    method: "voice", description: "\"Salmon, roasted broccoli, half a cup of rice\"",
    items: [F("Salmon fillet", "150 g", 280, 31, 0, 17, 0), F("Roasted broccoli", "1 cup", 55, 4, 10, 1, 4), F("White rice", "1/2 cup", 103, 2, 22, 0, 0)],
    confidence: 74, status: "needs-review", thumbSeed: "salmon-plate",
  },
  {
    id: "ne-4", patientId: "p-78435", meal: "snack", dayLabel: "Yesterday", atLabel: "3:30 PM",
    method: "label", description: "Protein bar (label scan)",
    items: [F("Protein bar", "1 bar", 210, 20, 22, 7, 3)],
    confidence: 96, status: "confirmed", thumbSeed: "protein-bar",
  },
  {
    id: "ne-5", patientId: "p-64201", meal: "dinner", dayLabel: "Yesterday", atLabel: "8:10 PM",
    method: "photo", description: "Pasta with meat sauce, garlic bread",
    items: [F("Pasta with meat sauce", "2 cups", 620, 28, 74, 22, 6), F("Garlic bread", "2 slices", 300, 6, 34, 15, 2)],
    confidence: 81, status: "needs-review", thumbSeed: "pasta-dinner",
  },
];

export const DIET_PLAN_TEMPLATES: DietPlanTemplate[] = [
  {
    id: "diet-mediterranean",
    category: "Foundational",
    name: "Anti-inflammatory Mediterranean plan",
    pattern: "Mediterranean · protein-forward · high-fiber",
    summary: "A flexible, plant-forward pattern centered on vegetables, legumes, fruit, whole grains, olive oil, nuts, seeds, fish, and patient-appropriate protein.",
    evidenceLabel: "Well-established dietary pattern",
    appropriateFor: ["Cardiometabolic support", "A flexible long-term foundation", "Increasing food variety and fiber"],
    cautions: ["Adapt fiber for gastrointestinal tolerance", "Individualize for allergies, kidney disease, diabetes medications, and cultural preferences"],
    phases: [
      { name: "Foundation", duration: "2 weeks", focus: "Build repeatable meals and establish baseline tolerance" },
      { name: "Personalize", duration: "Ongoing", focus: "Adjust portions, foods, and targets to clinical needs and preferences" },
    ],
    goals: ["Build meals around minimally processed foods", "Include a practical protein source at meals", "Increase plant variety gradually", "Create a sustainable long-term pattern"],
    dailyStructure: [
      { meal: "Breakfast", target: "Protein + fiber", example: "Plain yogurt, berries, walnuts, and chia" },
      { meal: "Lunch", target: "Vegetables + protein + slow carbohydrate", example: "Lentil and greens bowl with olive oil" },
      { meal: "Dinner", target: "Protein + colorful plants", example: "Salmon, roasted vegetables, and brown rice" },
      { meal: "Snack", target: "Only when useful", example: "Fruit with nuts or plain kefir" },
    ],
    emphasize: ["Vegetables and fruit", "Beans and lentils", "Fish and seafood", "Extra-virgin olive oil", "Nuts and seeds", "Whole grains"],
    limit: ["Added sugar", "Refined grains", "Highly processed foods", "Processed meats", "Excess alcohol"],
    avoid: ["No universal exclusions"],
    restrictions: ["Customize allergies, intolerances, preferences, and therapeutic targets"],
    hydration: "Set a patient-specific baseline and adjust for activity, climate, medications, and clinical conditions.",
    notes: ["Food lists are flexible examples, not universal prescriptions", "Review symptoms, access, preferences, and adherence"],
    sourceLabel: "American Heart Association · Mediterranean diet overview",
    sourceUrl: "https://www.heart.org/en/healthy-living/healthy-eating/eat-smart/nutrition-basics/mediterranean-diet",
  },
  {
    id: "diet-low-fodmap",
    category: "Digestive",
    name: "Low FODMAP 3-step plan",
    pattern: "Short restriction · structured reintroduction · personalization",
    summary: "A time-limited, three-step process for medically diagnosed IBS: reduce high-FODMAP foods, challenge one FODMAP group at a time, then liberalize to the least restrictive tolerated pattern.",
    evidenceLabel: "Established IBS dietary intervention",
    appropriateFor: ["Medically diagnosed IBS", "Identifying dose-dependent FODMAP triggers", "A dietitian-guided elimination and reintroduction trial"],
    cautions: ["The strict phase is not intended as a permanent diet", "Screen for malnutrition and disordered eating risk", "Serving size changes FODMAP load", "Use a trained dietitian when possible"],
    phases: [
      { name: "Step 1 · Low FODMAP", duration: "Usually 2-6 weeks", focus: "Use appropriate low-FODMAP portions while tracking symptoms" },
      { name: "Step 2 · Reintroduction", duration: "Often 6-8 weeks", focus: "Challenge one FODMAP subgroup at a time" },
      { name: "Step 3 · Personalization", duration: "Long term", focus: "Restore tolerated foods and avoid only demonstrated triggers" },
    ],
    goals: ["Reduce symptoms during a short structured trial", "Identify specific triggers and tolerated doses", "Restore food variety", "Avoid unnecessary long-term restriction"],
    dailyStructure: [
      { meal: "Breakfast", target: "Low-FODMAP portion + protein", example: "Oats with lactose-free yogurt, blueberries, and chia" },
      { meal: "Lunch", target: "Simple ingredients", example: "Chicken, quinoa, cucumber, carrots, and infused oil" },
      { meal: "Dinner", target: "Protein + tolerated vegetables", example: "Fish, potato, green beans, and herbs" },
      { meal: "Challenge", target: "One subgroup at a time", example: "Practitioner-selected food and portion during reintroduction" },
    ],
    emphasize: ["Monash-tested portions", "Oats, rice, quinoa, and potatoes", "Eggs, fish, poultry, and firm tofu", "Carrots, cucumber, zucchini, and leafy greens", "Lactose-free dairy if tolerated"],
    limit: ["Large portions of otherwise tolerated foods", "Stacking several FODMAP sources in one meal", "Products with unclear ingredient lists"],
    avoid: ["High-FODMAP foods only during the short restriction phase", "Permanent blanket restriction without reintroduction"],
    restrictions: ["Customize by serving size, symptoms, nutrition status, and confirmed tolerances"],
    hydration: "Maintain an individualized fluid plan, especially if bowel habits change.",
    notes: ["Food examples are not a substitute for an up-to-date FODMAP database", "Move to reintroduction after symptom stabilization rather than staying in Step 1"],
    sourceLabel: "Monash University · 3-step FODMAP diet",
    sourceUrl: "https://www.monashfodmap.com/blog/3-phases-low-fodmap-diet/",
  },
  {
    id: "diet-aip",
    category: "Elimination",
    name: "Autoimmune Protocol (AIP) diet",
    pattern: "Nutrient-focused elimination · methodical reintroduction",
    summary: "A temporary elimination framework sometimes used with autoimmune conditions. The purpose is to test tolerance and return foods methodically, not to imply that food is the cause or cure of autoimmune disease.",
    evidenceLabel: "Limited and emerging evidence",
    appropriateFor: ["A carefully supervised elimination trial", "Patients able to complete structured reintroduction", "Tracking symptoms alongside standard medical care"],
    cautions: ["Restrictive and difficult to sustain", "Risk of nutrient gaps or disordered eating", "Does not replace diagnosis, medication, or specialist care", "Coordinate with a dietitian and treating clinician"],
    phases: [
      { name: "Preparation", duration: "1-2 weeks", focus: "Establish baseline intake, symptoms, labs, and practical supports" },
      { name: "Elimination", duration: "Time-limited", focus: "Remove selected categories while maintaining nutrient adequacy" },
      { name: "Reintroduction", duration: "Individualized", focus: "Reintroduce one food at a time and document response" },
      { name: "Maintenance", duration: "Ongoing", focus: "Keep the broadest tolerated, nutritionally adequate diet" },
    ],
    goals: ["Create an observable baseline", "Maintain nutrient density during elimination", "Test foods systematically", "Return the greatest possible food variety"],
    dailyStructure: [
      { meal: "Breakfast", target: "Protein + tolerated plants", example: "Turkey patties, greens, and berries" },
      { meal: "Lunch", target: "Protein + varied vegetables", example: "Salmon salad with olive oil and avocado" },
      { meal: "Dinner", target: "Whole-food meal", example: "Chicken, squash, and leafy vegetables" },
      { meal: "Reintroduction", target: "One food at a time", example: "Practitioner-selected challenge with symptom tracking" },
    ],
    emphasize: ["Varied vegetables", "Fruit in individualized portions", "Fish and patient-appropriate proteins", "Olive oil and avocado", "Herbs and fermented foods if tolerated"],
    limit: ["Highly processed foods", "Added sugars", "Foods that obscure a clear challenge response"],
    avoid: ["Grains, legumes, dairy, eggs, nuts/seeds, and nightshades only during the selected elimination phase"],
    restrictions: ["Every removed category needs a documented rationale and reintroduction plan"],
    hydration: "Set an individualized fluid and electrolyte plan.",
    notes: ["Evidence is not equivalent across autoimmune conditions", "Stop or broaden the plan if nutrition status, symptoms, or relationship with food worsen"],
    sourceLabel: "Cleveland Clinic · AIP diet overview",
    sourceUrl: "https://health.clevelandclinic.org/aip-diet-autoimmune-protocol-diet",
  },
  {
    id: "diet-gaps",
    category: "Digestive · limited evidence",
    name: "GAPS diet educational template",
    pattern: "Highly restrictive staged diet · evidence caution",
    summary: "An educational representation of the GAPS framework for practitioners who discuss it. Clinical evidence does not establish its broad treatment claims, so this template requires explicit documentation of rationale, alternatives, nutrition adequacy, and exit criteria.",
    evidenceLabel: "Insufficient evidence for broad treatment claims",
    appropriateFor: ["Documenting an informed discussion when a patient asks about GAPS", "A practitioner-supervised, time-limited plan only after alternatives are reviewed"],
    cautions: ["Highly restrictive with nutritional-deficiency risk", "Do not present as a treatment for autism, psychiatric, neurologic, or other systemic disease", "Not appropriate without medical and nutrition review", "Use clear stop criteria and a plan to broaden intake"],
    phases: [
      { name: "Safety and adequacy review", duration: "Before any restriction", focus: "Review diagnosis, medications, growth/weight, eating history, and alternatives" },
      { name: "Selected trial", duration: "Practitioner defined", focus: "Use the least restrictive version that can answer the clinical question" },
      { name: "Food expansion", duration: "Planned from the start", focus: "Restore variety while tracking objective and subjective outcomes" },
    ],
    goals: ["Document why this approach is being considered", "Protect calorie, protein, fiber, and micronutrient adequacy", "Track predefined outcomes", "Return to a broader diet promptly"],
    dailyStructure: [
      { meal: "Breakfast", target: "Adequate energy and protein", example: "Practitioner-configured whole-food meal" },
      { meal: "Lunch", target: "Protein + tolerated plants", example: "Soup or plated meal with documented ingredients" },
      { meal: "Dinner", target: "Variety within the reviewed plan", example: "Protein, tolerated vegetables, and individualized fats" },
      { meal: "Expansion", target: "Planned food return", example: "One documented addition at a time" },
    ],
    emphasize: ["Nutritional adequacy", "Whole foods", "Patient-tolerated vegetables", "Patient-appropriate proteins", "Documented food expansion"],
    limit: ["Unsubstantiated health claims", "Unnecessary restriction", "Prolonged introductory stages"],
    avoid: ["Using the template without practitioner review", "Delaying indicated medical evaluation or treatment"],
    restrictions: ["Exact exclusions must be configured and justified for the individual patient"],
    hydration: "Set a patient-specific fluid and electrolyte plan and monitor tolerance.",
    notes: ["This template intentionally does not endorse GAPS claims", "Record alternatives discussed and the patient's informed preference"],
    sourceLabel: "NIDDK · guidance on extreme and fad diets",
    sourceUrl: "https://www.niddk.nih.gov/health-information/professionals/diabetes-discoveries-practice/popular-diets-patient-support",
  },
  {
    id: "diet-ketogenic",
    category: "Therapeutic low carbohydrate",
    name: "Ketogenic diet",
    pattern: "Very low carbohydrate · high fat · adequate protein",
    summary: "A medically reviewed very-low-carbohydrate pattern designed to produce nutritional ketosis. It requires a clear indication, medication review, measurable targets, and monitoring rather than a generic one-size-fits-all menu.",
    evidenceLabel: "Indication-dependent; medical supervision required",
    appropriateFor: ["Selected patients after medical review", "Established therapeutic indications under an experienced clinical team", "A defined monitored trial with an exit plan"],
    cautions: ["Medication-related hypoglycemia and ketoacidosis risk in diabetes", "Review pregnancy, eating-disorder history, kidney, liver, gallbladder, pancreatic, and lipid concerns", "May cause constipation or nutrient gaps", "Do not confuse nutritional ketosis with diabetic ketoacidosis"],
    phases: [
      { name: "Medical clearance", duration: "Before starting", focus: "Review indication, medications, labs, contraindications, and monitoring" },
      { name: "Transition", duration: "1-2 weeks", focus: "Adjust carbohydrate intake and monitor symptoms and glucose when indicated" },
      { name: "Therapeutic trial", duration: "Practitioner defined", focus: "Track safety, adherence, biomarkers, and the stated clinical target" },
      { name: "Maintain or exit", duration: "Planned", focus: "Continue only when benefits, risks, and sustainability support it" },
    ],
    goals: ["Use a documented clinical indication", "Protect hydration, electrolytes, fiber, and micronutrients", "Monitor medication-sensitive outcomes", "Reassess benefit and sustainability"],
    dailyStructure: [
      { meal: "Breakfast", target: "Protein + non-starchy plants + fat", example: "Eggs, leafy greens, and avocado" },
      { meal: "Lunch", target: "Protein-centered whole-food meal", example: "Salmon salad with olive oil" },
      { meal: "Dinner", target: "Protein + low-carbohydrate vegetables", example: "Chicken, cauliflower, and zucchini" },
      { meal: "Monitoring", target: "Plan-specific", example: "Glucose, ketones, symptoms, and intake as ordered" },
    ],
    emphasize: ["Non-starchy vegetables", "Fish, eggs, tofu, and patient-appropriate proteins", "Olive oil and avocado", "Nuts and seeds if tolerated", "Low-carbohydrate fiber sources"],
    limit: ["High-carbohydrate foods", "Ultra-processed keto products", "Excess saturated fat", "Alcohol"],
    avoid: ["Sugar-sweetened foods", "Unmonitored medication changes", "Starting without contraindication review"],
    restrictions: ["Exact carbohydrate, protein, fat, electrolyte, and monitoring targets require practitioner configuration"],
    hydration: "Individualize fluids and electrolytes; account for medications and kidney/cardiac conditions.",
    notes: ["Long-term risks and sustainability require review", "Escalate symptoms of severe hypoglycemia or ketoacidosis urgently"],
    sourceLabel: "Cleveland Clinic · ketogenic diet and diabetes safety",
    sourceUrl: "https://health.clevelandclinic.org/is-the-ketogenic-diet-safe-for-people-with-diabetes",
  },
  {
    id: "diet-dash",
    category: "Cardiometabolic",
    name: "DASH-style eating plan",
    pattern: "Vegetable-rich · lower sodium · minimally processed",
    summary: "A flexible eating pattern emphasizing vegetables, fruit, whole grains, beans, nuts, fish, poultry, and low-fat dairy while reducing sodium and highly processed foods.",
    evidenceLabel: "Well-established dietary pattern",
    appropriateFor: ["Blood-pressure support", "Cardiometabolic risk reduction", "A flexible family-friendly food pattern"],
    cautions: ["Sodium and potassium targets must reflect kidney, cardiac, and medication status", "Individualize carbohydrate quality and portions for diabetes"],
    phases: [
      { name: "Baseline", duration: "1 week", focus: "Review current sodium, food access, and meal pattern" },
      { name: "Build", duration: "2-4 weeks", focus: "Increase whole foods and reduce major sodium sources" },
      { name: "Maintain", duration: "Ongoing", focus: "Use sustainable targets and monitor blood pressure" },
    ],
    goals: ["Reduce highly processed sodium sources", "Increase potassium-rich foods when appropriate", "Build repeatable balanced meals", "Track blood pressure and tolerance"],
    dailyStructure: [
      { meal: "Breakfast", target: "Whole grain + protein + fruit", example: "Oats, berries, and plain yogurt" },
      { meal: "Lunch", target: "Vegetables + protein", example: "Bean and vegetable bowl with fruit" },
      { meal: "Dinner", target: "Half vegetables", example: "Fish, greens, and a whole grain" },
      { meal: "Snack", target: "Minimally processed", example: "Unsalted nuts or fruit" },
    ],
    emphasize: ["Vegetables and fruit", "Whole grains", "Beans", "Unsalted nuts and seeds", "Fish and poultry", "Low-fat dairy if tolerated"],
    limit: ["Packaged salty foods", "Processed meats", "Sugary drinks", "Sweets", "Excess alcohol"],
    avoid: ["No universal exclusions"],
    restrictions: ["Customize sodium, potassium, fluid, and carbohydrate targets"],
    hydration: "Use the patient's fluid plan; do not override cardiac or kidney guidance.",
    notes: ["Review labels and restaurant sodium", "Food access and cultural fit belong in the plan"],
    sourceLabel: "NHLBI · DASH eating plan",
    sourceUrl: "https://www.nhlbi.nih.gov/education/dash-eating-plan",
  },
];

interface NutritionSessionState {
  added: NutritionEntry[];
  patched: Record<string, Partial<NutritionEntry>>;
  assignedDietPlans?: Record<string, DietPlan>;
}

const store = createSessionStore<NutritionSessionState>("aidp:demo:nutrition", {
  added: [],
  patched: {},
  assignedDietPlans: {},
});

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function planFromTemplate(template: DietPlanTemplate, status: DietPlan["status"]): DietPlan {
  const { id: templateId, ...content } = copy(template);
  return {
    ...content,
    id: newSessionId(),
    templateId,
    status,
    reviewLabel: status === "active" ? "Reviewed for this patient" : "Practitioner review required",
    practitioner: status === "active" ? "Dr. Sarah Mitchell" : "Draft · not assigned to patient",
  };
}

function seedDietPlan(patientId: string): DietPlan | null {
  if (patientId === "p-78435") {
    const template = DIET_PLAN_TEMPLATES.find((item) => item.id === "diet-mediterranean");
    return template ? planFromTemplate(template, "active") : null;
  }
  if (patientId === "p-64201") {
    return {
      id: "diet-plan-metabolic-foundation",
      name: "Metabolic foundation plan",
      pattern: "Protein-anchored · minimally processed",
      status: "active",
      reviewLabel: "Review Aug 2, 2026",
      practitioner: "Rachel Kim, RD",
      goals: ["Protein at breakfast", "Increase fiber gradually", "Reduce late-evening intake"],
      dailyStructure: [
        { meal: "Breakfast", target: "At least 30 g protein", example: "Eggs, vegetables, plain yogurt" },
        { meal: "Lunch", target: "Protein + vegetables + slow carbohydrate", example: "Chicken grain bowl" },
        { meal: "Dinner", target: "Finish 3 hours before bed", example: "Lean protein with vegetables" },
      ],
      emphasize: ["Lean protein", "Non-starchy vegetables", "Legumes", "Whole-food carbohydrates"],
      limit: ["Sugar-sweetened drinks", "Large refined-carbohydrate portions"],
      avoid: ["No prescribed exclusions"],
      restrictions: ["No recorded food allergy"],
      hydration: "2.5 L/day baseline; adjust as clinically appropriate",
      notes: ["Monitor symptoms and glucose trends; association is not causation"],
    };
  }
  return null;
}

export function useDietPlan(patientId: string): DietPlan | null {
  const state = store.use();
  return state.assignedDietPlans?.[patientId] ?? seedDietPlan(patientId);
}

export function useDietPlanTemplates(): DietPlanTemplate[] {
  return DIET_PLAN_TEMPLATES;
}

export function useNutritionEntries(patientId: string): NutritionEntry[] {
  const s = store.use();
  return mergeEntries(patientId, s);
}

function mergeEntries(patientId: string, s: NutritionSessionState): NutritionEntry[] {
  const all = [...s.added, ...SEED_ENTRIES];
  return all
    .filter((e) => e.patientId === patientId)
    .map((e) => (s.patched[e.id] ? { ...e, ...s.patched[e.id] } : e));
}

/** Deterministic parsed result per capture method for the demo. */
const CAPTURE_RESULTS: Record<CaptureMethod, { description: string; items: FoodItem[]; confidence: number }> = {
  photo: { description: "Chicken salad with avocado (photo parse)", items: [F("Grilled chicken", "120 g", 198, 35, 0, 5, 0), F("Avocado", "1/2", 120, 1, 6, 11, 5), F("Mixed greens", "2 cups", 15, 1, 3, 0, 2)], confidence: 90 },
  barcode: { description: "Almond butter (barcode 0 41570 05622 0)", items: [F("Almond butter", "2 tbsp", 190, 7, 6, 17, 3)], confidence: 97 },
  voice: { description: "\"Two eggs, sourdough toast, butter\"", items: [F("Eggs", "2 large", 140, 12, 1, 10, 0), F("Sourdough toast", "1 slice", 120, 4, 22, 1, 1), F("Butter", "1 tsp", 34, 0, 0, 4, 0)], confidence: 72 },
  search: { description: "Oatmeal with banana (database match)", items: [F("Oatmeal, cooked", "1 cup", 158, 6, 27, 3, 4), F("Banana", "1 medium", 105, 1, 27, 0, 3)], confidence: 94 },
  label: { description: "Kefir, plain (label scan)", items: [F("Kefir", "1 cup", 110, 11, 12, 2, 0)], confidence: 96 },
  manual: { description: "Manual entry", items: [F("Custom item", "1 serving", 200, 10, 20, 8, 2)], confidence: 100 },
};

export const passioMockAdapter: NutritionAdapter = {
  listEntries: (patientId) => mergeEntries(patientId, store.get()),

  captureEntry(patientId, patientName, method, query) {
    const base = CAPTURE_RESULTS[method];
    const entry: NutritionEntry = {
      id: newSessionId(),
      patientId,
      meal: "snack",
      dayLabel: "Today",
      atLabel: "Now",
      method,
      description: method === "search" && query ? `${query} (database match)` : base.description,
      items: base.items,
      confidence: base.confidence,
      status: base.confidence < 80 ? "needs-review" : "parsed",
      thumbSeed: `${method}-${query || "capture"}`,
      sessionAdded: true,
    };
    store.update((s) => ({ ...s, added: [entry, ...s.added] }));
    recordAuditEntry({
      kind: "upload_file",
      subjectType: "nutrition entry",
      subjectLabel: `${method} · ${entry.description.slice(0, 40)}`,
      patientName,
      reviewed: false,
    });
    return {
      ok: true,
      entry,
      message: `Parsed via ${method} (demo — no camera, microphone, or Passio call was made).`,
    };
  },

  correctEntry(entryId, _patientId, patientName, patch) {
    store.update((s) => ({
      ...s,
      patched: {
        ...s.patched,
        [entryId]: { ...s.patched[entryId], ...patch, status: "corrected" as const },
      },
    }));
    recordAuditEntry({
      kind: "mark_reviewed",
      subjectType: "nutrition entry",
      subjectLabel: "Practitioner correction",
      patientName,
      reviewed: true,
      outcome: "reviewed",
    });
    return { ok: true, message: "Correction saved. (demo — this session only)" };
  },

  confirmEntry(entryId, _patientId, patientName) {
    store.update((s) => ({
      ...s,
      patched: { ...s.patched, [entryId]: { ...s.patched[entryId], status: "confirmed" as const } },
    }));
    recordAuditEntry({
      kind: "mark_reviewed",
      subjectType: "nutrition entry",
      subjectLabel: "Entry confirmed",
      patientName,
      reviewed: true,
      outcome: "reviewed",
    });
    return { ok: true, message: "Entry confirmed. (demo — this session only)" };
  },

  targets(patientId) {
    if (patientId === "p-64201") {
      return {
        kcal: 2200, proteinG: 150, carbsG: 200, fatG: 80, fiberG: 35,
        micros: [
          { name: "Omega-3 (EPA+DHA)", target: "3 g", current: "2.6 g", ok: false },
          { name: "Sodium", target: "< 2.3 g", current: "2.9 g", ok: false },
          { name: "Potassium", target: "3.5 g", current: "3.1 g", ok: false },
        ],
      };
    }
    return {
      kcal: 1900, proteinG: 110, carbsG: 190, fatG: 70, fiberG: 30,
      micros: [
        { name: "Vitamin D", target: "2000 IU food+sun", current: "on supplement", ok: true },
        { name: "Magnesium", target: "400 mg", current: "380 mg", ok: true },
        { name: "Fiber", target: "30 g", current: "24 g", ok: false },
        { name: "Added sugar", target: "< 30 g", current: "22 g", ok: true },
      ],
    };
  },

  dietPlan(patientId) {
    return store.get().assignedDietPlans?.[patientId] ?? seedDietPlan(patientId);
  },

  listDietPlanTemplates() {
    return DIET_PLAN_TEMPLATES;
  },

  assignDietPlan(patientId, patientName, templateId) {
    const template = DIET_PLAN_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return null;
    const plan = planFromTemplate(template, "draft");
    store.update((state) => ({
      ...state,
      assignedDietPlans: { ...(state.assignedDietPlans ?? {}), [patientId]: plan },
    }));
    recordAuditEntry({
      kind: "modify",
      subjectType: "diet plan",
      subjectLabel: `${plan.name} draft created`,
      patientName,
      reviewed: false,
    });
    return plan;
  },

  saveDietPlan(patientId, patientName, plan) {
    const saved = { ...copy(plan), status: "draft" as const, reviewLabel: "Practitioner review required", practitioner: "Draft · not assigned to patient" };
    store.update((state) => ({
      ...state,
      assignedDietPlans: { ...(state.assignedDietPlans ?? {}), [patientId]: saved },
    }));
    recordAuditEntry({
      kind: "modify",
      subjectType: "diet plan",
      subjectLabel: `${saved.name} draft updated`,
      patientName,
      reviewed: false,
    });
    return saved;
  },

  approveDietPlan(patientId, patientName) {
    const current = store.get().assignedDietPlans?.[patientId] ?? seedDietPlan(patientId);
    if (!current) return null;
    const approved: DietPlan = {
      ...copy(current),
      status: "active",
      reviewLabel: "Approved this session",
      practitioner: "Dr. Sarah Mitchell · practitioner reviewed",
    };
    store.update((state) => ({
      ...state,
      assignedDietPlans: { ...(state.assignedDietPlans ?? {}), [patientId]: approved },
    }));
    recordAuditEntry({
      kind: "approve",
      subjectType: "diet plan",
      subjectLabel: `${approved.name} approved`,
      patientName,
      reviewed: true,
      outcome: "approved",
    });
    return approved;
  },

  mealPlans(patientId) {
    if (patientId !== "p-78435") return [];
    return [
      {
        id: "mp-1",
        name: "Anti-inflammatory base week",
        linkedProtocol: "Sleep & recovery protocol — phase 2",
        adherencePct: 84,
        days: [
          { day: "Mon", meals: ["Yogurt bowl + walnuts", "Lentil soup + salad", "Salmon + broccoli + rice"] },
          { day: "Tue", meals: ["Eggs + sourdough", "Chicken-avocado salad", "Turkey chili"] },
          { day: "Wed", meals: ["Oatmeal + banana", "Leftover chili", "Sheet-pan chicken + vegetables"] },
        ],
      },
    ];
  },

  trends(patientId) {
    if (patientId === "p-64201") {
      return {
        labels: ["Jul 13", "Jul 14", "Jul 15", "Jul 16", "Jul 17", "Jul 18", "Today"],
        kcal: [2650, 2480, 2390, 2310, 2280, 2250, 1180],
        proteinG: [118, 124, 131, 138, 141, 146, 62],
        fiberG: [22, 24, 25, 27, 28, 29, 14],
        adherencePct: [55, 60, 65, 70, 72, 75, 75],
      };
    }
    return {
      labels: ["Jul 13", "Jul 14", "Jul 15", "Jul 16", "Jul 17", "Jul 18", "Today"],
      kcal: [1840, 1910, 1880, 1930, 1890, 1920, 640],
      proteinG: [98, 104, 108, 112, 109, 111, 38],
      fiberG: [24, 26, 25, 28, 27, 29, 9],
      adherencePct: [80, 82, 84, 84, 86, 84, 84],
    };
  },
};
