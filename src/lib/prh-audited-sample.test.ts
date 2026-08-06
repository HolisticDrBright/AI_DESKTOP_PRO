import { describe, expect, test } from "vitest";
import { deriveAuditedSample } from "./prh-audited-sample";

function manifest(overrides: Partial<{
  performed: boolean;
  recordsAudited: number;
  corrections: unknown;
}> = {}): Record<string, unknown> {
  return {
    package: "AI Desktop Pro - Product Label Research Handoff",
    independent_verification: {
      performed: overrides.performed ?? true,
      records_audited: overrides.recordsAudited ?? 3,
    },
    corrections_applied: overrides.corrections ?? [
      "[critical] PRH-0055.warnings set_null - FABRICATION.",
      "[minor] PRH-0055.regulatory_classification set - MISSED FACT.",
      "[major] PRH-0082.suggested_use replace_substring - TRANSCRIPTION ERROR.",
      "[informational] PRH-0021.reviewer_notes append - annotation.",
    ],
  };
}

describe("Phase 9E-B — audited-sample derivation from the manifest", () => {
  test("derives the unique record ids named by corrections", () => {
    const r = deriveAuditedSample(manifest());
    expect(r).toEqual({
      ok: true,
      auditedIds: ["PRH-0021", "PRH-0055", "PRH-0082"],
      recordsAudited: 3,
    });
  });

  test("refuses when the declared audit size disagrees with the named records", () => {
    const r = deriveAuditedSample(manifest({ recordsAudited: 10 }));
    expect(r).toEqual({ ok: false, reason: "audited_count_mismatch" });
  });

  test("refuses when independent verification was not performed", () => {
    const r = deriveAuditedSample(manifest({ performed: false }));
    expect(r).toEqual({ ok: false, reason: "independent_verification_not_performed" });
  });

  test("refuses a correction entry that names no record", () => {
    const r = deriveAuditedSample(manifest({
      corrections: ["[major] a correction with no record id"],
    }));
    expect(r).toEqual({ ok: false, reason: "correction_entry_names_no_record" });
  });

  test("refuses a manifest without corrections_applied", () => {
    const m = manifest();
    delete m.corrections_applied;
    expect(deriveAuditedSample(m)).toEqual({
      ok: false,
      reason: "manifest_missing_corrections_applied",
    });
  });

  test("refuses non-object input", () => {
    expect(deriveAuditedSample(null)).toEqual({ ok: false, reason: "manifest_not_object" });
    expect(deriveAuditedSample([])).toEqual({ ok: false, reason: "manifest_not_object" });
  });
});
