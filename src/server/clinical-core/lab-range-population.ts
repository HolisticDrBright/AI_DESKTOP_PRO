import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const sex = z.enum(["male", "female", "other"]);
const pregnancy = z.enum(["not_pregnant", "pregnant", "unsure", "not_applicable"]);
const phase = z.enum(["menstrual", "follicular", "ovulatory", "luteal", "not_applicable"]);
const stage = z.enum(["prepubertal", "reproductive", "irregular_cycles", "perimenopause", "menopause", "pregnant", "postpartum"]);
const contraception = z.enum(["none", "hormonal", "non_hormonal"]);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
/** Shared dimension vocabularies so stored owner context cannot drift from range populations. */
export const collectionDimensions = { sex, pregnancy, phase, stage, contraception } as const;

// Context must describe THIS observation, not today's profile. Null means unknown.
// Source status is retained as reported, never upgraded to clinical verification.
export const collectionRangeContextSchema = z.object({
  dateOfBirth: calendarDate,
  observedOn: calendarDate,
  sex: sex.nullable(),
  pregnancyStatus: pregnancy.nullable(),
  cyclePhase: phase.nullable(),
  reproductiveStage: stage.nullable(),
  contraception: contraception.nullable(),
  pregnancyTrimester: z.number().int().min(1).max(3).nullable(),
  assayId: text(160).nullable(),
}).strict().refine(row => row.dateOfBirth <= row.observedOn, "observation_precedes_birth")
  .refine(row => row.pregnancyTrimester === null || row.pregnancyStatus === "pregnant", "trimester_requires_pregnancy");
export type CollectionRangeContext = z.infer<typeof collectionRangeContextSchema>;

export const preciseLabRangeSchema = z.object({
  id: z.string().uuid(), canonicalName: text(160), aliases: z.array(text(160)).max(40).refine(unique), unit: text(80),
  rangeKind: z.enum(["functional_target", "conventional_reference"]),
  min: z.number().finite(), max: z.number().finite(),
  population: z.object({
    label: text(240),
    age: z.object({ unit: z.enum(["days", "months", "years"]), min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(), minInclusive: z.boolean(), maxInclusive: z.boolean() }).strict()
      .refine(age => age.min <= age.max && (age.min !== age.max || (age.minInclusive && age.maxInclusive)))
      .refine(age => age.max <= ({ days: 46000, months: 1500, years: 125 })[age.unit]),
    sexes: z.array(sex).min(1).max(3).refine(unique),
    pregnancyStatuses: z.array(pregnancy).min(1).max(4).refine(unique),
    // Null explicitly means the reviewed interval does not require that dimension.
    cyclePhases: z.array(phase).min(1).max(5).refine(unique).nullable(),
    reproductiveStages: z.array(stage).min(1).max(7).refine(unique).nullable(),
    contraceptions: z.array(contraception).min(1).max(3).refine(unique).nullable(),
    pregnancyTrimesters: z.array(z.number().int().min(1).max(3)).min(1).max(3).refine(unique).nullable(),
    assayIds: z.array(text(160)).min(1).max(30).refine(unique).nullable(),
  }).strict(),
  source: z.object({ id: z.string().uuid(), version: text(80), url: text(2048).url().refine(value => {
    const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password;
  }), packageSha256: sha, recordId: text(160), recordSha256: sha, verification: z.literal("V"),
  verifiedBy: text(160), verifiedOn: calendarDate, verifiedAgainst: text(1000) }).strict(),
  reviewedBy: text(160), reviewedAt: z.string().datetime(),
}).strict().refine(row => row.min < row.max)
  .refine(row => row.population.pregnancyTrimesters === null
    || (row.population.pregnancyStatuses.length === 1 && row.population.pregnancyStatuses[0] === "pregnant"));
export const preciseLabRangeReleaseSchema = z.object({
  schemaVersion: z.literal("lab-ranges/2"), version: text(80), expiresAt: z.string().datetime(),
  ranges: z.array(preciseLabRangeSchema).max(5000),
}).strict().refine(release => unique(release.ranges.map(row => row.id)));
export type PreciseLabRange = z.infer<typeof preciseLabRangeSchema>;
export type PreciseLabRangeRelease = z.infer<typeof preciseLabRangeReleaseSchema>;

const normalized = (value: string) => value.trim().toLowerCase().replace(/[µμ]/g, "u").replace(/\s+/g, " ");
// Calendar anniversaries, NOT 30-day months or 365-day years. Month-end dates clamp
// to that month's last day (including Feb 29 -> Feb 28 in non-leap years).
function boundary(birth: string, amount: number, unit: "days" | "months" | "years") {
  const date = new Date(birth + "T00:00:00.000Z");
  if (unit === "days") return date.getTime() + amount * 86_400_000;
  const month = date.getUTCMonth() + amount * (unit === "years" ? 12 : 1);
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(date.getUTCFullYear(), month + 1, 0);
  const anniversary = new Date(0);
  anniversary.setUTCFullYear(date.getUTCFullYear(), month, Math.min(date.getUTCDate(), monthEnd.getUTCDate()));
  return anniversary.getTime();
}
function includes<T>(allowed: T[] | null, actual: T | null): boolean {
  return allowed === null || (actual !== null && allowed.includes(actual));
}

/** No unit conversion, current-profile fallback, inferred cycle phase or best-guess match. */
export function matchPreciseLabRanges(release: PreciseLabRangeRelease, name: string, unit: string,
  input: unknown, kind: PreciseLabRange["rangeKind"] = "functional_target", now = Date.now()): PreciseLabRange[] {
  const parsed = collectionRangeContextSchema.safeParse(input);
  if (!parsed.success) return [];
  const context = parsed.data, observed = Date.parse(context.observedOn);
  if (observed > now) return [];
  return release.ranges.filter(row => {
    const p = row.population, a = p.age;
    const low = boundary(context.dateOfBirth, a.min, a.unit), high = boundary(context.dateOfBirth, a.max, a.unit);
    return row.rangeKind === kind && [row.canonicalName, ...row.aliases].some(alias => normalized(alias) === normalized(name))
      && normalized(row.unit) === normalized(unit)
      && (a.minInclusive ? observed >= low : observed > low) && (a.maxInclusive ? observed <= high : observed < high)
      && includes(p.sexes, context.sex) && includes(p.pregnancyStatuses, context.pregnancyStatus)
      && includes(p.cyclePhases, context.cyclePhase) && includes(p.reproductiveStages, context.reproductiveStage)
      && includes(p.contraceptions, context.contraception) && includes(p.pregnancyTrimesters, context.pregnancyTrimester)
      && includes(p.assayIds, context.assayId);
  });
}
