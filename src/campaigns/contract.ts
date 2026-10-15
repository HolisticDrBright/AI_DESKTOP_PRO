import { z } from 'zod';

/**
 * campaign-engine/1: email campaigns to people who are NOT patients yet, built into Desktop Pro on Amazon SES and
 * serving many practices from one deployment, each kept separate.
 *
 * This is COMMERCIAL data. Nothing here names, reads or imports anything clinical: no patient, chart, consult
 * request, consent, connection or appointment. A practice is identified by its organization id, which the
 * campaign API takes from the verified workforce token, never from a request body.
 *
 * Content rules (the funnel rules) apply to every email: no outcome guarantee, no claim to treat, cure or
 * reverse, no drug or brand name, no dose, no promised change. Every email links only to its program's page
 * (`?via=email`) and the unsubscribe page; the only value filled in from the reader is the first name.
 */
export const CAMPAIGN_ENGINE_CONTRACT = 'campaign-engine/1' as const;

export const CAMPAIGN_PROGRAMS = ['longevity-program', 'weight-loss-program', 'diabetes-program'] as const;
export type CampaignProgram = (typeof CAMPAIGN_PROGRAMS)[number];
export const CAMPAIGN_PROGRAM_LABEL: Readonly<Record<CampaignProgram, string>> = Object.freeze({
  'longevity-program': 'Longevity Program',
  'weight-loss-program': 'weight loss program',
  'diabetes-program': 'diabetes program',
});
export const campaignProgram = z.enum(CAMPAIGN_PROGRAMS);

/** The tiers that carry the marketing package (Growth, Complete, or the add-on on Essentials). Allowances are data. */
export const MARKETING_TIERS = ['addon', 'growth', 'complete'] as const;
export type MarketingTier = (typeof MARKETING_TIERS)[number];

/** The sign-up consent line, versioned. A DRAFT for Brandon and his attorney: the practice name and program fill it in. */
export const CAMPAIGN_CONSENT_VERSION = 'campaign-consent/1' as const;
export function consentLine(practiceName: string, programLabel: string): string {
  return `Yes, email me about the ${programLabel} from ${practiceName}: a few welcome emails and occasional updates. I can stop at any time.`;
}

