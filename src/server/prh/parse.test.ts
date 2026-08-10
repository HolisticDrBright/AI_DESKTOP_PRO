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
      total_source_rows: clinical.length,
      records_researched: clinical.length,
      records_skipped_without_research: 0,
      unresolved_records: clinical.filter((r) => Array.isArray(r.unresolved_reasons) && (r.unresolved_reasons as unknown[]).length > 0).length,
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

function buildPhase9fFixture() {
  const v1 = buildFixture();
  const decodeRows = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
    .trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
  const clinical = decodeRows(v1.bytes.clinical).map((row) => ({
    ...row, practitioner_verified: false, phase: "9F",
  }));
  const commercial = decodeRows(v1.bytes.commercial);
  const evidence: Record<string, unknown>[] = decodeRows(v1.bytes.evidence).map((row, index) => ({
    ...row,
    source_id: `EV9F-${String(index + 1).padStart(5, "0")}`,
    archived: true,
    artifact_relative_path: `evidence/PRH-000${index + 1}/artifact-${index + 1}.json`,
    sha256: String(index + 1).repeat(64),
    url_only_evidence: false,
  }));
  const artifacts = evidence.map((row, index) => ({
    artifact_id: `ART-${String(index + 1).padStart(5, "0")}`,
    product_research_id: `PRH-000${index + 1}`,
    relative_path: row.artifact_relative_path,
    filename: `artifact-${index + 1}.json`,
    extension: "json",
    bytes: 100 + index,
    sha256: row.sha256,
    source_id: row.source_id,
    source_url: row.url,
    authority_tier: 1,
    supports_fields: ["identity"],
    archived_utc: "2026-08-04T00:00:00Z",
  }));
  const conflicts = clinical.slice(0, 2).map((row: Record<string, unknown>, index) => ({
    conflict_id: `CP-${String(index + 1).padStart(5, "0")}`,
    product_research_id: row.product_research_id,
    exact_product_identity: {},
    field: "serving_size",
    existing_value: "one",
    incoming_value: "two",
    existing_source: "source-a",
    incoming_source: "source-b",
    practitioner_decision_required: true,
    resolved_by_research: false,
  }));
  const jsonl = (rows: unknown[]) => new Uint8Array(Buffer.from(
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  ));
  const bytes = {
    clinical: jsonl(clinical), commercial: jsonl(commercial), evidence: jsonl(evidence),
    artifacts: jsonl(artifacts), conflicts: jsonl(conflicts), manifest: new Uint8Array(),
  };
  const names = {
    manifest: "handoff-manifest-v2.json",
    clinical: "product-label-enrichment-v2.jsonl",
    commercial: "commercial-links-v2.jsonl",
    evidence: "evidence-sources-v2.jsonl",
    artifacts: "evidence-artifact-index.jsonl",
    conflicts: "conflict-resolution-packets.jsonl",
  };
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const manifest = JSON.parse(new TextDecoder().decode(v1.bytes.manifest));
  manifest.phase = "9F";
  manifest.version = "2.0";
  manifest.governance.practitioner_verified = false;
  manifest.counts.total_records = clinical.length;
  manifest.counts.commercial_records = commercial.length;
  manifest.counts.evidence_artifacts = artifacts.length;
  manifest.counts.conflict_packets = conflicts.length;
  manifest.output_files = [
    { file: names.clinical, sha256: hash(bytes.clinical) },
    { file: names.commercial, sha256: hash(bytes.commercial) },
    { file: names.evidence, sha256: hash(bytes.evidence) },
    { file: names.artifacts, sha256: hash(bytes.artifacts) },
    { file: names.conflicts, sha256: hash(bytes.conflicts) },
    { file: "qa-report-v2.txt", sha256: "a".repeat(64) },
  ];
  bytes.manifest = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  return { bytes, names };
}

