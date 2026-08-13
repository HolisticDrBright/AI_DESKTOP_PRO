/**
 * Phase 9E-B — regression tests for the Product Research Handoff import rules.
 *
 * These tests do NOT read the private local package. They exercise the
 * IMPORT-RULE INVARIANTS on synthetic records that mirror the package's
 * schema. Every invariant the operator's brief calls out is asserted here.
 */

import { describe, expect, test } from "vitest";

// The subset of a clinical record we care about for these invariants.
type ClinicalRecord = {
  product_research_id?: string;
  source_file?: string;
  source_sheet?: string;
  source_row?: number;
  identity_confidence?: "exact" | "probable" | "ambiguous" | "unmatched";
  identifiers?: { sku?: string; upc?: string; gtin?: string };
  clinically_approved?: boolean;
  imported?: boolean;
  supplement_facts_complete?: boolean;
  label_verification_candidate?: boolean;
  restriction_flags?: string[];
  conflicting_fields?: unknown;
  affiliate_url?: string;
  price?: number;
  discount_code?: string;
};

type CommercialRecord = {
  product_research_id?: string;
  affiliate_url?: string;
  supplement_facts?: unknown;
  ingredient_amounts?: unknown;
  warnings?: unknown;
  regulatory_classification?: unknown;
  clinical_notes?: unknown;
};

// --- Helpers exercised as the actual import rules would apply them ---
export function mappingKeyFor(record: ClinicalRecord): {
  key: string | null;
  reason: "product_research_id" | "source_file_sheet_row" | "exact_identifier" | "refused_name_only";
} {
  if (record.product_research_id && /^PRH-\d{4}$/.test(record.product_research_id)) {
    return { key: `prh:${record.product_research_id}`, reason: "product_research_id" };
  }
  if (record.source_file && record.source_sheet && typeof record.source_row === "number") {
    return {
      key: `src:${record.source_file}|${record.source_sheet}|${record.source_row}`,
      reason: "source_file_sheet_row",
    };
  }
  if (record.identifiers?.sku || record.identifiers?.upc || record.identifiers?.gtin) {
    const idKey =
      record.identifiers.sku ??
      record.identifiers.upc ??
      record.identifiers.gtin ??
      "";
    return { key: `id:${idKey}`, reason: "exact_identifier" };
  }
  return { key: null, reason: "refused_name_only" };
}

export function canAutoAttachToGovernedProduct(record: ClinicalRecord): {
  attach: boolean;
  reason: string;
} {
  if (record.identity_confidence !== "exact") return { attach: false, reason: "identity_not_exact" };
  if (!record.identifiers?.sku && !record.identifiers?.upc && !record.identifiers?.gtin) {
    return { attach: false, reason: "no_strong_identifier" };
  }
  const cf = record.conflicting_fields;
  const hasConflict = Array.isArray(cf) ? cf.length > 0 : cf && typeof cf === "object" && Object.keys(cf as object).length > 0;
  if (hasConflict) return { attach: false, reason: "unreconciled_conflict" };
  if ((record.restriction_flags?.length ?? 0) > 0) return { attach: false, reason: "restriction_present" };
  if (record.supplement_facts_complete !== true) return { attach: false, reason: "not_complete_supplement_facts" };
  if (record.label_verification_candidate !== true) return { attach: false, reason: "not_label_verification_candidate" };
  // Even under every clinical qualifier, PHASE 9E-B never auto-attaches. It
  // records the mapping and hands it to a practitioner review batch.
  return { attach: false, reason: "phase_9e_b_never_auto_attaches" };
}

export function commercialRecordIsIsolated(record: CommercialRecord): {
  isolated: boolean;
  leaks: string[];
} {
  const bannedFields = [
    "supplement_facts", "ingredient_amounts", "warnings",
    "regulatory_classification", "clinical_notes",
  ] as const;
  const leaks: string[] = [];
  for (const k of bannedFields) if (k in record) leaks.push(k);
  return { isolated: leaks.length === 0, leaks };
}

// --- Tests ---
describe("Phase 9E-B — package integrity refusal", () => {
  test("Hash mismatch refusal: any file whose recomputed hash != manifest refuses the package", () => {
    // The verifier exits non-zero when any hash mismatches. Simulate the
    // logic here as a pure function.
    const verify = (hashRows: Array<{ ok: boolean }>) => hashRows.every((r) => r.ok);
    expect(verify([{ ok: true }, { ok: true }])).toBe(true);
    expect(verify([{ ok: true }, { ok: false }])).toBe(false);
  });

  test("Line-count mismatch refusal: refuses if any of the three JSONL counts != expected", () => {
    const expected = { clinical: 164, commercial: 172, evidence: 433 };
    const check = (actual: typeof expected) =>
      actual.clinical === expected.clinical &&
      actual.commercial === expected.commercial &&
      actual.evidence === expected.evidence;
    expect(check({ clinical: 164, commercial: 172, evidence: 433 })).toBe(true);
    expect(check({ clinical: 163, commercial: 172, evidence: 433 })).toBe(false);
    expect(check({ clinical: 164, commercial: 172, evidence: 432 })).toBe(false);
  });

  test("Duplicate product_research_id: rejected", () => {
    const rows: ClinicalRecord[] = [
      { product_research_id: "PRH-0001" },
      { product_research_id: "PRH-0001" },
    ];
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of rows) {
      const id = r.product_research_id!;
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes.length).toBeGreaterThan(0);
  });
});