export const uuid = z.string().uuid();
export const practiceSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/);
export const emailAddress = z.string().trim().toLowerCase().max(254).regex(/^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);
/** A first name only: letters, spaces, hyphens and apostrophes. No free text reaches a list. */
export const firstName = z.string().trim().min(1).max(40).regex(/^[\p{L}][\p{L} '’-]*$/u);
export const timeZone = z.string().min(3).max(64).refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, 'time_zone_invalid');
const isoTime = z.string().datetime({ offset: true });
const domainName = z.string().trim().toLowerCase().max(200).regex(/^(?=.{4,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/);
const personName = z.string().trim().min(2).max(80).regex(/^[\p{L}][\p{L} .'’-]*$/u);

/* ------------------------------------------------------------------------------------------ templates */

/** Block-based email. A button always leads to the program's page (`?via=email`): there is no free link. */
export const emailBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('button'), label: z.string().trim().min(1).max(60) }).strict(),
  /** An image hosted by Desktop for this practice; `path` is the Desktop's own asset path, never an outside host. */
  z.object({ type: z.literal('image'), path: z.string().regex(/^\/campaign-images\/[0-9a-f-]{36}\/[a-f0-9]{64}\.(?:png|jpg)$/), alt: z.string().trim().min(1).max(200) }).strict(),
]);
export type EmailBlock = z.infer<typeof emailBlock>;
export const templateDraft = z.object({
  programKey: campaignProgram,
  kind: z.enum(['sequence', 'broadcast']),
  name: z.string().trim().min(1).max(80),
  subject: z.string().trim().min(1).max(150),
  blocks: z.array(emailBlock).min(1).max(30),
}).strict();
export type TemplateDraft = z.infer<typeof templateDraft>;
export const approvalRecord = z.object({
  version: z.number().int().min(1), at: isoTime,
  by: z.object({ personId: uuid, name: personName }).strict(),
  attorney: z.object({ name: personName, at: isoTime }).strict().nullable(),
}).strict();
export const emailTemplate = templateDraft.extend({
  templateId: uuid, version: z.number().int().min(1),
  status: z.enum(['draft', 'approved']),
  updatedAt: isoTime,
  /** Recorded for the version it names; an edit makes a new version and returns the template to draft. */
  attorneySignoff: z.object({ version: z.number().int().min(1), name: personName, at: isoTime }).strict().nullable(),
  approval: approvalRecord.nullable(),
}).strict();
export type EmailTemplate = z.infer<typeof emailTemplate>;

/* ------------------------------------------------------------------------------------------ sequences and broadcasts */

export const sequenceStep = z.object({ stepId: uuid, templateId: uuid, waitDays: z.number().int().min(0).max(60) }).strict();
export const emailSequence = z.object({
  programKey: campaignProgram, version: z.number().int().min(0),
  status: z.enum(['draft', 'active', 'paused']),
  steps: z.array(sequenceStep).max(10),
  updatedAt: isoTime.nullable(),
}).strict();
export type EmailSequence = z.infer<typeof emailSequence>;
export const broadcast = z.object({
  broadcastId: uuid, programKey: campaignProgram, templateId: uuid,
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']),
  sendAt: isoTime.nullable(),
  /** The test send the staff member received first, for the template version it names. */
  testSent: z.object({ at: isoTime, templateVersion: z.number().int().min(1) }).strict().nullable(),
  createdAt: isoTime,
}).strict();
export type Broadcast = z.infer<typeof broadcast>;

/* ------------------------------------------------------------------------------------------ the practice */

export const practiceSettings = z.object({
  practiceId: uuid,
  joinSlug: practiceSlug.nullable(),
  /** Printed in every footer; every one of these is a setting with no default. */
  senderName: z.string().trim().min(2).max(80).regex(/^[^<>@"\r\n]+$/).nullable(),
  mailingAddress: z.string().trim().min(10).max(300).regex(/^[^<>\r]+$/).nullable(),
  sendingDomain: domainName.nullable(),
  timeZone: timeZone.nullable(),
  /** Opens and clicks are counted only when this is on; never shown per person. Off by default. */
  trackOpensAndClicks: z.boolean(),
  /** Programs whose emails also need an attorney's sign-off before approval (set by the operator for Brandon's practice). */
  attorneySignoffPrograms: z.array(campaignProgram),
  version: z.number().int().min(0),
}).strict();
export type PracticeSettings = z.infer<typeof practiceSettings>;
export function emptySettings(practiceId: string): PracticeSettings {
  return { practiceId, joinSlug: null, senderName: null, mailingAddress: null, sendingDomain: null, timeZone: null,
    trackOpensAndClicks: false, attorneySignoffPrograms: [], version: 0 };
}
export const domainStatus = z.object({
  domain: domainName,
  verifiedForSending: z.boolean(),
  dkim: z.enum(['pending', 'success', 'failed', 'temporary_failure', 'not_started']),
  mailFrom: z.enum(['pending', 'success', 'failed', 'temporary_failure', 'not_started']),
  records: z.array(z.object({ type: z.enum(['CNAME', 'MX', 'TXT']), name: z.string().max(253), value: z.string().max(512), purpose: z.enum(['dkim', 'mail_from', 'spf', 'dmarc']) }).strict()).max(10),
  checkedAt: isoTime,
}).strict();
export type DomainStatus = z.infer<typeof domainStatus>;

export const entitlement = z.object({
  marketing: z.boolean(), tier: z.enum(MARKETING_TIERS).nullable(),
  grantedBy: z.string().min(1).max(80), grantedAt: isoTime,
}).strict();
export type Entitlement = z.infer<typeof entitlement>;
/** Prices and limits change without a release: these are loaded as data by the operator, never written in code. */
export const allowances = z.object({
  version: z.string().regex(/^[a-z0-9.-]{1,32}$/),
  tiers: z.object(Object.fromEntries(MARKETING_TIERS.map(tier => [tier, z.object({ contacts: z.number().int().min(0).max(10_000_000), emailsPerMonth: z.number().int().min(0).max(100_000_000) }).strict()])) as Record<MarketingTier, z.ZodObject<{ contacts: z.ZodNumber; emailsPerMonth: z.ZodNumber }>>).strict(),
}).strict();
export type Allowances = z.infer<typeof allowances>;
export const MARKETING_ROLES = ['marketing', 'marketing_admin'] as const;
export const roleGrant = z.object({ personId: uuid, role: z.enum(MARKETING_ROLES), name: personName, grantedBy: z.string().min(1).max(80), grantedAt: isoTime }).strict();
export type RoleGrant = z.infer<typeof roleGrant>;

export const CONTACT_STATES = ['pending', 'confirmed', 'unsubscribed', 'bounced', 'complained'] as const;
export type ContactState = (typeof CONTACT_STATES)[number];

/* ------------------------------------------------------------------------------------------ the Campaigns screen */

/** Kept as counters on every state change; an unconfirmed address is not on a list and is not counted. */
export const listCounts = z.object({ confirmed: z.number().int().min(0), unsubscribed: z.number().int().min(0), bounced: z.number().int().min(0), complained: z.number().int().min(0) }).strict();
export type ListCounts = z.infer<typeof listCounts>;
export const templateResults = z.object({
  templateId: uuid, sent: z.number().int().min(0), delivered: z.number().int().min(0), bounced: z.number().int().min(0),
  complained: z.number().int().min(0), unsubscribed: z.number().int().min(0),
  /** Null unless the practice counts opens and clicks. Counts only, never per person. */
  opened: z.number().int().min(0).nullable(), clicked: z.number().int().min(0).nullable(),
}).strict();
export const readiness = z.object({ canSend: z.boolean(), missing: z.array(z.string().max(120)).max(12) }).strict();
export const overview = z.object({
  contract: z.literal(CAMPAIGN_ENGINE_CONTRACT),
  entitlement: z.object({ marketing: z.boolean(), tier: z.enum(MARKETING_TIERS).nullable(), contactAllowance: z.number().int().min(0).nullable(), confirmedContacts: z.number().int().min(0) }).strict(),
  role: z.enum(['none', ...MARKETING_ROLES]),
  settings: practiceSettings,
  domain: domainStatus.nullable(),
  readiness,
  lists: z.array(z.object({ programKey: campaignProgram, counts: listCounts }).strict()),
  templates: z.array(emailTemplate).max(200),
  sequences: z.array(emailSequence),
  broadcasts: z.array(broadcast).max(200),
  results: z.array(templateResults).max(200),
}).strict();
export type CampaignOverview = z.infer<typeof overview>;

const version = z.number().int().min(0);
export const workforceRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview') }).strict(),
  z.object({ action: z.literal('contacts'), programKey: campaignProgram, after: z.string().max(200).nullable().optional() }).strict(),
  z.object({ action: z.literal('update_settings'), expectedVersion: version, joinSlug: practiceSlug.nullable(), senderName: practiceSettings.shape.senderName,
    mailingAddress: practiceSettings.shape.mailingAddress, timeZone: timeZone.nullable(), trackOpensAndClicks: z.boolean() }).strict(),
  z.object({ action: z.literal('register_domain'), domain: domainName }).strict(),
  z.object({ action: z.literal('refresh_domain') }).strict(),
  z.object({ action: z.literal('save_template'), templateId: uuid.nullable(), expectedVersion: version, draft: templateDraft }).strict(),
  z.object({ action: z.literal('check_template'), templateId: uuid }).strict(),
  z.object({ action: z.literal('record_attorney_signoff'), templateId: uuid, version: z.number().int().min(1), attorneyName: personName }).strict(),
  z.object({ action: z.literal('approve_template'), templateId: uuid, version: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('save_sequence'), programKey: campaignProgram, expectedVersion: version, steps: z.array(z.object({ stepId: uuid.nullable(), templateId: uuid, waitDays: z.number().int().min(0).max(60) }).strict()).max(10) }).strict(),
  z.object({ action: z.literal('set_sequence_status'), programKey: campaignProgram, expectedVersion: version, status: z.enum(['active', 'paused']) }).strict(),
  z.object({ action: z.literal('save_broadcast'), broadcastId: uuid.nullable(), programKey: campaignProgram, templateId: uuid }).strict(),
  z.object({ action: z.literal('test_send'), templateId: uuid, broadcastId: uuid.nullable() }).strict(),
  z.object({ action: z.literal('schedule_broadcast'), broadcastId: uuid, sendAt: isoTime }).strict(),
  z.object({ action: z.literal('cancel_broadcast'), broadcastId: uuid }).strict(),
  z.object({ action: z.literal('install_starter'), programKey: campaignProgram }).strict(),
  z.object({ action: z.literal('grant_role'), personId: uuid, role: z.enum(MARKETING_ROLES), name: personName }).strict(),
  z.object({ action: z.literal('revoke_role'), personId: uuid }).strict(),
]);
export type WorkforceRequest = z.infer<typeof workforceRequest>;
export const contactsPage = z.object({ action: z.literal('contacts'), programKey: campaignProgram,
  contacts: z.array(z.object({ email: z.string().max(254), firstName: z.string().max(40).nullable(), state: z.enum(CONTACT_STATES), since: isoTime }).strict()).max(100),
  after: z.string().max(200).nullable() }).strict();
export const checkResult = z.object({ action: z.literal('check_template'), templateId: uuid, problems: z.array(z.string().max(200)).max(40) }).strict();
export const workforceResponse = z.union([
  overview.extend({ action: z.literal('overview') }).strict(),
  contactsPage,
  checkResult,
  z.object({ action: z.literal('done'), refreshed: overview }).strict(),
]);
export type WorkforceResponse = z.infer<typeof workforceResponse>;

/* ------------------------------------------------------------------------------------------ the public side */

/** What the sign-up page may show: the practice's public name and the program label. Nothing else is public. */
export const joinPageInfo = z.object({ practiceName: z.string().max(80), programKey: campaignProgram, programLabel: z.string().max(80), consentVersion: z.literal(CAMPAIGN_CONSENT_VERSION), consentLine: z.string().max(300), formToken: z.string().min(20).max(600) }).strict();
export type JoinPageInfo = z.infer<typeof joinPageInfo>;
export const joinSubmission = z.object({
  practice: practiceSlug, program: campaignProgram, email: z.string().max(254), firstName: z.string().max(80).optional(),
  consent: z.literal('yes'), formToken: z.string().min(20).max(600),
  /** The hidden field: a person never fills it in. */
  website: z.string().max(200).optional(),
}).strict();
export type JoinSubmission = z.infer<typeof joinSubmission>;
/** One answer for every sign-up, whether or not the address is on the list, so a list cannot be probed. */
export const JOIN_ACCEPTED = Object.freeze({ outcome: 'check_your_email' as const });
export const confirmOutcome = z.enum(['confirmed', 'expired', 'invalid', 'list_full', 'unavailable']);
export type ConfirmOutcome = z.infer<typeof confirmOutcome>;
