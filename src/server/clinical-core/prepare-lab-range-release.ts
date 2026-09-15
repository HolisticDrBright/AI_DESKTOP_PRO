import { createHash } from "node:crypto";
import { calendarDate, preciseLabRangeReleaseSchema, type PreciseLabRangeRelease } from "./lab-range-population";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => value.replace(/\r\n/g, "\n");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const refuse = (): never => { throw new Error("lab_range_preparation_refused"); };
const sourceKinds: Record<string, "functional_target" | "conventional_reference"> = {
  population_reference_range: "conventional_reference",
  pediatric_reference_interval: "conventional_reference",
  pediatric_functional_range: "functional_target",
  practitioner_opinion_range: "functional_target",
};
const files = new Set(["hormone_population_ranges.json", "conventional_intervals.json", "functional_statements.json", "optimal_ranges.json"]);
const fileTypes: Record<string, string> = { "hormone_population_ranges.json": "population_reference_range",
  "conventional_intervals.json": "pediatric_reference_interval", "functional_statements.json": "pediatric_functional_range",
  "optimal_ranges.json": "practitioner_opinion_range" };

/**
 * Pure source-bound preparation for the existing Ed25519 release workflow.
 * A human supplies explicit numeric/population/assay mappings; text is NOT parsed
 * into guessed clinical rules. No signing, approval mutation, file or network IO.
 */
export function preparePreciseLabRangeRelease(input: {
  manifestText: string; expectedManifestSha256: string; sourceFile: string; sourceText: string;
  candidate: unknown; parentSourceText?: string;
}, now = Date.now()): { release: PreciseLabRangeRelease; sourceFileSha256: string; status: "unsigned_not_deployed" } {
  if (typeof input.manifestText !== "string" || typeof input.sourceText !== "string"
    || Buffer.byteLength(input.manifestText) > 200_000 || Buffer.byteLength(input.sourceText) > 2_000_000
    || !files.has(input.sourceFile)) return refuse();
  const manifestText = canonical(input.manifestText), sourceText = canonical(input.sourceText);
  if (hash(manifestText) !== input.expectedManifestSha256) return refuse();
  let manifest: unknown, source: unknown;
  try { manifest = JSON.parse(manifestText); source = JSON.parse(sourceText); } catch { return refuse(); }
  const expectedPackage = ["hormone_population_ranges.json", "optimal_ranges.json"].includes(input.sourceFile)
    ? "lab-optimal-ranges" : "pediatric-optimal-ranges";
  if (!object(manifest) || manifest.package !== expectedPackage
    || !object(manifest.files)) return refuse();
  const metadata = manifest.files[input.sourceFile];
  const sourceFileSha256 = hash(sourceText);
  if (!object(metadata) || metadata.sha256 !== sourceFileSha256 || metadata.bytes !== Buffer.byteLength(sourceText)) return refuse();
  const rows = input.sourceFile === "hormone_population_ranges.json" && object(source) ? source.records : source;
  if (!Array.isArray(rows)) return refuse();
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!object(row) || typeof row.id !== "string" || !row.id.trim() || byId.has(row.id)) return refuse();
    byId.set(row.id, row);
  }
  if (input.sourceFile === "hormone_population_ranges.json") {
    if (typeof input.parentSourceText !== "string" || Buffer.byteLength(input.parentSourceText) > 2_000_000) return refuse();
    const parentText = canonical(input.parentSourceText), metadata = manifest.files["optimal_ranges.json"];
    if (!object(metadata) || metadata.sha256 !== hash(parentText) || metadata.bytes !== Buffer.byteLength(parentText)) return refuse();
    let parents: unknown;
    try { parents = JSON.parse(parentText); } catch { return refuse(); }
    if (!Array.isArray(parents)) return refuse();
    const ids = new Set<string>();
    for (const parent of parents) {
      if (!object(parent) || typeof parent.id !== "string" || !parent.id.trim() || ids.has(parent.id)) return refuse();
      ids.add(parent.id);
    }
    if (rows.some(row => !ids.has(row.markerId))) return refuse();
  }
  const parsed = preciseLabRangeReleaseSchema.safeParse(input.candidate);
  if (!parsed.success || !parsed.data.ranges.length || Date.parse(parsed.data.expiresAt) <= now) return refuse();
  for (const mapping of parsed.data.ranges) {
    const row = byId.get(mapping.source.recordId);
    if (!row || row.contentType !== fileTypes[input.sourceFile] || row.reviewStatus !== "approved" || sourceKinds[String(row.contentType)] !== mapping.rangeKind
      || mapping.source.packageSha256 !== input.expectedManifestSha256
      || mapping.source.recordSha256 !== hash(JSON.stringify(row))
      || mapping.canonicalName !== row.marker || mapping.unit !== row.units
      || Date.parse(mapping.reviewedAt) > now || Date.parse(mapping.source.verifiedOn) > now) return refuse();
    if (row.sourceUrl !== undefined && row.sourceUrl !== mapping.source.url) return refuse();
    if (row.activation !== undefined || row.contentType === "population_reference_range") {
      const a = row.activation;
      if (!object(a) || a.patientFacingEligible !== true || a.practitionerApproval !== "approved" || a.sourceVerification !== "V"
        || a.verifiedBy !== mapping.source.verifiedBy || a.verifiedOn !== mapping.source.verifiedOn
        || a.verifiedAgainst !== mapping.source.verifiedAgainst) return refuse();
      if (row.contentType === "population_reference_range" && (!object(row.review)
        || row.review.decision !== "approve" || typeof row.review.decidedBy !== "string" || !row.review.decidedBy.trim()
        || !calendarDate.safeParse(row.review.decidedAt).success)) return refuse();
    } else if (row.verification !== "V") return refuse();
    // Review cannot erase a contested statement or turn it into an executable target.
    if (row.contested === true) return refuse();
  }
  return { release: parsed.data, sourceFileSha256, status: "unsigned_not_deployed" };
}
