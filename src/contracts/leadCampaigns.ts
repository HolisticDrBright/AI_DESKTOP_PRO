import { z } from 'zod';

/**
 * Lead campaigns (lead-campaigns/1): email updates for people who are NOT patients yet and asked to
 * hear about one program. This is commercial data. It lives only in the campaign service (Dittofeed
 * beside the Desktop, plus the small sign-up service in src/lead-signup/); nothing here is read from or
 * written to a clinical store, and the Desktop sees counts only.
 *
 * Getting on a list takes two explicit acts: an unticked consent box on the sign-up page, and a click
 * on the link in the confirmation email (which opens a page with a button, so a mail scanner that
 * follows links cannot confirm on the reader's behalf). Nobody is known to the campaign service until
 * they confirm.
 */
export const LEAD_CAMPAIGNS_CONTRACT = 'lead-campaigns/1' as const;

/** One list per program; the keys are the funnel slugs. */
export const LEAD_PROGRAMS = ['longevity-program', 'weight-loss-peptide-program', 'diabetes-program'] as const;
export type LeadProgram = (typeof LEAD_PROGRAMS)[number];
export const LEAD_PROGRAM_LABEL: Record<LeadProgram, string> = {
  'longevity-program': 'Longevity Program',
  'weight-loss-peptide-program': 'Weight loss program',
  'diabetes-program': 'Diabetes program',
};

/**
 * The consent line, DRAFT until Brandon approves it (and his attorney for the weight loss and diabetes
 * programs). Its version is recorded with every confirmation.
 */
export const LEAD_CONSENT_VERSION = 'lead-signup-consent/1' as const;
export function leadConsentText(program: LeadProgram): string {
  return `Email me updates about the ${LEAD_PROGRAM_LABEL[program]}: what it involves and how to request a consultation. I can unsubscribe at any time.`;
}

/** The sign-up form: an address, an optional first name, the program, and the box. No health questions, no free text. */
export const leadSignupForm = z.object({
  email: z.string().trim().toLowerCase().max(254).regex(/^[^\s@<>()"',;:\\[\]]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/),
  firstName: z.string().trim().max(40).regex(/^(|[\p{L}][\p{L} '-]{0,39})$/u).transform(v => v || null),
  program: z.enum(LEAD_PROGRAMS),
  consent: z.literal('yes'),
}).strict();
export type LeadSignup = z.infer<typeof leadSignupForm>;

/** What the campaign service tells the Desktop: counts and send totals, never a person. */
const count = z.number().int().min(0);
export const campaignCounts = z.object({
  contract: z.literal(LEAD_CAMPAIGNS_CONTRACT),
  lists: z.array(z.object({ program: z.enum(LEAD_PROGRAMS), confirmed: count }).strict()).length(LEAD_PROGRAMS.length),
  recentSends: z.array(z.object({
    name: z.string().min(1).max(120),
    sentAt: z.string().datetime({ offset: true }).nullable(),
    delivered: count, bounced: count,
    /** Dittofeed's summary has no unsubscribe count; null renders as Unknown, never as zero. */
    unsubscribed: count.nullable(),
  }).strict()).max(20),
}).strict();
export type CampaignCounts = z.infer<typeof campaignCounts>;
