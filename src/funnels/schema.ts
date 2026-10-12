import { z } from 'zod';

/**
 * A program lead funnel: a public page made of fixed sections that sells a built program and
 * ends in the clinic's existing consult link. The definition is the whole page. It is typed and
 * validated here, imports nothing clinical, reads no data at render time, and carries no form,
 * embed, script, image address or testimonial: a visitor can read it and follow one link.
 *
 * Text rules are enforced by shape, not by review alone. No address of any kind appears in the
 * copy (the only outbound link is built from the configured site origin), no markup, no dose,
 * no drug or brand name, no promised amount or speed of change, and no claim to cure, reverse or
 * treat a condition. A funnel is `published` only when its "what is included" section was filled
 * from the real program and Brandon approved the exact text; until then it is `draft` and the
 * public route answers not-found for it exactly as for an unknown slug.
 */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/);

const FORBIDDEN: Array<[RegExp, string]> = [
  [/https?:\/\/|www\.|\.com\b|\.net\b|\.org\b/i, 'no address of any kind in funnel copy'],
  [/[<>]/, 'no markup in funnel copy'],
  [/\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|iu|ml|units?)\b/i, 'no dose on a public page'],
  // A guarantee is refused; saying that something is NOT guaranteed is required on the weight loss page and allowed.
  [/\b(?:cure|cures|cured|curing|reverse|reverses|reversed|reversing)\b|(?<!\bnot |\bno )\b(?:guarantee|guaranteed|guarantees)\b/i, 'no claim to cure, reverse or guarantee'],
  [/\b\d+(?:\.\d+)?\s?(?:lb|lbs|pounds?|kg|kilograms?|%|percent)(?![a-z])/i, 'no promised amount of change'],
  [/\b(?:years? younger|add(?:s|ed)? years|live longer|extra years)\b/i, 'no claim of added years or reversed age'],
  [/\b(?:semaglutide|tirzepatide|liraglutide|retatrutide|ozempic|wegovy|mounjaro|zepbound|saxenda|metformin|insulin|glp-?1|peptide-?\w*\s?\d)\b/i, 'no drug or brand name on a public page'],
  [/\b(?:stop|change|adjust)\s+(?:your|their)?\s*(?:medication|medicine|insulin|prescription)s?\b/i, 'no suggestion to change or stop medication'],
];
export function funnelTextIssue(text: string): string | null {
  for (const [pattern, issue] of FORBIDDEN) if (pattern.test(text)) return issue;
  return null;
}
const copy = (max: number) => z.string().trim().min(1).max(max).superRefine((value, ctx) => {
  const issue = funnelTextIssue(value);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});
const lines = (max: number, each = 240) => z.array(copy(each)).min(1).max(max);

export const FUNNEL_SECTION_KINDS = ['hero', 'who-it-is-for', 'what-is-included', 'how-it-works', 'practitioner', 'faq', 'call-to-action'] as const;
export type FunnelSectionKind = typeof FUNNEL_SECTION_KINDS[number];

export const funnelSection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hero'), heading: copy(120), lead: copy(400) }).strict(),
  z.object({ kind: z.literal('who-it-is-for'), heading: copy(120), fits: lines(8), notFor: lines(6).optional() }).strict(),
  z.object({
    kind: z.literal('what-is-included'), heading: copy(120),
    /** `published_program`: every item was read from the real, published program. `pending`: the program has not been read yet; the page cannot publish. */
    source: z.enum(['published_program', 'pending']),
    items: z.array(copy(240)).max(12),
    note: copy(400).optional(),
  }).strict().refine(s => s.source === 'pending' ? s.items.length === 0 : s.items.length > 0, { message: 'what-is-included items come from the published program, or the section is pending' }),
  z.object({ kind: z.literal('how-it-works'), heading: copy(120), steps: z.array(z.object({ title: copy(80), detail: copy(300) }).strict()).min(2).max(6) }).strict(),
  z.object({ kind: z.literal('practitioner'), heading: copy(120), name: copy(80), credentials: copy(160), about: copy(600) }).strict(),
  z.object({ kind: z.literal('faq'), heading: copy(120), questions: z.array(z.object({ question: copy(160), answer: copy(600) }).strict()).min(1).max(10) }).strict(),
  z.object({ kind: z.literal('call-to-action'), heading: copy(120), detail: copy(300), buttonLabel: copy(40) }).strict(),
]);
export type FunnelSection = z.infer<typeof funnelSection>;

export const funnelDefinition = z.object({
  slug,
  status: z.enum(['draft', 'published']),
  title: copy(80),
  description: copy(200),
  /** Brandon's decision for these three: search engines may list them. The runtime still serves noindex outside the production origin. */
  indexable: z.boolean(),
  /** Display text only; never a lookup against program data. */
  programLabel: copy(80),
  /** The consult link this funnel hands off to; one of the page's two destinations. */
  consultSlug: slug,
  /**
   * The program this page sells, by clinic and program id, or null while Brandon has not named one. The
   * purchase choice reads the program's offer through this binding and nothing else: a slug or a title is
   * not a product identity, and an unbound page cannot be bought from.
   */
  programBinding: z.object({ organizationId: z.string().uuid(), programId: z.string().uuid() }).strict().nullable(),
  sections: z.array(funnelSection).min(3).max(7),
  /** Who approved the exact published text and when; required to publish. */
  approval: z.object({ by: copy(80), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), attorneyReview: z.boolean() }).strict().nullable(),
  /** Why this funnel is still a draft, in words the Funnels screen shows. */
  draftNote: copy(300).nullable(),
}).strict().superRefine((funnel, ctx) => {
  const kinds = funnel.sections.map(s => s.kind);
  if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', message: 'each section kind appears at most once' });
  for (const required of ['hero', 'call-to-action'] as const) if (!kinds.includes(required)) ctx.addIssue({ code: 'custom', message: `a funnel needs a ${required} section` });
  const included = funnel.sections.find(s => s.kind === 'what-is-included');
  if (funnel.status === 'published') {
    if (!funnel.approval) ctx.addIssue({ code: 'custom', message: 'a published funnel records who approved its exact text' });
    if (['weight-loss-program', 'diabetes-program'].includes(funnel.slug) && funnel.approval?.attorneyReview !== true) {
      ctx.addIssue({ code: 'custom', message: 'this program requires its recorded attorney review before publication' });
    }
    if (!included || included.source !== 'published_program') ctx.addIssue({ code: 'custom', message: 'a published funnel describes what the real program includes' });
    if (funnel.draftNote !== null) ctx.addIssue({ code: 'custom', message: 'a published funnel carries no draft note' });
  } else if (funnel.draftNote === null) ctx.addIssue({ code: 'custom', message: 'a draft says why it is a draft' });
});
export type FunnelDefinition = z.infer<typeof funnelDefinition>;
