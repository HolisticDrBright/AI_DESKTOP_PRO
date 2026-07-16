import type { ProvenanceData, Tone } from "./types";

/**
 * MOCK supplement-intelligence data. Synthetic only; shaped like a future
 * `api.supplements.getWorkspace` tRPC query. Personal-response conclusions use
 * ONLY the cautious vocabulary; nothing here implies efficacy beyond the
 * patient's own observed data, and dosing/interactions require practitioner
 * review.
 */

export type ResponseConclusion =
  | "Likely beneficial"
  | "Possibly beneficial"
  | "No measurable effect"
  | "Possibly harmful"
  | "Inconclusive";

export const CONCLUSION_TONE: Record<ResponseConclusion, Tone> = {
  "Likely beneficial": "positive",
  "Possibly beneficial": "teal",
  "No measurable effect": "slate",
  "Possibly harmful": "critical",
  Inconclusive: "warning",
};

export interface StackItem {
  id: string;
  product: string;
  brand: string;
  ingredients: string[];
  dose: string;
  schedule: string;
  purpose: string;
  startDate: string;
  adherencePct: number;
  evidence: "Strong" | "Moderate" | "Emerging" | "Limited";
  safety: "No flags" | "Monitor" | "Interaction flag";
  responseConclusion: ResponseConclusion;
  approved: boolean;
  provenance: ProvenanceData;
  seeds: string[];
}

export type AuditFlagKind =
  | "duplicate"
  | "cumulative"
  | "excessive"
  | "med-interaction"
  | "supp-interaction"
  | "condition-caution"
  | "monitoring"
  | "no-purpose"
  | "simplify";

export interface StackAuditFlag {
  id: string;
  kind: AuditFlagKind;
  label: string;
  detail: string;
  severity: "info" | "caution" | "warning";
  products: string[];
}

export interface ResponsePanel {
  productId: string;
  product: string;
  target: string;
  biomarkers: { name: string; before: string; now: string; direction: string }[];
  symptoms: { name: string; trend: string }[];
  adherencePct: number;
  outcomeTrend: string;
  confounders: string[];
  conclusion: ResponseConclusion;
  rationale: string;
}

export interface SupplementWorkspace {
  patientId: string;
  updatedOn: string;
  stack: StackItem[];
  auditFlags: StackAuditFlag[];
  response: ResponsePanel[];
  libraryPreview: { name: string; brand: string; note: string }[];
  refills: { product: string; daysLeft: number; status: "OK" | "Refill soon" | "Requested" }[];
}