function parsePhase9f(fx: ReturnType<typeof buildPhase9fFixture>) {
  return parseHandoffPackage({
    manifest: { filename: fx.names.manifest, bytes: fx.bytes.manifest },
    clinical: { filename: fx.names.clinical, bytes: fx.bytes.clinical },
    commercial: { filename: fx.names.commercial, bytes: fx.bytes.commercial },
    evidence: { filename: fx.names.evidence, bytes: fx.bytes.evidence },
    artifacts: { filename: fx.names.artifacts, bytes: fx.bytes.artifacts },
    conflicts: { filename: fx.names.conflicts, bytes: fx.bytes.conflicts },
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
    expect(parsed.aggregates.unresolvedTotal).toBe(1);
    expect(parsed.aggregates.commercialOrphanPrhIds).toEqual([]);
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

  test("cross-file reference: an UNDECLARED orphan PRH id rejects (typo case)", () => {
    const fx = buildFixture({
      mutateCommercialItem: (item, i) => {
        if (i === 0) item.product_research_id = "PRH-9999";
      },
    });
    expect(() => parse(fx)).toThrow(/commercial_prh_id_not_in_clinical/);
  });

  test("declared skipped-without-research commercial rows are accepted and surfaced", () => {
    // The package ships a commercial-link inventory for ALL source rows;
    // clinical enrichment covers only the researched subset. One extra
    // commercial row whose id has no clinical counterpart is legal when
    // the manifest declares exactly one skipped-without-research record.
    const fx = buildFixture({
      commercialCount: 4,
      mutateCommercialItem: (item, i) => {
        if (i === 3) item.product_research_id = "PRH-0099";
      },
      mutateManifest: (m) => {
        const counts = m.counts as Record<string, unknown>;
        counts.records_skipped_without_research = 1;
        counts.total_source_rows = 4;
      },
    });
    const parsed = parse(fx);
    expect(parsed.aggregates.commercialCount).toBe(4);
    expect(parsed.aggregates.commercialOrphanPrhIds).toEqual(["PRH-0099"]);
  });

  test("fewer orphans than the manifest declares rejects (declaration mismatch)", () => {
    const fx = buildFixture({
      mutateManifest: (m) => {
        (m.counts as Record<string, unknown>).records_skipped_without_research = 8;
      },
    });
    expect(() => parse(fx)).toThrow(/commercial_orphans_fewer_than_declared/);
  });

  test("evidence rows key on their own id, never the shared product_research_id", () => {
    // The real package's evidence rows carry BOTH a unique source_id and a
    // product_research_id shared by several rows. Keying on the latter
    // collides at the database's unique constraint (the observed
    // PostgREST 409 / SQLSTATE 23505). The adapter must prefer the row's
    // own id.
    const fx = buildFixture({
      mutateEvidenceItem: (item, i) => {
        delete item.evidence_id;
        item.source_id = `EV-${String(1 + i).padStart(5, "0")}`;
        item.product_research_id = "PRH-0001"; // shared across all rows
      },
    });
    const parsed = parse(fx);
    const adapted = adaptForPreview("evidence", parsed.evidence.items);
    expect(adapted.map((a) => a.externalKey)).toEqual(["EV-00001", "EV-00002", "EV-00003"]);
  });

  test("duplicated evidence id rejects with a PHI-safe category", () => {
    const fx = buildFixture({
      mutateEvidenceItem: (item) => {
        item.source_id = "EV-00001";
      },
    });
    expect(() => parse(fx)).toThrow(/duplicate_evidence_id/);
  });

  test("badly shaped commercial PRH id rejects even when orphans are declared", () => {
    const fx = buildFixture({
      mutateCommercialItem: (item, i) => {
        if (i === 0) item.product_research_id = "PRH-99";
      },
      mutateManifest: (m) => {
        (m.counts as Record<string, unknown>).records_skipped_without_research = 1;
      },
    });
    expect(() => parse(fx)).toThrow(/bad_prh_id_shape_commercial/);
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

describe("Phase 9F — supplemental research package parser", () => {
  test("parses five governed preview streams and preserves supplemental identities", () => {
    const parsed = parsePhase9f(buildPhase9fFixture());
    expect(parsed.aggregates).toMatchObject({ artifactCount: 3, conflictCount: 2 });
    expect(adaptForPreview("artifacts", parsed.artifacts!.items)[0]).toMatchObject({
      entityType: "product_label_evidence_artifact", externalKey: "ART-00001",
    });
    expect(adaptForPreview("conflicts", parsed.conflicts!.items)[0]).toMatchObject({
      entityType: "product_label_conflict_packet", externalKey: "CP-00001",
    });
  });

  test("refuses Phase 9F when either supplemental file is omitted", () => {
    const fx = buildPhase9fFixture();
    expect(() => parseHandoffPackage({
      manifest: { filename: fx.names.manifest, bytes: fx.bytes.manifest },
      clinical: { filename: fx.names.clinical, bytes: fx.bytes.clinical },
      commercial: { filename: fx.names.commercial, bytes: fx.bytes.commercial },
      evidence: { filename: fx.names.evidence, bytes: fx.bytes.evidence },
    })).toThrow(/phase9f_supplemental_files_required/);
  });

  test("refuses a conflict packet that is not explicitly practitioner-gated", () => {
    const fx = buildPhase9fFixture();
    const rows = new TextDecoder().decode(fx.bytes.conflicts).trim().split("\n").map((line) => JSON.parse(line));
    rows[0].practitioner_decision_required = false;
    fx.bytes.conflicts = new Uint8Array(Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
    const manifest = JSON.parse(new TextDecoder().decode(fx.bytes.manifest));
    manifest.output_files.find((entry: { file: string }) => entry.file === fx.names.conflicts).sha256 =
      createHash("sha256").update(fx.bytes.conflicts).digest("hex");
    fx.bytes.manifest = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
    expect(() => parsePhase9f(fx)).toThrow(/conflict_practitioner_decision_required/);
  });

  test("refuses artifact paths that escape the package", () => {
    const fx = buildPhase9fFixture();
    const rows = new TextDecoder().decode(fx.bytes.artifacts).trim().split("\n").map((line) => JSON.parse(line));
    rows[0].relative_path = "../outside.json";
    fx.bytes.artifacts = new Uint8Array(Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
    const manifest = JSON.parse(new TextDecoder().decode(fx.bytes.manifest));
    manifest.output_files.find((entry: { file: string }) => entry.file === fx.names.artifacts).sha256 =
      createHash("sha256").update(fx.bytes.artifacts).digest("hex");
    fx.bytes.manifest = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
    expect(() => parsePhase9f(fx)).toThrow(/unsafe_artifact_relative_path/);
  });
});
