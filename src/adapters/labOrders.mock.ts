import type { ProvenanceData } from "./types";
import { money } from "./inventory.mock";

/**
 * MOCK lab ordering.
 *
 * A panel catalog (commonly ordered + custom/advanced), a set of RECOMMENDED
 * panels derived from reasoning / labs / goals / protocols (each with a reason
 * + provenance + review state), and a per-patient DRAFT order held in the
 * session store. DEMO ONLY — no lab order is ever submitted, no requisition is
 * generated, no price is charged. Prices/consent/requisition are placeholders.
 */

export { money };

export type PanelGroup = "common" | "custom";

export interface LabPanel {
  id: string;
  name: string;
  vendor: string;
  category: string;
  specimenType: string;
  fasting: boolean;
  markers: string[];
  /** Estimated patient price PLACEHOLDER, in cents. Not a real charge. */
  estPriceMinor: number;
  turnaround: string;
  group: PanelGroup;
  description: string;
}

export interface RecommendedPanel {
  panelId: string;
  /** Where the recommendation came from. */
  source: "Reasoning" | "Labs" | "Goals" | "Protocol";
  reason: string;
  provenance: ProvenanceData;
  /** What's still needed before this could actually be ordered (demo). */
  missingInfo: string[];
}

export interface OrderEvent {
  id: string;
  at: string;
  label: string;
}

export interface LabOrderDraft {
  panelIds: string[];
  status: "draft" | "prepared";
  reviewed: boolean;
  events: OrderEvent[];
}

export const EMPTY_DRAFT: LabOrderDraft = { panelIds: [], status: "draft", reviewed: false, events: [] };

const CATALOG: LabPanel[] = [
  { id: "lp-cmp", name: "Comprehensive Metabolic Panel", vendor: "Quest Diagnostics", category: "Metabolic", specimenType: "Serum", fasting: true, markers: ["Glucose", "BUN", "Creatinine", "eGFR", "Sodium", "Potassium", "Calcium", "Albumin", "ALT", "AST", "ALP"], estPriceMinor: 2900, turnaround: "1–2 days", group: "common", description: "Kidney, liver, electrolytes and glucose overview." },
  { id: "lp-cbc", name: "Complete Blood Count (CBC)", vendor: "Quest Diagnostics", category: "Hematology", specimenType: "Whole blood", fasting: false, markers: ["WBC", "RBC", "Hemoglobin", "Hematocrit", "MCV", "Platelets"], estPriceMinor: 1900, turnaround: "1 day", group: "common", description: "Red/white cell lines and platelets." },
  { id: "lp-lipid", name: "Lipid Panel", vendor: "Quest Diagnostics", category: "Cardiovascular", specimenType: "Serum", fasting: true, markers: ["Total cholesterol", "LDL-C", "HDL-C", "Triglycerides"], estPriceMinor: 2400, turnaround: "1–2 days", group: "common", description: "Standard cholesterol panel." },
  { id: "lp-thyroid", name: "Thyroid Panel (TSH, Free T4, Free T3)", vendor: "Labcorp", category: "Thyroid", specimenType: "Serum", fasting: false, markers: ["TSH", "Free T4", "Free T3"], estPriceMinor: 4900, turnaround: "2–3 days", group: "common", description: "Core thyroid function." },
  { id: "lp-a1c", name: "Hemoglobin A1c", vendor: "Quest Diagnostics", category: "Metabolic", specimenType: "Whole blood", fasting: false, markers: ["HbA1c"], estPriceMinor: 1800, turnaround: "1–2 days", group: "common", description: "90-day glycemic average." },
  { id: "lp-vitd", name: "Vitamin D, 25-OH", vendor: "Quest Diagnostics", category: "Micronutrient", specimenType: "Serum", fasting: false, markers: ["25-OH Vitamin D"], estPriceMinor: 3900, turnaround: "2–3 days", group: "common", description: "Vitamin D status." },
  { id: "lp-hscrp", name: "hs-CRP", vendor: "Quest Diagnostics", category: "Inflammation", specimenType: "Serum", fasting: false, markers: ["hs-CRP"], estPriceMinor: 2200, turnaround: "1–2 days", group: "common", description: "High-sensitivity inflammation marker." },
  { id: "lp-ferritin", name: "Ferritin + Iron Studies", vendor: "Labcorp", category: "Micronutrient", specimenType: "Serum", fasting: true, markers: ["Ferritin", "Iron", "TIBC", "% Saturation"], estPriceMinor: 3400, turnaround: "2 days", group: "common", description: "Iron storage and transport." },
  { id: "lp-apob", name: "Advanced Cardiometabolic (ApoB, Lp(a), LDL-P)", vendor: "Boston Heart", category: "Cardiovascular", specimenType: "Serum", fasting: true, markers: ["ApoB", "Lp(a)", "LDL-P", "HDL-P"], estPriceMinor: 11900, turnaround: "5–7 days", group: "custom", description: "Particle-level cardiovascular risk." },
  { id: "lp-thyroid-ab", name: "Full Thyroid + Antibodies", vendor: "Labcorp", category: "Thyroid", specimenType: "Serum", fasting: false, markers: ["TSH", "Free T4", "Free T3", "Reverse T3", "TPO Ab", "Tg Ab"], estPriceMinor: 12900, turnaround: "3–5 days", group: "custom", description: "Complete thyroid with autoimmunity." },
  { id: "lp-omega", name: "Omega-3 Index + Fatty Acids", vendor: "OmegaQuant", category: "Micronutrient", specimenType: "Whole blood", fasting: false, markers: ["Omega-3 Index", "EPA", "DHA", "AA:EPA"], estPriceMinor: 6900, turnaround: "5–7 days", group: "custom", description: "Membrane fatty-acid status." },
  { id: "lp-gimap", name: "GI-MAP Stool (microbiome)", vendor: "Diagnostic Solutions", category: "GI", specimenType: "Stool", fasting: false, markers: ["Microbiome", "Pathogens", "Calprotectin", "Zonulin"], estPriceMinor: 35900, turnaround: "2–3 weeks", group: "custom", description: "Gut microbiome and GI markers." },
  { id: "lp-dutch", name: "DUTCH Complete (hormones)", vendor: "Precision Analytical", category: "Hormones", specimenType: "Dried urine", fasting: false, markers: ["Cortisol pattern", "Estrogens", "Androgens", "Melatonin"], estPriceMinor: 29900, turnaround: "2–3 weeks", group: "custom", description: "Dried-urine hormone metabolites." },
  { id: "lp-homocys", name: "Homocysteine + Methylation", vendor: "Quest Diagnostics", category: "Micronutrient", specimenType: "Serum", fasting: true, markers: ["Homocysteine", "Folate", "Vitamin B12"], estPriceMinor: 4400, turnaround: "2–3 days", group: "common", description: "Methylation and B-vitamin status." },
];

