/**
 * Phase 9E-B — Product Research Handoff package parser.
 *
 * SERVER-ONLY. Reads only the four files the caller explicitly hands us
 * (manifest + three JSONL). Never crawls a directory. Never logs raw
 * content. Never writes to disk. Never uploads to any external service.
 *
 * Contract:
 *   - UTF-8 only.
 *   - Bounded per-file size (see BOUNDS below).
 *   - Bounded per-file line count and per-line length.
 *   - Every JSONL line must be a valid JSON object.
 *   - `product-label-enrichment.jsonl`: 164 unique `product_research_id`
 *     values matching /^PRH-\d{4}$/, `clinically_approved:false`,
 *     `imported:false`, no `affiliate_url` / `commercial_url` /
 *     `discount_code` / `price`.
 *   - `commercial-links.jsonl`: 172 records, every one has a
 *     `product_research_id` also present in the clinical set.
 *   - `evidence-sources.jsonl`: 433 records, every one URL-only with
 *     `sha256:null` (unarchived).
 *   - Each JSONL's declared filename, byte size, and SHA-256 hash must
 *     match the manifest exactly. Any mismatch refuses the WHOLE package.
 *
 * Refusal categories are PHI-safe short strings so error paths never
 * leak file content.
 */
if (typeof window !== "undefined") {
  throw new Error("server/prh/parse is server-only.");
}

import { createHash } from "node:crypto";

export const BOUNDS = {
  manifestMaxBytes: 512 * 1024,
  clinicalMaxBytes: 8 * 1024 * 1024,
  evidenceMaxBytes: 4 * 1024 * 1024,
  commercialMaxBytes: 2 * 1024 * 1024,
  maxLineBytes: 128 * 1024,
  maxLinesClinical: 200,
  maxLinesEvidence: 600,
  maxLinesCommercial: 220,
} as const;

export type ManifestOutputEntry = { file: string; sha256: string };
export type ManifestSourceEntry = { path: string; sha256: string };
export type HandoffManifest = {
  package: string;
  created_utc: string;
  source_files: ManifestSourceEntry[];
  output_files: ManifestOutputEntry[];
  counts: {
    total_source_rows: number;
    records_researched: number;
    records_skipped_without_research: number;
    unresolved_records: number;
    commercial_link_records: number;
    evidence_source_records: number;
    records_with_complete_supplement_facts: number;
    supplement_facts_complete: number;
    label_verification_candidates: number;
    by_identity_confidence: Record<string, number>;
    by_source_authority_tier: Record<string, number>;
  };
  governance: {
    clinically_approved: boolean;
    labels_verified: boolean;
    imported_anywhere: boolean;
  };
};

export type HandoffPackageInput = {
  // Each field carries the raw file bytes AND the practitioner-supplied
  // filename + byte size. We NEVER trust either without checking against
  // the manifest's declared hash + size.
  manifest: { filename: string; bytes: Uint8Array };
  clinical: { filename: string; bytes: Uint8Array };
  commercial: { filename: string; bytes: Uint8Array };
  evidence: { filename: string; bytes: Uint8Array };
};

export type HandoffParseResult = {
  manifest: HandoffManifest;
  manifestSha256: string;
  clinical: { sha256: string; items: unknown[]; source_name: string; source_filename: string; source_byte_size: number };
  evidence: { sha256: string; items: unknown[]; source_name: string; source_filename: string; source_byte_size: number };
  commercial: { sha256: string; items: unknown[]; source_name: string; source_filename: string; source_byte_size: number };
  aggregates: {
    clinicalCount: number;
    commercialCount: number;
    evidenceCount: number;
    uniquePrhIds: number;
    identityCounts: Record<string, number>;
    supplementFactsCompleteCount: number;
    labelVerificationCandidateCount: number;
    unresolvedResearched: number;
    unresolvedTotal: number;
  };
};