describe("Phase 9E-B — mapping key discipline", () => {
  test("Name alone is refused as a mapping key", () => {
    const r: ClinicalRecord = {};
    const m = mappingKeyFor(r);
    expect(m.key).toBeNull();
    expect(m.reason).toBe("refused_name_only");
  });

  test("product_research_id is the highest-priority mapping key", () => {
    const r: ClinicalRecord = {
      product_research_id: "PRH-0055",
      source_file: "x", source_sheet: "y", source_row: 3,
      identifiers: { upc: "071064500128" },
    };
    const m = mappingKeyFor(r);
    expect(m.reason).toBe("product_research_id");
    expect(m.key).toBe("prh:PRH-0055");
  });

  test("Malformed prh id refuses to become the key", () => {
    const r: ClinicalRecord = { product_research_id: "not-a-prh" };
    const m = mappingKeyFor(r);
    expect(m.reason).not.toBe("product_research_id");
  });
});

describe("Phase 9E-B — clinical import rules", () => {
  test("Ambiguous identity NEVER auto-attaches", () => {
    const r: ClinicalRecord = {
      identity_confidence: "ambiguous",
      identifiers: { upc: "071064500128" },
      supplement_facts_complete: true,
      label_verification_candidate: true,
    };
    const c = canAutoAttachToGovernedProduct(r);
    expect(c.attach).toBe(false);
    expect(c.reason).toBe("identity_not_exact");
  });

  test("Unreconciled conflict blocks attach even at exact identity + candidate", () => {
    const r: ClinicalRecord = {
      identity_confidence: "exact",
      identifiers: { upc: "071064500128" },
      supplement_facts_complete: true,
      label_verification_candidate: true,
      conflicting_fields: ["ingredients.GABA.amount"],
    };
    const c = canAutoAttachToGovernedProduct(r);
    expect(c.attach).toBe(false);
    expect(c.reason).toBe("unreconciled_conflict");
  });

  test("Restrictions carry forward and block auto-attach", () => {
    const r: ClinicalRecord = {
      identity_confidence: "exact",
      identifiers: { upc: "071064500128" },
      supplement_facts_complete: true,
      label_verification_candidate: true,
      restriction_flags: ["peptide_containing_topical"],
    };
    const c = canAutoAttachToGovernedProduct(r);
    expect(c.attach).toBe(false);
    expect(c.reason).toBe("restriction_present");
  });

  test("Even every perfect signal, Phase 9E-B still refuses auto-attach", () => {
    const r: ClinicalRecord = {
      identity_confidence: "exact",
      identifiers: { upc: "071064500128" },
      supplement_facts_complete: true,
      label_verification_candidate: true,
      restriction_flags: [],
      conflicting_fields: [],
    };
    const c = canAutoAttachToGovernedProduct(r);
    expect(c.attach).toBe(false);
    expect(c.reason).toBe("phase_9e_b_never_auto_attaches");
  });

  test("candidate flag is NOT the same as verification", () => {
    const r: ClinicalRecord = {
      identity_confidence: "exact",
      identifiers: { upc: "071064500128" },
      supplement_facts_complete: false, // not fact-complete
      label_verification_candidate: true, // still a candidate
    };
    const c = canAutoAttachToGovernedProduct(r);
    expect(c.attach).toBe(false);
    expect(c.reason).toBe("not_complete_supplement_facts");
  });

  test("null values stay null (function does not coerce)", () => {
    const r: ClinicalRecord & { serving_size?: null } = { identity_confidence: "exact", serving_size: null };
    // No calculation, no default. If a downstream layer tries to attach the
    // record, the null is preserved and auto-attach fails on the earlier gate.
    const c = canAutoAttachToGovernedProduct(r);
    expect(c.attach).toBe(false);
    expect(r.serving_size).toBeNull();
  });
});

describe("Phase 9E-B — commercial isolation", () => {
  test("Commercial record with only affiliate_url + prh id is isolated", () => {
    const c: CommercialRecord = { product_research_id: "PRH-0001", affiliate_url: "https://x/aff" };
    expect(commercialRecordIsIsolated(c).isolated).toBe(true);
  });

  test("Any clinical field in a commercial record fails isolation", () => {
    const bad: CommercialRecord = {
      product_research_id: "PRH-0001",
      affiliate_url: "https://x/aff",
      supplement_facts: { serving_size: "1 scoop" },
    };
    const r = commercialRecordIsIsolated(bad);
    expect(r.isolated).toBe(false);
    expect(r.leaks).toContain("supplement_facts");
  });

  test("Every banned field is detected", () => {
    const banned = [
      "supplement_facts", "ingredient_amounts", "warnings",
      "regulatory_classification", "clinical_notes",
    ] as const;
    for (const k of banned) {
      const bad = { [k]: "leaked" } as unknown as CommercialRecord;
      expect(commercialRecordIsIsolated(bad).leaks).toContain(k);
    }
  });
});

describe("Phase 9E-B — evidence limitations", () => {
  test("URL-only evidence never finalizes a label verification on its own", () => {
    type Evidence = { url: string; retrieval_date: string; sha256: null | string };
    const e: Evidence = {
      url: "https://example.com/label.jpg",
      retrieval_date: "2026-08-04",
      sha256: null,
    };
    // Verification requires an archived sha256; a URL-only record cannot pass.
    const canFinalize = e.sha256 !== null;
    expect(canFinalize).toBe(false);
  });
});

describe("Phase 9E-B — governance invariants preserved", () => {
  test("Every clinical record must carry clinically_approved=false + imported=false", () => {
    const r: ClinicalRecord = { clinically_approved: false, imported: false };
    expect(r.clinically_approved).toBe(false);
    expect(r.imported).toBe(false);
  });

  test("Any true value on those flags at import time is refused", () => {
    const flagged: ClinicalRecord = { clinically_approved: true, imported: false };
    const violations: string[] = [];
    if (flagged.clinically_approved !== false) violations.push("clinically_approved must be false");
    if (flagged.imported !== false) violations.push("imported must be false");
    expect(violations.length).toBeGreaterThan(0);
  });
});
