import { describe, expect, test } from "vitest";
import { PRH_FILTERS, PRH_STATUS_LABELS } from "./research-handoff-filters";

/**
 * Phase 9E-B — Product Research Handoff filter + status vocabulary
 * invariants.
 *
 * Anything missing here would fail an operator relying on the corresponding
 * filter chip or legend entry.
 */

const REQUIRED_FILTERS = [
  "source_package",
  "prh_id",
  "identity_exact",
  "identity_probable",
  "identity_ambiguous",
  "identity_unmatched",
  "strong_identifier_present",
  "strong_identifier_absent",
  "candidate",
  "supplement_facts_complete",
  "missing_facts",
  "conflicting_fields",
  "restricted",
  "evidence_not_archived",
  "physical_label_required",
  "commercial_match_pending",
  "audited_sample",
] as const;

const REQUIRED_STATUSES = [
  "previewed",
  "unresolved",
  "candidate",
  "verified",
  "approved",
  "matched",
] as const;

describe("Product Research Handoff filter panel — surface invariants", () => {
  test("every required filter key is present with a human label", () => {
    const keys = new Set(PRH_FILTERS.map((f) => f.key));
    for (const key of REQUIRED_FILTERS) {
      expect(keys.has(key), `missing filter key: ${key}`).toBe(true);
    }
    for (const f of PRH_FILTERS) {
      expect(typeof f.label === "string" && f.label.length > 0, `empty label: ${f.key}`).toBe(true);
    }
  });

  test("no duplicate filter keys", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const f of PRH_FILTERS) {
      if (seen.has(f.key)) dupes.push(f.key);
      seen.add(f.key);
    }
    expect(dupes).toEqual([]);
  });

  test("filter key set does NOT contain bulk-operation shortcuts", () => {
    const banned = [
      "bulk_verify_all",
      "bulk_approve_all",
      "bulk_clear_restrictions",
      "bulk_resolve_conflicts",
      "bulk_attach_commercial",
    ];
    const keys = PRH_FILTERS.map((f) => f.key);
    for (const b of banned) {
      expect(keys, `must not offer ${b} as a filter`).not.toContain(b);
    }
  });

  test("every practitioner-status label is present", () => {
    const keys = new Set(Object.keys(PRH_STATUS_LABELS));
    for (const s of REQUIRED_STATUSES) {
      expect(keys.has(s), `missing status: ${s}`).toBe(true);
    }
  });

  test("status labels distinguish previewed from verified from approved from matched", () => {
    const {
      previewed,
      unresolved,
      candidate,
      verified,
      approved,
      matched,
    } = PRH_STATUS_LABELS;
    expect(previewed).toBe("Previewed");
    expect(unresolved).toBe("Unresolved");
    expect(candidate).toBe("Candidate for review");
    expect(verified).toBe("Practitioner verified");
    expect(approved).toBe("Clinically approved");
    expect(matched).toBe("Commercially matched");
    const uniq = new Set([previewed, unresolved, candidate, verified, approved, matched]);
    expect(uniq.size).toBe(6);
  });
});