export class HandoffPackageError extends Error {
  readonly category: string;
  constructor(category: string, message?: string) {
    super(message ?? category);
    this.category = category;
    this.name = "HandoffPackageError";
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8Strict(bytes: Uint8Array, whichFile: string): string {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(bytes);
  } catch {
    throw new HandoffPackageError(`invalid_utf8_${whichFile}`);
  }
}

function assertSize(bytes: Uint8Array, max: number, whichFile: string): void {
  if (bytes.byteLength > max) throw new HandoffPackageError(`file_too_large_${whichFile}`);
  if (bytes.byteLength <= 0) throw new HandoffPackageError(`file_empty_${whichFile}`);
}

function parseJsonl(text: string, whichFile: string, maxLines: number): unknown[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length > maxLines) throw new HandoffPackageError(`too_many_lines_${whichFile}`);
  const items: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > BOUNDS.maxLineBytes) throw new HandoffPackageError(`line_too_long_${whichFile}`);
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new HandoffPackageError(`invalid_json_${whichFile}_at_line_${i + 1}`);
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new HandoffPackageError(`not_object_${whichFile}_at_line_${i + 1}`);
    }
    items.push(obj);
  }
  return items;
}

function parseManifest(bytes: Uint8Array): HandoffManifest {
  assertSize(bytes, BOUNDS.manifestMaxBytes, "manifest");
  const text = decodeUtf8Strict(bytes, "manifest");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new HandoffPackageError("invalid_json_manifest");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new HandoffPackageError("manifest_not_object");
  }
  const m = obj as Partial<HandoffManifest>;
  if (typeof m.package !== "string" || typeof m.created_utc !== "string")
    throw new HandoffPackageError("manifest_missing_fields");
  if (!Array.isArray(m.source_files) || m.source_files.length !== 2)
    throw new HandoffPackageError("manifest_bad_source_files");
  if (!Array.isArray(m.output_files) || m.output_files.length < 6)
    throw new HandoffPackageError("manifest_bad_output_files");
  for (const s of m.source_files) {
    if (!s || typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.sha256))
      throw new HandoffPackageError("manifest_bad_source_hash");
  }
  for (const o of m.output_files) {
    if (!o || typeof o.file !== "string" || typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256))
      throw new HandoffPackageError("manifest_bad_output_hash");
  }
  const c = m.counts as HandoffManifest["counts"] | undefined;
  if (!c || typeof c.records_researched !== "number" || typeof c.commercial_link_records !== "number"
      || typeof c.evidence_source_records !== "number") {
    throw new HandoffPackageError("manifest_bad_counts");
  }
  const g = m.governance as HandoffManifest["governance"] | undefined;
  if (!g || g.clinically_approved !== false || g.labels_verified !== false || g.imported_anywhere !== false) {
    throw new HandoffPackageError("manifest_governance_not_draft");
  }
  return m as HandoffManifest;
}

function findManifestOutput(manifest: HandoffManifest, filename: string): ManifestOutputEntry {
  const entry = manifest.output_files.find((o) => o.file === filename);
  if (!entry) throw new HandoffPackageError(`manifest_missing_output_${filename}`);
  return entry;
}

function assertGovernanceOk(items: unknown[], whichFile: "clinical"): void {
  for (const item of items) {
    const r = item as Record<string, unknown>;
    if ("clinically_approved" in r && r.clinically_approved !== false)
      throw new HandoffPackageError(`clinically_approved_must_be_false_${whichFile}`);
    if ("imported" in r && r.imported !== false)
      throw new HandoffPackageError(`imported_must_be_false_${whichFile}`);
    for (const banned of ["affiliate_url", "commercial_url", "discount_code", "price"] as const) {
      if (banned in r) throw new HandoffPackageError(`clinical_carries_${banned}`);
    }
    const flat = JSON.stringify(r);
    // JSON.stringify escapes `\` to `\\`; the regex accepts either form.
    if (/C:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)Brand/i.test(flat))
      throw new HandoffPackageError("private_windows_path_in_clinical");
  }
}