export function getSupplementWorkspace(patientId: string): SupplementWorkspace {
  return {
    patientId,
    updatedOn: "Jul 14, 2026",
    stack: [
      {
        id: "s1",
        product: "Magnesium Glycinate 240 mg",
        brand: "Pure Encapsulations",
        ingredients: ["Magnesium (glycinate) 240 mg"],
        dose: "2 caps",
        schedule: "Evening",
        purpose: "Sleep quality / muscle tension",
        startDate: "Jun 30, 2026",
        adherencePct: 92,
        evidence: "Moderate",
        safety: "No flags",
        responseConclusion: "Possibly beneficial",
        approved: true,
        provenance: { sourceType: "practitioner-confirmed", sourceName: "Protocol · Jun 30", review: "reviewed" },
        seeds: ["Magnesium glycinate 240 mg evening — deep sleep +21 min avg since start"],
      },
      {
        id: "s2",
        product: "Omega-3 (EPA/DHA) 3 g",
        brand: "Nordic Naturals",
        ingredients: ["EPA 1.6 g", "DHA 1.2 g"],
        dose: "3 softgels",
        schedule: "With breakfast",
        purpose: "Inflammation / omega-3 index",
        startDate: "Apr 2, 2026",
        adherencePct: 88,
        evidence: "Strong",
        safety: "Monitor",
        responseConclusion: "Possibly beneficial",
        approved: true,
        provenance: { sourceType: "practitioner-confirmed", sourceName: "Protocol · Apr 2", review: "reviewed" },
        seeds: ["Omega-3 3 g/day — omega-3 index 4.8 → 6.2%, hs-CRP trending down"],
      },
      {
        id: "s3",
        product: "Vitamin D3 5000 IU + K2",
        brand: "Thorne",
        ingredients: ["Vitamin D3 5000 IU", "Vitamin K2 (MK-7) 90 µg"],
        dose: "1 cap",
        schedule: "With breakfast",
        purpose: "Vitamin D repletion",
        startDate: "May 20, 2026",
        adherencePct: 95,
        evidence: "Strong",
        safety: "Monitor",
        responseConclusion: "Likely beneficial",
        approved: true,
        provenance: { sourceType: "practitioner-confirmed", sourceName: "Repletion protocol", review: "reviewed" },
        seeds: ["Vitamin D3 5000 IU — 25-OH D rising 18 → 24 ng/mL; recheck due at 8 weeks"],
      },
      {
        id: "s4",
        product: "Ashwagandha 600 mg",
        brand: "Gaia Herbs",
        ingredients: ["Ashwagandha root extract 600 mg"],
        dose: "2 caps",
        schedule: "Evening",
        purpose: "Stress / cortisol support",
        startDate: "Mar 15, 2026",
        adherencePct: 61,
        evidence: "Emerging",
        safety: "Monitor",
        responseConclusion: "Inconclusive",
        approved: true,
        provenance: { sourceType: "practitioner-confirmed", sourceName: "Protocol · Mar 15", review: "awaiting-review" },
        seeds: ["Ashwagandha 600 mg — adherence 61%, cortisol unchanged; response inconclusive"],
      },
      {
        id: "s5",
        product: "Multivitamin (legacy)",
        brand: "Patient-purchased",
        ingredients: ["Mixed micronutrients incl. Mg 100 mg, D3 1000 IU"],
        dose: "1 tab",
        schedule: "Morning",
        purpose: "— (predates care plan)",
        startDate: "Jan 2025",
        adherencePct: 74,
        evidence: "Limited",
        safety: "No flags",
        responseConclusion: "No measurable effect",
        approved: false,
        provenance: { sourceType: "patient-reported", sourceName: "Intake form", review: "not-reviewed" },
        seeds: ["Legacy multivitamin overlaps magnesium + D3 — simplification candidate"],
      },
    ],
    auditFlags: [
      { id: "f1", kind: "duplicate", label: "Duplicate ingredients", detail: "Magnesium appears in Magnesium Glycinate (240 mg) and the legacy multivitamin (100 mg).", severity: "caution", products: ["Magnesium Glycinate 240 mg", "Multivitamin (legacy)"] },
      { id: "f2", kind: "cumulative", label: "Cumulative vitamin D exposure", detail: "D3 5000 IU + multivitamin 1000 IU = 6000 IU/day. Within short-term repletion practice, above long-term maintenance — recheck due before continuing.", severity: "warning", products: ["Vitamin D3 5000 IU + K2", "Multivitamin (legacy)"] },
      { id: "f3", kind: "monitoring", label: "Monitoring required", detail: "Vitamin D repletion requires 8-week 25-OH D recheck (due Jul 8 — overdue).", severity: "warning", products: ["Vitamin D3 5000 IU + K2"] },
      { id: "f4", kind: "med-interaction", label: "Medication interaction check", detail: "Omega-3 at 3 g/day: review if any anticoagulant is added to the medication list.", severity: "info", products: ["Omega-3 (EPA/DHA) 3 g"] },
      { id: "f5", kind: "no-purpose", label: "No active purpose", detail: "Legacy multivitamin predates the care plan and has no linked goal.", severity: "info", products: ["Multivitamin (legacy)"] },
      { id: "f6", kind: "simplify", label: "Simplification candidate", detail: "Dropping the legacy multivitamin removes the duplicate magnesium and excess D3 without losing a targeted intervention.", severity: "info", products: ["Multivitamin (legacy)"] },
    ],
    response: [
      {
        productId: "s1",
        product: "Magnesium Glycinate 240 mg",
        target: "Sleep quality / muscle tension",
        biomarkers: [{ name: "Deep sleep (avg)", before: "58 min", now: "79 min", direction: "↑" }],
        symptoms: [
          { name: "Muscle tension", trend: "↓ 22% (self-rated)" },
          { name: "Sleep onset", trend: "↓ 9 min" },
        ],
        adherencePct: 92,
        outcomeTrend: "Deep sleep up 21 min on 30-day average since start",
        confounders: ["Morning-light experiment overlaps the same window", "Seasonal daylight increase"],
        conclusion: "Possibly beneficial",
        rationale:
          "Observed improvement overlaps a concurrent light-exposure experiment, so the change cannot be attributed to magnesium alone. Observed association only — not causation.",
      },
      {
        productId: "s4",
        product: "Ashwagandha 600 mg",
        target: "Evening cortisol / stress",
        biomarkers: [{ name: "AM cortisol", before: "20.9 µg/dL", now: "21.3 µg/dL", direction: "→" }],
        symptoms: [{ name: "Stress (PSS-10)", trend: "24/40, unchanged" }],
        adherencePct: 61,
        outcomeTrend: "No measurable change in cortisol or stress scores",
        confounders: ["Adherence 61% limits interpretation"],
        conclusion: "Inconclusive",
        rationale:
          "Low adherence prevents a fair read. Improve adherence or discontinue before judging response.",
      },
    ],
    libraryPreview: [
      { name: "L-Theanine 200 mg", brand: "NOW", note: "Practice library — evening stress option (requires practitioner review)" },
      { name: "Creatine monohydrate 5 g", brand: "Thorne", note: "Practice library — training support" },
      { name: "Berberine 500 mg", brand: "Integrative Therapeutics", note: "Practice library — glycemic support (interaction review required)" },
    ],
    refills: [
      { product: "Magnesium Glycinate 240 mg", daysLeft: 12, status: "Refill soon" },
      { product: "Omega-3 (EPA/DHA) 3 g", daysLeft: 34, status: "OK" },
      { product: "Vitamin D3 5000 IU + K2", daysLeft: 6, status: "Requested" },
    ],
  };
}