const RECOMMENDED: RecommendedPanel[] = [
  {
    panelId: "lp-thyroid-ab",
    source: "Reasoning",
    reason: "Cortisol/thyroid dysregulation hypothesis is active; thyroid antibodies are not yet on file.",
    provenance: { sourceType: "ai-inference", sourceName: "Clinical Reasoning · Cortisol dysregulation", review: "awaiting-review", confidence: 78 },
    missingInfo: ["Clinical indication", "Antibody history"],
  },
  {
    panelId: "lp-hscrp",
    source: "Labs",
    reason: "Prior hs-CRP 2.8 mg/L was above optimal — recheck to trend inflammation.",
    provenance: { sourceType: "measured", sourceName: "Quest · May 13", review: "reviewed", confidence: 92 },
    missingInfo: [],
  },
  {
    panelId: "lp-apob",
    source: "Goals",
    reason: "Longevity / cardiovascular-prevention goal — ApoB and Lp(a) have not been measured.",
    provenance: { sourceType: "published-evidence", sourceName: "Prevention framework", review: "not-reviewed", confidence: 60 },
    missingInfo: ["Clinical indication", "Fasting confirmation"],
  },
  {
    panelId: "lp-omega",
    source: "Protocol",
    reason: "Omega-3 is in the current supplement stack — a baseline index is recommended before titration.",
    provenance: { sourceType: "practitioner-confirmed", sourceName: "Supplement stack", review: "reviewed", confidence: 85 },
    missingInfo: [],
  },
];

export function getLabCatalog(): LabPanel[] {
  return CATALOG;
}

export function getPanelById(id: string): LabPanel | undefined {
  return CATALOG.find((p) => p.id === id);
}

export function getRecommendedPanels(): RecommendedPanel[] {
  return RECOMMENDED;
}

/** Order-context requirements shown before action (all demo placeholders). */
export interface OrderContextItem {
  label: string;
  value: string;
  satisfied: boolean;
}

export function getOrderContext(draft: LabOrderDraft): OrderContextItem[] {
  const panels = draft.panelIds.map(getPanelById).filter(Boolean) as LabPanel[];
  const anyFasting = panels.some((p) => p.fasting);
  const vendors = Array.from(new Set(panels.map((p) => p.vendor)));
  return [
    { label: "Reason for order", value: "— add before submitting (demo)", satisfied: false },
    { label: "Clinical indication / diagnosis", value: "— placeholder, practitioner-entered", satisfied: false },
    { label: "Specimen type", value: panels.length ? Array.from(new Set(panels.map((p) => p.specimenType))).join(", ") : "—", satisfied: panels.length > 0 },
    { label: "Fasting required", value: panels.length ? (anyFasting ? "Yes — at least one panel" : "No") : "—", satisfied: panels.length > 0 },
    { label: "Lab vendor", value: vendors.length ? vendors.join(", ") : "—", satisfied: panels.length > 0 },
    { label: "Consent / requisition", value: "Not on file (demo)", satisfied: false },
  ];
}