function assertCommercialIsolation(items: unknown[]): void {
  const banned = [
    "ingredient_amounts", "warnings", "supplement_facts", "regulatory_classification",
    "suggested_use", "clinical_notes", "reviewer_notes",
  ] as const;
  for (const item of items) {
    const r = item as Record<string, unknown>;
    for (const k of banned) if (k in r) throw new HandoffPackageError(`commercial_carries_${k}`);
    const flat = JSON.stringify(r);
    if (/C:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)Brand/i.test(flat))
      throw new HandoffPackageError("private_windows_path_in_commercial");
  }
}

function assertPrhIdShapeAndUniqueness(items: unknown[]): Set<string> {
  const seen = new Set<string>();
  for (const item of items) {
    const r = item as Record<string, unknown>;
    const id = r.product_research_id;
    if (typeof id !== "string" || !/^PRH-\d{4}$/.test(id))
      throw new HandoffPackageError("bad_prh_id_shape_clinical");
    if (seen.has(id)) throw new HandoffPackageError(`duplicate_prh_id_${id}`);
    seen.add(id);
  }
  return seen;
}

function assertCrossFileReferences(commercialItems: unknown[], clinicalIds: Set<string>): void {
  for (const item of commercialItems) {
    const r = item as Record<string, unknown>;
    const id = r.product_research_id;
    if (typeof id !== "string") throw new HandoffPackageError("commercial_missing_prh_id");
    if (!clinicalIds.has(id)) throw new HandoffPackageError("commercial_prh_id_not_in_clinical");
  }
}

function assertEvidenceRepresentation(items: unknown[]): void {
  for (const item of items) {
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || r.url.length === 0) throw new HandoffPackageError("evidence_missing_url");
    if (r.sha256 !== null && r.sha256 !== undefined) throw new HandoffPackageError("evidence_archived_sha256_not_allowed");
  }
}

