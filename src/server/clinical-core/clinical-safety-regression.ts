import { createHash } from "node:crypto";
import { z } from "zod";
import { preciseLabRangeReleaseSchema, type PreciseLabRange, type PreciseLabRangeRelease } from "./lab-range-population";
import { LAB_INPUT_MARKERS, LAB_PLAUSIBILITY_MARKERS } from "./aws-lab-analysis-worker";

/** Clinical safety regression over release artifacts.
 *
 * Offline and deterministic. It reads a prepared `lab-ranges/2` release and,
 * when supplied, a governed catalog manifest and a reviewed knowledge release
 * payload, and reports whether the release-qualification checks the six-phase
 * ledger names hold: every input marker is represented or explicitly excluded
 * with a reviewed reason; ranges are sourced, verified, unit-consistent and
 * dated in the past; products that carry iron or need pregnancy/nursing review
 * cannot be auto-selected; offers point at approved products over https and
 * counts agree; knowledge aliases resolve to known markers. The report binds to
 * the exact prepared bytes (`payloadSha256`) and carries its own digest
 * (`evidenceSha256`) so a human approval can reference it. It approves nothing
 * and activates nothing. */
const text = (max: number) => z.string().trim().min(1).max(max);
const datetime = z.string().datetime();
export const markerExclusionSchema = z.object({ marker: text(160), reason: text(1000), reviewedBy: text(160), reviewedAt: datetime,
  populations: z.array(text(240)).max(20).optional() }).strict();
