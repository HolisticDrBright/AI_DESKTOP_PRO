import { createHash, createPublicKey, verify } from "node:crypto";

export type RangePopulation = { ageYears: number | null; sex: string | null; pregnancyStatus: string | null };
export type ReviewedLabRange = {
  id: string; canonicalName: string; aliases: string[]; unit: string;
  min: number; max: number;
  criticalBelow?: number; criticalAbove?: number;
  population: { label: string; minAge: number; maxAge: number; sexes: string[]; pregnancyStatuses: string[] };
  source: { id: string; version: string; url: string };
  reviewedBy: string; reviewedAt: string;
};
export type LabRangeRelease = { schemaVersion: "lab-ranges/1"; version: string; expiresAt: string; ranges: ReviewedLabRange[] };
export type VerifiedLabRangeRelease = { release: LabRangeRelease; sha256: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const normalized = (value: string) => value.trim().toLowerCase().replace(/[µμ]/g, "u").replace(/\s+/g, " ");
const fail = (): never => { throw new Error("lab_range_release_refused"); };

/** The hash and Ed25519 public key are operator-pinned, never supplied by patients or the model. */
export function verifyLabRangeRelease(envelope: unknown, trusted: { sha256: string; publicKeyPem: string }, now = Date.now()): VerifiedLabRangeRelease {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !/^[a-f0-9]{64}$/.test(trusted.sha256)) return fail();
  const signed = envelope as Record<string, unknown>;
  if (Object.keys(signed).some(key => !["payload", "signature"].includes(key))
    || !text(signed.payload, 2_000_000) || !text(signed.signature, 128)) return fail();
  const payload = Buffer.from(signed.payload, "utf8");
  if (createHash("sha256").update(payload).digest("hex") !== trusted.sha256) return fail();
  try {
    const key = createPublicKey(trusted.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, payload, key, Buffer.from(signed.signature, "base64"))) return fail();
  } catch { return fail(); }
  let release: LabRangeRelease;
  try { release = JSON.parse(signed.payload) as LabRangeRelease; } catch { return fail(); }
  if (!release || release.schemaVersion !== "lab-ranges/1" || !text(release.version, 80)
    || !Number.isFinite(Date.parse(release.expiresAt)) || Date.parse(release.expiresAt) <= now
    || !Array.isArray(release.ranges) || release.ranges.length > 5000) return fail();
  const ids = new Set<string>();
  for (const row of release.ranges) {
    if (!row || !UUID.test(row.id) || ids.has(row.id) || !text(row.canonicalName, 160) || !text(row.unit, 80)
      || !Array.isArray(row.aliases) || row.aliases.length > 40 || !row.aliases.every(alias => text(alias, 160))
      || !Number.isFinite(row.min) || !Number.isFinite(row.max) || row.min >= row.max
      || (row.criticalBelow !== undefined && (!Number.isFinite(row.criticalBelow) || row.criticalBelow >= row.min))
      || (row.criticalAbove !== undefined && (!Number.isFinite(row.criticalAbove) || row.criticalAbove <= row.max))
      || !row.population || !text(row.population.label, 240)
      || !Number.isInteger(row.population.minAge) || !Number.isInteger(row.population.maxAge)
      || row.population.minAge < 0 || row.population.maxAge > 125 || row.population.minAge > row.population.maxAge
      || !Array.isArray(row.population.sexes) || !row.population.sexes.length || !row.population.sexes.every(value => ["male", "female", "other"].includes(value))
      || !Array.isArray(row.population.pregnancyStatuses) || !row.population.pregnancyStatuses.length
      || !row.population.pregnancyStatuses.every(value => ["not_pregnant", "pregnant", "unsure", "not_applicable"].includes(value))
      || !row.source || !UUID.test(row.source.id) || !text(row.source.version, 80) || !text(row.source.url, 2048)
      || !text(row.reviewedBy, 160) || !Number.isFinite(Date.parse(row.reviewedAt)) || Date.parse(row.reviewedAt) > now) return fail();
    try { const url = new URL(row.source.url); if (url.protocol !== "https:" || url.username || url.password) return fail(); } catch { return fail(); }
    ids.add(row.id);
  }
  return { release, sha256: trusted.sha256 };
}

export type RangeResolution = {
  functionalMin: number | null; functionalMax: number | null;
  sourceId: string | null; sourceVersion: string | null; population: string | null;
  rangeReview: "matched" | "no_applicable_reviewed_range" | "ambiguous_reviewed_range";
  criticalBelow: number | null; criticalAbove: number | null;
};

/** Never converts units, assumes age/sex/reproductive state, or resolves conflicts by row order. */
export function resolveReviewedLabRange(catalog: VerifiedLabRangeRelease, name: string, unit: string, population: RangePopulation, now = Date.now()): RangeResolution {
  if (Date.parse(catalog.release.expiresAt) <= now) return fail();
  const empty = { functionalMin: null, functionalMax: null, sourceId: null, sourceVersion: null, population: null, criticalBelow: null, criticalAbove: null };
  const matches = catalog.release.ranges.filter(row => {
    const p = row.population;
    return [row.canonicalName, ...row.aliases].some(alias => normalized(alias) === normalized(name))
      && normalized(row.unit) === normalized(unit)
      && population.ageYears !== null && population.ageYears >= p.minAge && population.ageYears <= p.maxAge
      && population.sex !== null && p.sexes.includes(population.sex)
      && population.pregnancyStatus !== null && p.pregnancyStatuses.includes(population.pregnancyStatus);
  });
  if (matches.length !== 1) return { ...empty, rangeReview: matches.length ? "ambiguous_reviewed_range" : "no_applicable_reviewed_range" };
  const row = matches[0];
  return { functionalMin: row.min, functionalMax: row.max, sourceId: row.source.id, sourceVersion: row.source.version,
    population: row.population.label, rangeReview: "matched", criticalBelow: row.criticalBelow ?? null, criticalAbove: row.criticalAbove ?? null };
}
