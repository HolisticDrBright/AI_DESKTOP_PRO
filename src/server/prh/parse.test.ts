import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { adaptForPreview, HandoffPackageError, parseHandoffPackage } from "./parse";

// Utility to build a self-consistent fixture package. Every hash is
// recomputed from the emitted bytes so the fixture always validates.
function buildFixture(overrides: Partial<{
  clinicalCount: number;
  commercialCount: number;
  evidenceCount: number;
  mutateClinicalItem?: (item: Record<string, unknown>, i: number) => void;
  mutateCommercialItem?: (item: Record<string, unknown>, i: number) => void;
  mutateEvidenceItem?: (item: Record<string, unknown>, i: number) => void;
  mutateManifest?: (m: Record<string, unknown>) => void;
  tamperClinicalBytes?: (b: Uint8Array) => Uint8Array;
  filenames?: { manifest?: string; clinical?: string; commercial?: string; evidence?: string };
}> = {}): {
  bytes: {
    manifest: Uint8Array;
    clinical: Uint8Array;
    commercial: Uint8Array;
    evidence: Uint8Array;
  };
  names: { manifest: string; clinical: string; commercial: string; evidence: string };
} {
  const clinicalCount = overrides.clinicalCount ?? 3;
  const commercialCount = overrides.commercialCount ?? 3;
  const evidenceCount = overrides.evidenceCount ?? 3;
  const prhIds: string[] = [];
  const clinical: Record<string, unknown>[] = [];
  for (let i = 0; i < clinicalCount; i++) {
    const id = `PRH-${String(1 + i).padStart(4, "0")}`;
    prhIds.push(id);
    const item: Record<string, unknown> = {
      product_research_id: id,
      source_file: "Affiliate Links.xlsx",
      source_sheet: "Products",
      source_row: 10 + i,
      identity_confidence: i === 0 ? "exact" : i === 1 ? "probable" : "ambiguous",
      research_status: "complete",
      clinically_approved: false,
      imported: false,
      supplement_facts_complete: i === 0,
      label_verification_candidate: i === 0,
      identifiers: i === 0 ? { upc: "071064500128" } : {},
      unresolved_reasons: i === 2 ? ["ambiguous_variant"] : [],
    };
    overrides.mutateClinicalItem?.(item, i);
    clinical.push(item);
  }
  const commercial: Record<string, unknown>[] = [];
  for (let i = 0; i < commercialCount; i++) {
    const item: Record<string, unknown> = {
      product_research_id: prhIds[i % prhIds.length],
      affiliate_url: `https://example/aff/${i}`,
      commission: 0,
    };
    overrides.mutateCommercialItem?.(item, i);
    commercial.push(item);
  }
  const evidence: Record<string, unknown>[] = [];
  for (let i = 0; i < evidenceCount; i++) {
    const item: Record<string, unknown> = {
      evidence_id: `EV-${String(1 + i).padStart(4, "0")}`,
      url: `https://example/label/${i}.jpg`,
      authority_tier: i === 0 ? 1 : 2,
      retrieval_date: "2026-08-04",
      sha256: null,
    };
    overrides.mutateEvidenceItem?.(item, i);
    evidence.push(item);
  }
  const jsonl = (rows: unknown[]) => Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const clinicalBytesInit = jsonl(clinical);
  const evidenceBytes = jsonl(evidence);
  const commercialBytes = jsonl(commercial);
  const clinicalBytes = overrides.tamperClinicalBytes
    ? overrides.tamperClinicalBytes(new Uint8Array(clinicalBytesInit))
    : new Uint8Array(clinicalBytesInit);

  const filenames = {
    manifest: overrides.filenames?.manifest ?? "handoff-manifest.json",
    clinical: overrides.filenames?.clinical ?? "product-label-enrichment.jsonl",
    commercial: overrides.filenames?.commercial ?? "commercial-links.jsonl",
    evidence: overrides.filenames?.evidence ?? "evidence-sources.jsonl",
  };
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const manifest: Record<string, unknown> = {
    package: "AI Desktop Pro - Product Label Research Handoff",
    created_utc: "2026-08-04T18:07:28.179102+00:00",
    source_files: [
      { path: "any/path/Affiliate Links.xlsx", sha256: hash(Buffer.from("a")) },
      { path: "any/path/Longevity.xlsx", sha256: hash(Buffer.from("b")) },
    ],
    output_files: [
      { file: filenames.clinical, sha256: hash(clinicalBytes) },
      { file: filenames.commercial, sha256: hash(commercialBytes) },
      { file: filenames.evidence, sha256: hash(evidenceBytes) },
      { file: "product-label-enrichment.xlsx", sha256: hash(Buffer.from("x1")) },
      { file: "unresolved-products.xlsx", sha256: hash(Buffer.from("x2")) },
      { file: "README.md", sha256: hash(Buffer.from("x3")) },
    ],
    counts: {
      total_source_rows: clinical.length + 8,
      records_researched: clinical.length,
      records_skipped_without_research: 8,
      unresolved_records: clinical.filter((r) => Array.isArray(r.unresolved_reasons) && (r.unresolved_reasons as unknown[]).length > 0).length + 8,
      commercial_link_records: commercial.length,
      evidence_source_records: evidence.length,
      records_with_complete_supplement_facts: 1,
      supplement_facts_complete: 1,
      label_verification_candidates: 1,
      by_identity_confidence: { exact: 1, probable: 1, ambiguous: 1, unmatched: 0 },
      by_source_authority_tier: { "1": 1, "2": 2 },
    },
    governance: {
      clinically_approved: false,
      labels_verified: false,
      imported_anywhere: false,
    },
  };
  overrides.mutateManifest?.(manifest);
  const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  return {
    bytes: { manifest: manifestBytes, clinical: clinicalBytes, evidence: evidenceBytes, commercial: commercialBytes },
    names: filenames,
  };
}