export const regressionInputsSchema = z.object({
  exclusions: z.array(markerExclusionSchema).max(500),
  requiredPopulations: z.array(z.object({ label: text(240), sex: z.enum(["female", "male", "other"]), ageYears: z.number().int().min(0).max(125) }).strict()).max(20)
    .default([{ label: "adult female", sex: "female", ageYears: 40 }, { label: "adult male", sex: "male", ageYears: 40 }]),
  catalog: z.unknown().nullable().default(null),
  knowledgeRelease: z.unknown().nullable().default(null),
}).strict();
export type RegressionInputs = z.infer<typeof regressionInputsSchema>;
const catalogSchema = z.object({
  products: z.array(z.object({ stableId: text(200), displayName: text(400), productType: text(80), accessTier: text(40), declaredRestricted: z.boolean(),
    directOrderAllowed: z.boolean(), clinicalPayload: z.record(z.string(), z.unknown()) }).passthrough()).max(5000),
  commercialOffers: z.array(z.object({ stableId: text(200), productStableId: text(200), destinationUrl: z.string().max(2048), declaredRestricted: z.boolean(),
    directOrderAllowed: z.boolean() }).passthrough()).max(5000),
  counts: z.object({ products: z.number().int().nonnegative(), commercialOffers: z.number().int().nonnegative() }).partial().optional(),
}).passthrough();
const knowledgeSchema = z.object({ entries: z.array(z.object({ id: text(120), biomarkerAliases: z.array(text(160)).max(40), reviewStatus: z.string(), contested: z.boolean() }).passthrough()).max(1000) }).passthrough();
export type RegressionCheck = { id: string; status: "pass" | "fail" | "not_applicable"; findings: string[] };
export type ClinicalSafetyRegressionReport = {
  contract: "clinical-safety-regression/1"; status: "pass" | "fail"; payloadSha256: string | null; releaseVersion: string | null;
  ranges: number; inputMarkers: number; checks: RegressionCheck[]; evidenceSha256: string;
  /** Always true: this tool reports; a human approves; the authorized operator pins. */
  approvalPerformed: false; activationPerformed: false;
};
const normalize = (value: string) => value.trim().toLowerCase().replace(/[µμ]/g, "u").replace(/[^a-z0-9%/.+-]+/g, " ").replace(/\s+/g, " ").trim();
const IRON = /\b(iron|ferrous|ferric|heme)\b/i, REPRODUCTIVE = /\b(pregnan|nursing|lactat|breastfeed|fertil|conception|trimester)/i;
function check(id: string, findings: string[], applicable = true): RegressionCheck {
  return { id, status: applicable ? (findings.length ? "fail" : "pass") : "not_applicable", findings: findings.slice(0, 200) };
}
function releaseBytes(release: PreciseLabRangeRelease) { const payload = JSON.stringify(release); return { payload, payloadSha256: createHash("sha256").update(payload).digest("hex") }; }
function markerMatches(range: PreciseLabRange, names: Set<string>) { return [range.canonicalName, ...range.aliases].some(alias => names.has(normalize(alias))); }
function ageMatches(range: PreciseLabRange, ageYears: number) {
  const a = range.population.age, factor = a.unit === "years" ? 1 : a.unit === "months" ? 12 : 365.25, value = ageYears * factor;
  return (a.minInclusive ? value >= a.min : value > a.min) && (a.maxInclusive ? value <= a.max : value < a.max);
}
export function runClinicalSafetyRegression(prepared: unknown, inputsValue: unknown, now = Date.now()): ClinicalSafetyRegressionReport {
  const checks: RegressionCheck[] = [];
  const parsedRelease = preciseLabRangeReleaseSchema.safeParse(prepared), inputs = regressionInputsSchema.safeParse(inputsValue);
  const finish = (payloadSha256: string | null, releaseVersion: string | null, ranges: number, inputMarkers: number): ClinicalSafetyRegressionReport => {
    const body = { contract: "clinical-safety-regression/1" as const, status: checks.every(c => c.status !== "fail") ? "pass" as const : "fail" as const,
      payloadSha256, releaseVersion, ranges, inputMarkers, checks, approvalPerformed: false as const, activationPerformed: false as const };
    return { ...body, evidenceSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  };
  if (!inputs.success) { checks.push(check("regression_inputs_valid", ["regression inputs are not the documented shape"])); return finish(null, null, 0, 0); }
  if (!parsedRelease.success) { checks.push(check("release_schema_valid", ["prepared release is not a valid lab-ranges/2 document"])); return finish(null, null, 0, 0); }
  const release = parsedRelease.data, { payloadSha256 } = releaseBytes(release), e = inputs.data;
  // Every marker the extraction vocabulary or plausibility filter recognizes.
  const markers = [...LAB_INPUT_MARKERS.map(m => ({ name: m.name, names: new Set([m.name, ...m.aliases].map(normalize)), units: new Set(m.units.map(normalize)) })),
    ...LAB_PLAUSIBILITY_MARKERS.filter(name => !LAB_INPUT_MARKERS.some(m => normalize(m.name) === normalize(name)))
      .map(name => ({ name, names: new Set([normalize(name)]), units: null as Set<string> | null }))];
  const excluded = new Map(e.exclusions.map(x => [normalize(x.marker), x] as const));
  // 1. Represented or explicitly excluded with a reviewed reason in the past.
  const coverage: string[] = [];
  for (const marker of markers) {
    const rows = release.ranges.filter(r => markerMatches(r, marker.names)), exclusion = excluded.get(normalize(marker.name));
    if (!rows.length && !exclusion) coverage.push(`marker not represented and not excluded: ${marker.name}`);
    if (exclusion && Date.parse(exclusion.reviewedAt) > now) coverage.push(`exclusion reviewed in the future: ${marker.name}`);
    if (rows.length && exclusion && !exclusion.populations?.length) coverage.push(`marker both represented and wholly excluded: ${marker.name}`);
  }
  for (const x of e.exclusions) if (!markers.some(m => m.names.has(normalize(x.marker)))) coverage.push(`exclusion names an unknown marker: ${x.marker}`);
  checks.push(check("input_markers_represented_or_excluded", coverage));
  // 2. Sourced and verified, dated in the past, unique population per marker/unit/kind.
  const sourcing: string[] = [], seen = new Map<string, string>();
  for (const r of release.ranges) {
    if (r.source.verification !== "V") sourcing.push(`unverified source on ${r.canonicalName}`);
    if (Date.parse(r.source.verifiedOn) > now) sourcing.push(`future verification date on ${r.canonicalName}`);
    if (Date.parse(r.reviewedAt) > now) sourcing.push(`future review date on ${r.canonicalName}`);
    const key = JSON.stringify([normalize(r.canonicalName), normalize(r.unit), r.rangeKind, r.population]);
    if (seen.has(key)) sourcing.push(`duplicate population band on ${r.canonicalName} (${seen.get(key)} and ${r.id})`); else seen.set(key, r.id);
  }
  if (Date.parse(release.expiresAt) <= now) sourcing.push("release already expired");
  checks.push(check("ranges_sourced_verified_and_dated", sourcing));
  // 3. Units belong to the extraction vocabulary for that marker.
  const units: string[] = [];
  for (const marker of markers) {
    if (!marker.units) continue;
    for (const r of release.ranges.filter(r => markerMatches(r, marker.names))) if (!marker.units.has(normalize(r.unit))) units.push(`unit ${r.unit} on ${r.canonicalName} is not an accepted extraction unit for ${marker.name}`);
  }
  checks.push(check("units_match_extraction_vocabulary", units));
  // 4. Required populations covered for every represented functional-target marker unless excluded for that population.
  const populations: string[] = [];
  for (const marker of markers) {
    const rows = release.ranges.filter(r => markerMatches(r, marker.names) && r.rangeKind === "functional_target");
    if (!rows.length) continue;
    const exclusion = excluded.get(normalize(marker.name));
    for (const population of e.requiredPopulations) {
      if (exclusion?.populations?.some(p => normalize(p) === normalize(population.label))) continue;
      const covered = rows.some(r => r.population.sexes.includes(population.sex) && r.population.pregnancyStatuses.includes("not_applicable") && ageMatches(r, population.ageYears));
      if (!covered) populations.push(`${marker.name} has no functional target for ${population.label} (not pregnant)`);
    }
  }
  checks.push(check("required_populations_covered", populations));
  // 5. Catalog: iron or reproductive caution never auto-selectable; offers point at approved products over https; counts agree.
  if (e.catalog === null) checks.push(check("catalog_iron_and_reproductive_exclusions", ["catalog manifest not supplied"], false), check("offers_and_counts_agree", ["catalog manifest not supplied"], false));
  else {
    const catalog = catalogSchema.safeParse(e.catalog);
    if (!catalog.success) { checks.push(check("catalog_iron_and_reproductive_exclusions", ["catalog manifest is not the documented shape"])); checks.push(check("offers_and_counts_agree", ["catalog manifest is not the documented shape"])); }
    else {
      const products = catalog.data.products, byId = new Map(products.map(p => [p.stableId, p]));
      const eligibility: string[] = [];
      for (const p of products) {
        const payload = p.clinicalPayload, textOf = (key: string) => JSON.stringify(payload[key] ?? "");
        const iron = IRON.test(p.displayName) || IRON.test(textOf("ingredients")), reproductive = REPRODUCTIVE.test(textOf("cautionFlags")) || REPRODUCTIVE.test(textOf("restrictions"));
        const rules = Array.isArray(payload.contraindicationRuleIds) ? payload.contraindicationRuleIds.length : 0;
        if (payload.autoSelectionEligible === true && (iron || reproductive || p.declaredRestricted || p.accessTier !== "open"))
          eligibility.push(`auto-selectable despite ${iron ? "iron content" : reproductive ? "pregnancy or nursing caution" : "restriction"}: ${p.stableId}`);
        if (iron && rules === 0 && !REPRODUCTIVE.test(textOf("cautionFlags")) && !/\biron\b/i.test(textOf("cautionFlags")))
          eligibility.push(`iron-containing product carries no contraindication rule or iron caution flag: ${p.stableId}`);
      }
      checks.push(check("catalog_iron_and_reproductive_exclusions", eligibility));
      const offers: string[] = [];
      for (const offer of catalog.data.commercialOffers) {
        const product = byId.get(offer.productStableId);
        if (!product) { offers.push(`offer without an approved product: ${offer.stableId}`); continue; }
        let url: URL | null = null; try { url = new URL(offer.destinationUrl); } catch { url = null; }
        if (!url || url.protocol !== "https:" || url.username || url.password) offers.push(`offer destination is not a plain https url: ${offer.stableId}`);
        if (offer.directOrderAllowed && (!product.directOrderAllowed || product.declaredRestricted)) offers.push(`offer allows direct order for a product that does not: ${offer.stableId}`);
      }
      const counts = catalog.data.counts;
      if (counts?.products !== undefined && counts.products !== products.length) offers.push(`declared product count ${counts.products} differs from ${products.length}`);
      if (counts?.commercialOffers !== undefined && counts.commercialOffers !== catalog.data.commercialOffers.length) offers.push(`declared offer count ${counts.commercialOffers} differs from ${catalog.data.commercialOffers.length}`);
      checks.push(check("offers_and_counts_agree", offers));
    }
  }
  // 6. Knowledge: approved, uncontested entries whose aliases resolve to a recognized marker.
  if (e.knowledgeRelease === null) checks.push(check("knowledge_aliases_resolve", ["reviewed knowledge release not supplied"], false));
  else {
    const knowledge = knowledgeSchema.safeParse(e.knowledgeRelease);
    if (!knowledge.success) checks.push(check("knowledge_aliases_resolve", ["knowledge release is not the documented shape"]));
    else {
      const findings: string[] = [], known = new Set(markers.flatMap(m => [...m.names]));
      for (const entry of knowledge.data.entries) {
        if (entry.reviewStatus !== "approved" || entry.contested) findings.push(`entry not approved or contested: ${entry.id}`);
        const unresolved = entry.biomarkerAliases.filter(a => !known.has(normalize(a)) && !release.ranges.some(r => markerMatches(r, new Set([normalize(a)]))));
        if (unresolved.length === entry.biomarkerAliases.length) findings.push(`no alias resolves to a recognized marker: ${entry.id}`);
      }
      checks.push(check("knowledge_aliases_resolve", findings));
    }
  }
  return finish(payloadSha256, release.version, release.ranges.length, markers.length);
}
