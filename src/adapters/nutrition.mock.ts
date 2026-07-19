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

interface NutritionSessionState {
  added: NutritionEntry[];
  patched: Record<string, Partial<NutritionEntry>>;
}

const store = createSessionStore<NutritionSessionState>("aidp:demo:nutrition", {
  added: [],
  patched: {},
});

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
