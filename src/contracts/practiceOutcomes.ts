import { z } from 'zod';

/**
 * What happened in this practice: a treatment-outcome ledger that reports only in aggregate.
 *
 * Three rules live in these shapes and no screen may soften any of them.
 *
 * A contribution sends an age in years and gets a band back. There is no field for an exact age,
 * a name, a date or a note, and `stored` says in the response what was not kept.
 *
 * A report carries `interpretation` and a screen must show it. This is one practice's
 * observational record: it can say what happened, never that anything was proven to work.
 *
 * A report carries `suppressedGroups` and a `total` that is null whenever anything was
 * suppressed. A screen that rendered a total it computed itself would undo the suppression.
 */
export const PRACTICE_OUTCOME_ACK = 'practice-outcomes/1' as const;
const uuid = z.string().uuid();
const code = z.string().regex(/^[a-z][a-z0-9_]{2,60}$/);
export const outcomeVocabularyKind = z.enum(['condition', 'treatment']);
export const outcomeAgeBand = z.enum(['18_24', '25_29', '30_34', '35_39', '40_44', '45_49',
  '50_54', '55_59', '60_64', '65_69', '70_74', '75_79', '80_84', '85_89', '90_plus']);
export type OutcomeAgeBand = z.infer<typeof outcomeAgeBand>;
export const outcomeSex = z.enum(['female', 'male', 'intersex', 'not_recorded']);
export const outcomeCode = z.enum(['resolved', 'much_improved', 'improved', 'unchanged', 'worse',
  'stopped_side_effects', 'stopped_cost', 'lost_to_follow_up']);
export type OutcomeCode = z.infer<typeof outcomeCode>;
export const outcomeFollowupBand = z.enum(['under_6_weeks', '6_to_12_weeks', '3_to_6_months',
  '6_to_12_months', 'over_12_months']);
export const outcomeReportDimension = z.enum(['treatment', 'ageBand', 'sex', 'followupBand']);
export type OutcomeReportDimension = z.infer<typeof outcomeReportDimension>;

export const outcomeLedgerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('vocabulary') }).strict(),
  z.object({ action: z.literal('declare_code'), kind: outcomeVocabularyKind, code, label: z.string().trim().min(1).max(160) }).strict(),
  z.object({ action: z.literal('retire_code'), kind: outcomeVocabularyKind, code }).strict(),
  z.object({
    // Age in years, banded by the clinic. There is no field for anything narrower.
    action: z.literal('contribute'), connectionId: uuid, ageYears: z.number().int().min(18).max(130),
    sex: outcomeSex, conditionCodes: z.array(code).min(1).max(5), treatmentCode: code,
    outcomeCode, followupBand: outcomeFollowupBand,
  }).strict(),
]);
export type OutcomeLedgerRequest = z.infer<typeof outcomeLedgerRequest>;

export const outcomeLedgerResponse = z.union([
  z.object({
    action: z.literal('vocabulary'), codes: z.array(z.object({
      kind: outcomeVocabularyKind, code, label: z.string(), status: z.enum(['active', 'retired']),
    }).strict()).max(500),
  }).strict(),
  z.object({ action: z.literal('declare_code'), kind: outcomeVocabularyKind, code, status: z.literal('active') }).strict(),
  z.object({ action: z.literal('retire_code'), kind: outcomeVocabularyKind, code, status: z.literal('retired') }).strict(),
  z.object({
    action: z.literal('contribute'), observationId: uuid, ageBand: outcomeAgeBand,
    // What the clinic states it did not keep. Shown, not assumed.
    stored: z.object({ exactAgeKept: z.literal(false), freeTextKept: z.literal(false), dateKept: z.literal(false) }).strict(),
  }).strict(),
]);
export type OutcomeLedgerResponse = z.infer<typeof outcomeLedgerResponse>;

export const outcomeReportRequest = z.object({
  action: z.literal('report'),
  // At most two extra dimensions. Outcome is always one, and there is no time dimension at all.
  groupBy: z.array(outcomeReportDimension).max(2),
  conditionCode: code.optional(), treatmentCode: code.optional(),
}).strict();
export type OutcomeReportRequest = z.infer<typeof outcomeReportRequest>;

export const outcomeReportResponse = z.object({
  action: z.literal('report'),
  groups: z.array(z.object({
    outcome: outcomeCode, treatment: code.nullable(), ageBand: outcomeAgeBand.nullable(),
    sex: outcomeSex.nullable(), followupBand: outcomeFollowupBand.nullable(),
    count: z.number().int().min(1),
  }).strict()).max(500),
  suppressedGroups: z.number().int().min(0),
  /** Null whenever anything was suppressed, so the gap cannot be recovered by subtraction. */
  total: z.number().int().min(0).nullable(),
  minimumCohort: z.number().int().positive(),
  interpretation: z.literal('what_happened_in_this_practice_not_evidence_of_efficacy'),
}).strict();
export type OutcomeReportResponse = z.infer<typeof outcomeReportResponse>;

const bind = <Request extends { action: string }, Response extends { action: string }>(
  schema: z.ZodType<Response>, request: Request, raw: unknown,
): Response => {
  const parsed = schema.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  return parsed;
};
export const parseOutcomeLedgerResponse = (request: OutcomeLedgerRequest, raw: unknown) =>
  bind(outcomeLedgerResponse, request, raw);
export const parseOutcomeReportResponse = (request: OutcomeReportRequest, raw: unknown) =>
  bind(outcomeReportResponse, request, raw);

/** What each outcome means, in the words a practitioner would use. */
export const OUTCOME_LABEL: Record<OutcomeCode, string> = {
  resolved: 'Resolved',
  much_improved: 'Much improved',
  improved: 'Improved',
  unchanged: 'Unchanged',
  worse: 'Worse',
  stopped_side_effects: 'Stopped — side effects',
  stopped_cost: 'Stopped — cost',
  lost_to_follow_up: 'Lost to follow-up',
};
export const AGE_BAND_LABEL = (band: OutcomeAgeBand) =>
  band === '90_plus' ? '90 and over' : band.replace('_', '–');
/** The sentence a screen must show beside any count from this ledger. */
export const OUTCOME_INTERPRETATION =
  'This is what happened in this practice. It is not evidence that a treatment works: these are '
  + 'the people who came here and came back, the treatment was chosen by the same person who '
  + 'recorded the result, and nothing here is controlled or compared.';