export function parseHandoffPackage(input: HandoffPackageInput): HandoffParseResult {
  // 1. Manifest first.
  const manifest = parseManifest(input.manifest.bytes);
  const manifestSha256 = sha256Hex(input.manifest.bytes);

  // 2. Refuse if the manifest itself doesn't declare all three JSONL files.
  const clinicalDecl = findManifestOutput(manifest, "product-label-enrichment.jsonl");
  const evidenceDecl = findManifestOutput(manifest, "evidence-sources.jsonl");
  const commercialDecl = findManifestOutput(manifest, "commercial-links.jsonl");

  // 3. Verify each JSONL's filename + byte size + sha256 against the manifest.
  const checkFile = (
    file: { filename: string; bytes: Uint8Array },
    decl: ManifestOutputEntry,
    which: "clinical" | "evidence" | "commercial",
    maxBytes: number,
  ) => {
    if (file.filename !== decl.file) throw new HandoffPackageError(`filename_mismatch_${which}`);
    assertSize(file.bytes, maxBytes, which);
    const hash = sha256Hex(file.bytes);
    if (hash !== decl.sha256) throw new HandoffPackageError(`sha256_mismatch_${which}`);
    return hash;
  };
  const clinicalSha256 = checkFile(input.clinical, clinicalDecl, "clinical", BOUNDS.clinicalMaxBytes);
  const evidenceSha256 = checkFile(input.evidence, evidenceDecl, "evidence", BOUNDS.evidenceMaxBytes);
  const commercialSha256 = checkFile(input.commercial, commercialDecl, "commercial", BOUNDS.commercialMaxBytes);

  // 4. Parse JSONL into items.
  const clinicalItems = parseJsonl(decodeUtf8Strict(input.clinical.bytes, "clinical"), "clinical", BOUNDS.maxLinesClinical);
  const evidenceItems = parseJsonl(decodeUtf8Strict(input.evidence.bytes, "evidence"), "evidence", BOUNDS.maxLinesEvidence);
  const commercialItems = parseJsonl(decodeUtf8Strict(input.commercial.bytes, "commercial"), "commercial", BOUNDS.maxLinesCommercial);

  // 5. Line-count reconciliation against the manifest.
  if (clinicalItems.length !== manifest.counts.records_researched)
    throw new HandoffPackageError("clinical_count_mismatch");
  if (evidenceItems.length !== manifest.counts.evidence_source_records)
    throw new HandoffPackageError("evidence_count_mismatch");
  if (commercialItems.length !== manifest.counts.commercial_link_records)
    throw new HandoffPackageError("commercial_count_mismatch");

  // 6. Governance + isolation + uniqueness.
  assertGovernanceOk(clinicalItems, "clinical");
  const clinicalIds = assertPrhIdShapeAndUniqueness(clinicalItems);
  assertCommercialIsolation(commercialItems);
  assertCrossFileReferences(commercialItems, clinicalIds);
  assertEvidenceRepresentation(evidenceItems);

  // 7. Aggregate the sanitized numbers.
  const identityCounts: Record<string, number> = {};
  let supplementFactsCompleteCount = 0;
  let labelVerificationCandidateCount = 0;
  let unresolvedResearched = 0;
  for (const item of clinicalItems) {
    const r = item as Record<string, unknown>;
    const ic = typeof r.identity_confidence === "string" ? r.identity_confidence : "unknown";
    identityCounts[ic] = (identityCounts[ic] ?? 0) + 1;
    if (r.supplement_facts_complete === true) supplementFactsCompleteCount += 1;
    if (r.label_verification_candidate === true) labelVerificationCandidateCount += 1;
    const ur = r.unresolved_reasons;
    if (Array.isArray(ur) && ur.length > 0) unresolvedResearched += 1;
  }

  return {
    manifest,
    manifestSha256,
    clinical: {
      sha256: clinicalSha256, items: clinicalItems,
      source_name: "Product Research Handoff — product-label-enrichment",
      source_filename: input.clinical.filename,
      source_byte_size: input.clinical.bytes.byteLength,
    },
    evidence: {
      sha256: evidenceSha256, items: evidenceItems,
      source_name: "Product Research Handoff — evidence-sources",
      source_filename: input.evidence.filename,
      source_byte_size: input.evidence.bytes.byteLength,
    },
    commercial: {
      sha256: commercialSha256, items: commercialItems,
      source_name: "Product Research Handoff — commercial-links",
      source_filename: input.commercial.filename,
      source_byte_size: input.commercial.bytes.byteLength,
    },
    aggregates: {
      clinicalCount: clinicalItems.length,
      commercialCount: commercialItems.length,
      evidenceCount: evidenceItems.length,
      uniquePrhIds: clinicalIds.size,
      identityCounts,
      supplementFactsCompleteCount,
      labelVerificationCandidateCount,
      unresolvedResearched,
      unresolvedTotal: unresolvedResearched + manifest.counts.records_skipped_without_research,
    },
  };
}

/**
 * Adapt a parsed clinical/evidence/commercial item to the `_items` array
 * shape `preview_knowledge_import` expects (`{entityType, payload, sourceRaw,
 * externalKey, displayName, sourceSheet}`). Never invents fields; never
 * writes ingredient text into an externalKey slot; product_research_id is
 * the external key.
 */
export function adaptForPreview(
  which: "clinical" | "evidence" | "commercial",
  items: unknown[],
): Array<Record<string, unknown>> {
  const entityType =
    which === "clinical" ? "product_label_research" :
    which === "evidence" ? "product_label_evidence" :
    "product_label_commercial_link";
  return items.map((raw, index) => {
    const r = raw as Record<string, unknown>;
    const id =
      typeof r.product_research_id === "string" ? r.product_research_id :
      typeof r.evidence_id === "string" ? r.evidence_id : `row-${index + 1}`;
    const displayName =
      typeof r.official_product_name === "string" && r.official_product_name.length > 0
        ? r.official_product_name
        : typeof r.original_product_name === "string"
        ? r.original_product_name
        : id;
    return {
      entityType,
      externalKey: id,
      displayName,
      sourceSheet: typeof r.source_sheet === "string" ? r.source_sheet : null,
      payload: r,
      sourceRaw: {},
    };
  });
}