function parse(fx: ReturnType<typeof buildFixture>) {
  return parseHandoffPackage({
    manifest: { filename: fx.names.manifest, bytes: fx.bytes.manifest },
    clinical: { filename: fx.names.clinical, bytes: fx.bytes.clinical },
    commercial: { filename: fx.names.commercial, bytes: fx.bytes.commercial },
    evidence: { filename: fx.names.evidence, bytes: fx.bytes.evidence },
  });
}

describe("Phase 9E-B — Product Research Handoff parser", () => {
  test("happy path: valid package parses and emits aggregates", () => {
    const fx = buildFixture();
    const parsed = parse(fx);
    expect(parsed.aggregates.clinicalCount).toBe(3);
    expect(parsed.aggregates.commercialCount).toBe(3);
    expect(parsed.aggregates.evidenceCount).toBe(3);
    expect(parsed.aggregates.uniquePrhIds).toBe(3);
    expect(parsed.aggregates.supplementFactsCompleteCount).toBe(1);
    expect(parsed.aggregates.labelVerificationCandidateCount).toBe(1);
    expect(parsed.aggregates.unresolvedResearched).toBe(1);
    expect(parsed.aggregates.unresolvedTotal).toBe(1 + 8);
    expect(parsed.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("clinical SHA256 mismatch refuses the whole package", () => {
    // Rewrite the manifest to claim a bogus sha256 for the clinical
    // file. The bytes are legal JSONL but the manifest disagrees; the
    // parser must refuse before creating anything.
    const fx = buildFixture();
    const m = JSON.parse(new TextDecoder().decode(fx.bytes.manifest));
    m.output_files[0].sha256 = "f".repeat(64);
    fx.bytes.manifest = new Uint8Array(Buffer.from(JSON.stringify(m)));
    expect(() => parse(fx)).toThrow(HandoffPackageError);
    expect(() => parse(fx)).toThrow(/sha256_mismatch_clinical/);
  });

  test("count mismatch refuses (line count != manifest.records_researched)", () => {
    const fx = buildFixture();
    // Mutate manifest to declare a count different from what the file has.
    const m = JSON.parse(new TextDecoder().decode(fx.bytes.manifest));
    m.counts.records_researched = 99;
    fx.bytes.manifest = new Uint8Array(Buffer.from(JSON.stringify(m)));
    // BUT the manifest file hash isn't checked against itself — it's the
    // JSONL files' hashes that are checked. So this mismatch surfaces at
    // count reconciliation.
    expect(() => parse(fx)).toThrow(/clinical_count_mismatch/);
  });

  test("malformed JSONL line rejects", () => {
    const fx = buildFixture();
    fx.bytes.clinical = new Uint8Array(
      Buffer.from(new TextDecoder().decode(fx.bytes.clinical) + "\n{not-json}\n"),
    );
    // Recompute manifest hash for the clinical file so the ONLY failure
    // is the malformed line, not sha256.
    const m = JSON.parse(new TextDecoder().decode(fx.bytes.manifest));
    m.output_files[0].sha256 = createHash("sha256").update(fx.bytes.clinical).digest("hex");
    m.counts.records_researched = m.counts.records_researched + 1; // count matches now
    fx.bytes.manifest = new Uint8Array(Buffer.from(JSON.stringify(m)));
    expect(() => parse(fx)).toThrow(/invalid_json_clinical/);
  });

  test("duplicate product_research_id rejects", () => {
    const fx = buildFixture({
      mutateClinicalItem: (item, i) => {
        if (i > 0) item.product_research_id = "PRH-0001";
      },
    });
    expect(() => parse(fx)).toThrow(/duplicate_prh_id_PRH-0001/);
  });

  test("cross-file reference: commercial row references an unknown PRH id rejects", () => {
    const fx = buildFixture({
      mutateCommercialItem: (item, i) => {
        if (i === 0) item.product_research_id = "PRH-9999";
      },
    });
    expect(() => parse(fx)).toThrow(/commercial_prh_id_not_in_clinical/);
  });

  test("commercial isolation: any clinical field in a commercial row rejects", () => {
    const fx = buildFixture({
      mutateCommercialItem: (item, i) => {
        if (i === 0) item.supplement_facts = { serving_size: "1 cap" };
      },
    });
    expect(() => parse(fx)).toThrow(/commercial_carries_supplement_facts/);
  });

  test("governance-flag violation on a clinical row rejects", () => {
    const fx = buildFixture({
      mutateClinicalItem: (item, i) => {
        if (i === 0) item.imported = true;
      },
    });
    expect(() => parse(fx)).toThrow(/imported_must_be_false_clinical/);
  });

  test("clinical row carrying affiliate_url rejects", () => {
    const fx = buildFixture({
      mutateClinicalItem: (item, i) => {
        if (i === 0) item.affiliate_url = "https://x/aff";
      },
    });
    expect(() => parse(fx)).toThrow(/clinical_carries_affiliate_url/);
  });

  test("private Windows path in any row rejects", () => {
    const fx = buildFixture({
      mutateClinicalItem: (item, i) => {
        if (i === 0) item.reviewer_notes = "see C:\\Users\\Brand\\something";
      },
    });
    expect(() => parse(fx)).toThrow(/private_windows_path_in_clinical/);
  });

  test("evidence row carrying archived sha256 rejects (Phase 9E-B allows only URL-only records)", () => {
    const fx = buildFixture({
      mutateEvidenceItem: (item, i) => {
        if (i === 0) item.sha256 = "a".repeat(64);
      },
    });
    expect(() => parse(fx)).toThrow(/evidence_archived_sha256_not_allowed/);
  });

  test("wrong manifest governance flags reject the package", () => {
    const fx = buildFixture({
      mutateManifest: (m) => {
        (m.governance as Record<string, unknown>).clinically_approved = true;
      },
    });
    expect(() => parse(fx)).toThrow(/manifest_governance_not_draft/);
  });

  test("filename mismatch refuses (caller supplied file with wrong name)", () => {
    const fx = buildFixture();
    // The manifest names one file; caller names it something else.
    fx.names.clinical = "wrong-name.jsonl";
    expect(() => parse(fx)).toThrow(/filename_mismatch_clinical|manifest_missing_output_wrong-name/);
  });

  test("adaptForPreview shapes rows into the {entityType,payload,externalKey,displayName} contract", () => {
    const fx = buildFixture();
    const parsed = parse(fx);
    const adapted = adaptForPreview("clinical", parsed.clinical.items);
    expect(adapted).toHaveLength(3);
    for (const row of adapted) {
      expect(row.entityType).toBe("product_label_research");
      expect(typeof row.externalKey).toBe("string");
      expect(typeof row.displayName).toBe("string");
      expect(row.payload).toBeTypeOf("object");
    }
  });
});
