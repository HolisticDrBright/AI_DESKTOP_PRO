import type { Tone } from "./types";

/**
 * MOCK supplement dispensary / inventory.
 *
 * Practice-wide product stock (seed) + per-line sale pricing. Live stock is the
 * seed adjusted by session movements (sales decrement, restocks increment) held
 * in the session store, so the demo "counts down" as you sell — nothing is
 * persisted to a backend. Prices are in minor units (cents) to avoid float drift.
 */

export interface InventoryProduct {
  id: string;
  name: string;
  brand: string;
  sku: string;
  category: string;
  supplier: string;
  unitLabel: string;
  /** Patient-facing explanation copied onto the invoice at checkout. */
  invoiceDescription: string;
  taxable: boolean;
  /** Retail price charged to the patient, per unit, in cents. */
  priceMinor: number;
  /** Practice cost, per unit, in cents (for margin — not shown to patients). */
  costMinor: number;
  /** Seed quantity on hand. Effective stock = seed + session adjustment. */
  stock: number;
  reorderPoint: number;
}

export const INVENTORY_CATEGORIES = [
  "Minerals",
  "Vitamins",
  "Omega",
  "Probiotics",
  "Botanicals",
  "Adaptogens",
  "Metabolic",
  "Sleep",
] as const;

export const CATEGORY_TONE: Record<string, Tone> = {
  Minerals: "teal",
  Vitamins: "action",
  Omega: "navy",
  Probiotics: "positive",
  Botanicals: "warning",
  Adaptogens: "ai",
  Metabolic: "critical",
  Sleep: "slate",
};

export const SEED_PRODUCTS: InventoryProduct[] = [
  { id: "sup-mag-gly", name: "Magnesium Glycinate 400mg", brand: "Pure Encapsulations", sku: "MIN-MAG-GLY", category: "Minerals", supplier: "Pure Encapsulations", unitLabel: "60 ct bottle", invoiceDescription: "Highly absorbable magnesium glycinate selected to support relaxation, sleep quality, muscle function, and healthy magnesium status.", taxable: true, priceMinor: 3200, costMinor: 1800, stock: 24, reorderPoint: 6 },
  { id: "sup-d3-5k", name: "Vitamin D3 5000 IU", brand: "Thorne", sku: "VIT-D3-5K", category: "Vitamins", supplier: "Thorne", unitLabel: "60 ct bottle", invoiceDescription: "Vitamin D3 selected to support healthy vitamin D status, immune function, and bone health; use according to the practitioner plan.", taxable: true, priceMinor: 2200, costMinor: 1100, stock: 40, reorderPoint: 10 },
  { id: "sup-omega", name: "Omega-3 EPA/DHA", brand: "Nordic Naturals", sku: "OMG-EPA-DHA", category: "Omega", supplier: "Nordic Naturals", unitLabel: "120 ct softgels", invoiceDescription: "Concentrated EPA and DHA selected to support cardiovascular, brain, and healthy inflammatory-response pathways.", taxable: true, priceMinor: 4600, costMinor: 2600, stock: 5, reorderPoint: 8 },
  { id: "sup-bcomplex", name: "Methyl B-Complex", brand: "Thorne", sku: "VIT-BCX-MET", category: "Vitamins", supplier: "Thorne", unitLabel: "60 ct capsules", invoiceDescription: "Activated B-vitamin complex selected to support energy metabolism, methylation, and nervous-system function.", taxable: true, priceMinor: 2800, costMinor: 1500, stock: 18, reorderPoint: 6 },
  { id: "sup-probiotic", name: "Probiotic 50B", brand: "Seeking Health", sku: "PRO-50B", category: "Probiotics", supplier: "Seeking Health", unitLabel: "30 ct capsules", invoiceDescription: "Multi-strain probiotic selected to support microbial diversity, digestive function, and intestinal barrier health.", taxable: true, priceMinor: 3900, costMinor: 2200, stock: 12, reorderPoint: 6 },
  { id: "sup-curcumin", name: "Curcumin Phytosome", brand: "Thorne", sku: "HRB-CUR-PHY", category: "Botanicals", supplier: "Thorne", unitLabel: "60 ct capsules", invoiceDescription: "Enhanced-absorption curcumin selected to support a healthy inflammatory response and antioxidant defenses.", taxable: true, priceMinor: 4300, costMinor: 2400, stock: 3, reorderPoint: 6 },
  { id: "sup-zinc", name: "Zinc Picolinate 30mg", brand: "Pure Encapsulations", sku: "MIN-ZN-PIC", category: "Minerals", supplier: "Pure Encapsulations", unitLabel: "60 ct capsules", invoiceDescription: "Zinc picolinate selected to support immune function, tissue repair, and healthy zinc status.", taxable: true, priceMinor: 1600, costMinor: 800, stock: 30, reorderPoint: 10 },
  { id: "sup-ashwa", name: "Ashwagandha KSM-66", brand: "Gaia Herbs", sku: "ADP-ASH-KSM", category: "Adaptogens", supplier: "Gaia Herbs", unitLabel: "60 ct capsules", invoiceDescription: "Standardized ashwagandha selected to support stress resilience, restorative sleep, and balanced energy.", taxable: true, priceMinor: 2700, costMinor: 1400, stock: 15, reorderPoint: 6 },
  { id: "sup-coq10", name: "CoQ10 100mg", brand: "Pure Encapsulations", sku: "VIT-COQ10", category: "Vitamins", supplier: "Pure Encapsulations", unitLabel: "60 ct capsules", invoiceDescription: "Coenzyme Q10 selected to support cellular energy production and cardiovascular function.", taxable: true, priceMinor: 3800, costMinor: 2100, stock: 9, reorderPoint: 6 },
  { id: "sup-berberine", name: "Berberine 500mg", brand: "Thorne", sku: "MET-BER-500", category: "Metabolic", supplier: "Thorne", unitLabel: "60 ct capsules", invoiceDescription: "Berberine selected as part of the practitioner-directed plan to support healthy glucose and lipid metabolism.", taxable: true, priceMinor: 3000, costMinor: 1600, stock: 20, reorderPoint: 8 },
  { id: "sup-theanine", name: "L-Theanine 200mg", brand: "NOW Foods", sku: "AMN-LTHE-200", category: "Adaptogens", supplier: "NOW Foods", unitLabel: "90 ct capsules", invoiceDescription: "L-theanine selected to support calm focus and relaxation without daytime sedation.", taxable: true, priceMinor: 1800, costMinor: 900, stock: 26, reorderPoint: 8 },
  { id: "sup-melatonin", name: "Melatonin 3mg", brand: "Life Extension", sku: "SLP-MEL-3", category: "Sleep", supplier: "Life Extension", unitLabel: "60 ct tablets", invoiceDescription: "Melatonin selected for short-term support of sleep timing and circadian rhythm according to the practitioner plan.", taxable: true, priceMinor: 1200, costMinor: 500, stock: 0, reorderPoint: 6 },
];

/** Format cents as a USD string. */
export function money(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export type StockLevel = "out" | "low" | "ok";

export function stockLevel(stock: number, reorderPoint: number): StockLevel {
  if (stock <= 0) return "out";
  if (stock <= reorderPoint) return "low";
  return "ok";
}

export const STOCK_TONE: Record<StockLevel, Tone> = {
  out: "critical",
  low: "warning",
  ok: "positive",
};

export const STOCK_LABEL: Record<StockLevel, string> = {
  out: "Out of stock",
  low: "Low stock",
  ok: "In stock",
};
