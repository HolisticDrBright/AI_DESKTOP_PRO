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

/**
 * One list per program. The keys are the program keys the funnel pages link with (`updates.programKey`,
 * equal to each funnel's slug), so "Get updates" on a program page always lands on that program's list.
 */
export const LEAD_PROGRAMS = ['longevity-program', 'weight-loss-program', 'diabetes-program'] as const;
export type LeadProgram = (typeof LEAD_PROGRAMS)[number];
export const LEAD_PROGRAM_LABEL: Record<LeadProgram, string> = {
  'longevity-program': 'Longevity Program',
  'weight-loss-program': 'Weight loss program',
  'diabetes-program': 'Diabetes program',
};

/**
 * The sending settings Brandon decides. None has a default: while any is unset (or the approved text
 * version is not the current one) the campaign service sends nothing at all, and says which by name.
 * Their values never leave the service; only the names of the missing ones do.
 */
export const CAMPAIGN_SEND_SETTINGS = [
  'CAMPAIGN_SENDING_SUBDOMAIN', 'CAMPAIGN_FROM_NAME', 'CAMPAIGN_MAILING_ADDRESS', 'CAMPAIGN_TRACKING', 'CAMPAIGN_APPROVED_TEXT_VERSION',
] as const;
export type CampaignSendSetting = (typeof CAMPAIGN_SEND_SETTINGS)[number];
/**
 * The version of every word the service itself sends or shows before a confirmation (the consent line,
 * the sign-up page and the confirmation email). `CAMPAIGN_APPROVED_TEXT_VERSION` must name exactly this
 * version: changing the wording changes the version, and a send stays refused until the new wording is
 * approved.
 */
export const CAMPAIGN_TEXT_VERSION = 'lead-signup-text/1' as const;

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
  /** Whether the service may send, and if not, which settings are missing (names only, never values). */
  sending: z.object({ ready: z.boolean(), missing: z.array(z.enum(CAMPAIGN_SEND_SETTINGS)).max(CAMPAIGN_SEND_SETTINGS.length) }).strict()
    .refine(s => s.ready === (s.missing.length === 0), { message: 'ready exactly when nothing is missing' }),
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
