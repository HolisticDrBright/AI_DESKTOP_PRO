if (typeof window !== 'undefined') throw new Error('outreach-status is server-only');
import { CAMPAIGN_PROGRAMS, engineStatus, type CampaignProgram, type EngineStatus } from '@/campaigns/contract';
import { allFunnels, type FunnelDefinition } from '@/funnels';
import { indexingAllowed, isStagingOrSynthetic, publicSiteOrigin } from '@/lib/publicSite';
import { CampaignApiError, campaignApiCall, campaignApiOrigin, campaignEngineEnabled, funnelPracticeSlug } from '@/server/campaign-api';
import { selectProgramOfferLedger, type ProgramOfferLedgerSelection } from '@/server/commerce/program-commerce-runtime';
import { consultEnquirerEmailConfig } from '@/server/consult/consultEnquirerEmail';

/**
 * The Outreach status screen's rows: one per setting, in the order Brandon switches them on (the same order as
 * `docs/outreach-go-live.md`, which a test holds to this list).
 *
 * Each row says **on**, **off** or **can't tell**, and what it is still waiting for, in plain words. "Can't tell" is
 * its own answer and never a polite "off":
 *
 * - a setting that lives in another service (the telehealth and identity Lambdas, the patient app build) is read by
 *   nothing here, so its row says so rather than guessing from a copy;
 * - a campaign engine that does not answer leaves every engine-backed row at "can't tell", never "off" or "none".
 *
 * Nothing here returns a configured value: not a secret, an address, a sender, an origin or a list. A row reads
 * "set" or "not set", and the campaign engine's `status` answer carries flags and counts only. No patient is read.
 */
export type OutreachState = 'on' | 'off' | 'unknown';
export type OutreachRow = {
  id: string; step: number;
  /** The setting's name as it is written in configuration, or what it is when it is data rather than configuration. */
  setting: string;
  /** Where it is set. */
  where: string;
  turnsOn: string;
  state: OutreachState;
  /** Why it reads as it does, in plain words. */
  reading: string;
  blockedUntil: string;
  who: string;
};
type Env = Readonly<Record<string, string | undefined>>;

/** The rows' fixed part, in go-live order. `funnel` rows expand to one per program page. */
export const OUTREACH_STEPS = [
  { id: 'public-address', setting: '`NEXT_PUBLIC_SITE_ORIGIN` + `APP_RUNTIME_ENV=production-clinical`', where: 'Desktop server',
    turnsOn: 'Search listing of published program pages, and full public addresses for the consult and sign-up links',
    blockedUntil: 'Brandon picks the public address', who: 'Brandon chooses the address; the AWS operator sets both values on the Desktop service' },
  { id: 'program-pages', setting: 'Funnel `status: published` (per program)', where: 'Repository: the program\'s funnel definition',
    turnsOn: 'That program page going live',
    blockedUntil: 'The program\'s published content, and approval of the exact text (also the attorney, for weight loss and diabetes)',
    who: 'Brandon supplies the content and approves the text; the attorney reviews weight loss and diabetes; a developer makes the reviewed change' },
  { id: 'reminder-emails', setting: '`REMINDERS_ENABLED` (existing; template parameter `RemindersEnabled`)', where: 'Telehealth service',
    turnsOn: 'Email appointment reminders', blockedUntil: 'SES production access', who: 'AWS operator, after Brandon says go' },
  { id: 'consult-received-email', setting: '`CONSULT_ENQUIRER_EMAILS_ENABLED`', where: 'Desktop server',
    turnsOn: 'The "we received your request" email', blockedUntil: 'SES production access, and the sender and the clinic\'s contact line set',
    who: 'Brandon approves the contact line; the AWS operator sets the values' },
  { id: 'consult-booked-email', setting: '`CONSULT_ENQUIRER_EMAILS_ENABLED` + `CLINIC_DISPLAY_NAME` (template parameters `ConsultEnquirerEmailsEnabled`, `ClinicDisplayName`)',
    where: 'Telehealth service', turnsOn: 'The "your consultation is booked" email', blockedUntil: 'SES production access, and the clinic name set',
    who: 'AWS operator, after Brandon says go' },
  { id: 'notification-preferences-service', setting: '`NOTIFICATION_PREFERENCES_ENABLED`', where: 'Identity service',
    turnsOn: 'The API behind patients\' notification choices', blockedUntil: 'The identity service\'s two settings routes added to its API (not in this change)',
    who: 'AWS operator' },
  { id: 'notification-preferences-desktop', setting: '`NOTIFICATION_PREFERENCES_ENABLED`', where: 'Desktop server',
    turnsOn: 'The read-only view of a linked patient\'s notification choices, beside the patient in the Inbox', blockedUntil: 'The identity service\'s copy switched on first',
    who: 'AWS operator' },
  { id: 'notification-settings-app', setting: '`NOTIFICATION_SETTINGS_RELEASED`', where: 'Patient app build (a code constant)',
    turnsOn: 'The patient app\'s Notifications screen', blockedUntil: 'A patient-app release with it set, after the identity service\'s copy is on',
    who: 'Brandon decides; the app release owner ships it' },
  { id: 'patient-notices', setting: '`PATIENT_NOTICES_ENABLED`', where: 'Identity service',
    turnsOn: '"Something new" emails', blockedUntil: 'SES production access, and patients able to change their choices first', who: 'AWS operator, after Brandon says go' },
  { id: 'campaign-engine', setting: '`CAMPAIGN_ENGINE_ENABLED` + `CAMPAIGN_API_ORIGIN`', where: 'Desktop server, and the campaign stack',
    turnsOn: 'The /join sign-up pages, the Campaigns screen and everything else campaign', blockedUntil: 'The campaign stack (`infra/campaigns/campaign-engine.json`) applied',
    who: 'The AWS operator applies the stack after Brandon says go, then sets the two values' },
  { id: 'marketing-entitlement', setting: '`marketing` entitlement (this practice)', where: 'Campaign engine (operator data)',
    turnsOn: 'The "Get updates" link, the sign-up page and the Campaigns screen', blockedUntil: 'The Growth or Complete tier, or the marketing add-on',
    who: 'Brandon sells the tier; the operator records the entitlement and its allowance' },
  { id: 'get-updates-link', setting: '`FUNNEL_PRACTICE_SLUG`', where: 'Desktop server',
    turnsOn: '"Get updates about this program" on this deployment\'s program pages', blockedUntil: 'That practice\'s sign-up address set and its marketing entitlement held',
    who: 'AWS operator sets it; the practice sets its sign-up address' },
  { id: 'sending-domain', setting: 'Practice sending domain verified', where: 'Campaign engine and the practice\'s DNS',
    turnsOn: 'Campaign emails from this practice', blockedUntil: 'DNS records added by the practice', who: 'The practice adds the records its Campaigns screen lists' },
  { id: 'campaign-sending', setting: 'Campaign sending settings', where: 'Campaign engine',
    turnsOn: 'Campaign emails', blockedUntil: 'SES production access, sending subdomain, from name, mailing address, approved text',
    who: 'The practice fills in its settings and approves its emails; Brandon and the attorney approve the wording; the AWS operator enables the stack\'s sending schedule (`SendScheduleState`)' },
  { id: 'sms-reminders', setting: '`SMS_REMINDERS_ENABLED`', where: 'Telehealth service',
    turnsOn: 'Appointment reminder texts', blockedUntil: 'A registered sending number, the consent wording approved by the attorney, and the AWS agreement confirmed to cover End User Messaging',
    who: 'Brandon registers the number and confirms the agreement; the attorney approves the wording; the AWS operator sets it' },
  { id: 'sms-notices', setting: '`SMS_NOTICES_ENABLED`', where: 'Identity service',
    turnsOn: '"Something new" texts', blockedUntil: 'A registered sending number, the consent wording approved by the attorney, and the AWS agreement confirmed to cover End User Messaging',
    who: 'Brandon registers the number and confirms the agreement; the attorney approves the wording; the AWS operator sets it' },
  { id: 'purchase-offers', setting: 'Funnel purchase offers (existing withholding)', where: 'Desktop server',
    turnsOn: 'Buying a program from its page', blockedUntil: 'Brandon lifts the Core-launch withholding', who: 'Brandon' },
] as const;
export type OutreachStepId = typeof OUTREACH_STEPS[number]['id'];

const ELSEWHERE = (service: string) => `Set on the ${service}. This screen cannot read that service's settings, so it does not guess.`;
const ENGINE_SILENT = 'The campaign engine did not answer, so this cannot be checked right now.';
const isOn = (value: string | undefined) => (value ?? '').trim() === 'true';
const isSet = (value: string | undefined) => (value ?? '').trim() !== '';

/** What the campaign engine said about this practice, or why it could not be asked. */
export type EngineRead =
  | { kind: 'switched_off' } | { kind: 'misconfigured' } | { kind: 'no_session' }
  | { kind: 'refused' } | { kind: 'unavailable' } | { kind: 'read'; status: EngineStatus };
/** Which programs' sign-up pages are open for the deployment's practice, or why that is unknown. */
export type SignupRead = { kind: 'not_set' } | { kind: 'unavailable' } | { kind: 'read'; open: CampaignProgram[]; offered: CampaignProgram[] };

export async function readEngineStatus(token: string | null, env: Env = process.env): Promise<EngineRead> {
  if (!campaignEngineEnabled(env)) return { kind: 'switched_off' };
  if (!campaignApiOrigin(env)) return { kind: 'misconfigured' };
  if (!token) return { kind: 'no_session' };
  try {
    const parsed = engineStatus.safeParse(await campaignApiCall({ method: 'POST', path: '/campaigns/workforce', body: { action: 'status' }, token, env }));
    return parsed.success ? { kind: 'read', status: parsed.data } : { kind: 'unavailable' };
  } catch (error) {
    return error instanceof CampaignApiError && (error.status === 401 || error.status === 403) ? { kind: 'refused' } : { kind: 'unavailable' };
  }
}

export async function readSignupPages(env: Env = process.env, funnels: readonly FunnelDefinition[] = allFunnels()): Promise<SignupRead> {
  const slug = funnelPracticeSlug(env);
  if (!campaignEngineEnabled(env) || !campaignApiOrigin(env) || !slug) return { kind: 'not_set' };
  const offered = [...new Set(funnels.flatMap(f => f.updates ? [f.updates.programKey] : []))].filter((k): k is CampaignProgram => (CAMPAIGN_PROGRAMS as readonly string[]).includes(k));
  try {
    const open = await Promise.all(offered.map(async program => {
      const reply = await campaignApiCall<{ open?: unknown }>({ method: 'GET', path: `/campaigns/public/signup-open/${slug}/${program}`, env, timeoutMs: 5000 });
      if (typeof reply.open !== 'boolean') throw new CampaignApiError(503, 'unavailable');
      return reply.open ? program : null;
    }));
    return { kind: 'read', offered, open: open.filter((p): p is CampaignProgram => p !== null) };
  } catch { return { kind: 'unavailable' }; }
}

function step(id: OutreachStepId): typeof OUTREACH_STEPS[number] {
  const found = OUTREACH_STEPS.find(s => s.id === id);
  if (!found) throw new Error(`unknown outreach step ${id}`);
  return found;
}

/** The rows, from this server's own configuration, the repository's funnels, and the two engine reads. Pure. */
export function outreachRows(input: { env: Env; funnels: readonly FunnelDefinition[]; engine: EngineRead; signup: SignupRead; offers?: ProgramOfferLedgerSelection }): OutreachRow[] {
  const { env, funnels, engine, signup } = input;
  const offers = input.offers ?? selectProgramOfferLedger(env as Record<string, string | undefined>);
  const rows: OutreachRow[] = [];
  const add = (id: OutreachStepId, state: OutreachState, reading: string, override: Partial<OutreachRow> = {}) => {
    const s = step(id);
    rows.push({ id, step: OUTREACH_STEPS.indexOf(s) + 1, setting: s.setting, where: s.where, turnsOn: s.turnsOn, blockedUntil: s.blockedUntil, who: s.who, state, reading, ...override });
  };

  // 1. The public address and the production posture.
  if (indexingAllowed(env)) add('public-address', 'on', 'The public address is set and this is the production clinical runtime, so published pages may be listed by search engines.');
  else if (!publicSiteOrigin(env)) add('public-address', 'off', isSet(env.NEXT_PUBLIC_SITE_ORIGIN) ? 'The public address is set but is not a valid https origin, so it is ignored.' : 'No public address is set. Every program page is served noindex and the sitemap is empty.');
  else if (String(env.APP_RUNTIME_ENV ?? '') !== 'production-clinical') add('public-address', 'off', 'The public address is set, but this is not the production clinical runtime, so pages are served noindex.');
  else add('public-address', 'off', isStagingOrSynthetic(env) ? 'The public address is set, but something about this deployment says staging or synthetic, so pages are served noindex.' : 'Pages are served noindex.');

  // 2. One row per program page, from the repository.
  for (const funnel of funnels) {
    const attorney = ['weight-loss-program', 'diabetes-program'].includes(funnel.slug);
    add('program-pages', funnel.status === 'published' ? 'on' : 'off',
      funnel.status === 'published' ? 'Published.' : `Draft. ${funnel.draftNote ?? ''}`.trim(),
      { id: `program-page:${funnel.slug}`, setting: `Funnel \`status: published\` (${funnel.programLabel})`,
        blockedUntil: attorney ? 'The program\'s published content, approval of the exact text, and the attorney\'s review' : 'The program\'s published content, and approval of the exact text' });
  }

  // 3-9. Transactional and patient email, most of it set in other services.
  add('reminder-emails', 'unknown', ELSEWHERE('telehealth service'));
  if (!isOn(env.CONSULT_ENQUIRER_EMAILS_ENABLED)) add('consult-received-email', 'off', 'Switched off on this server.');
  else {
    const missing = [
      !isSet(env.CONSULT_ENQUIRER_SENDER) && 'no sender is set',
      (env.CONSULT_ENQUIRER_CONFIGURATION_SET ?? '').trim() !== 'alp-transactional' && 'the configuration set is not alp-transactional',
      !isSet(env.CONSULT_ENQUIRER_CONTACT_LINE) && 'no contact line is set',
    ].filter((m): m is string => typeof m === 'string');
    // The consult route's own reader decides; the names above only say what is missing in words.
    const accepted = consultEnquirerEmailConfig(env).ok;
    add('consult-received-email', accepted ? 'on' : 'off', accepted
      ? 'Switched on and configured on this server. SES production access is not visible from here.'
      : missing.length ? `Switched on, but nothing is sent: ${missing.join('; ')}.`
        : 'Switched on, but its sender or contact line is not in a form the email accepts, so nothing is sent.');
  }
  add('consult-booked-email', 'unknown', ELSEWHERE('telehealth service'));
  add('notification-preferences-service', 'unknown', ELSEWHERE('identity service'));
  add('notification-preferences-desktop', isOn(env.NOTIFICATION_PREFERENCES_ENABLED) ? 'on' : 'off',
    isOn(env.NOTIFICATION_PREFERENCES_ENABLED) ? 'Switched on on this server. The view shows what the identity service answers, or that it could not be read.' : 'Switched off on this server.');
  add('notification-settings-app', 'unknown', 'A constant in the patient app\'s build. This screen cannot see which app build patients have.');
  add('patient-notices', 'unknown', ELSEWHERE('identity service'));

  // 10-14. The campaign engine and this practice's place in it.
  const engineReading = (() => {
    switch (engine.kind) {
      case 'switched_off': return { state: 'off' as const, text: 'The campaign engine is switched off on this server, so nothing campaign is shown, whatever the practice holds.' };
      case 'misconfigured': return { state: 'off' as const, text: 'Switched on, but the campaign API address is not a valid campaign API origin, so nothing campaign works.' };
      case 'no_session': return { state: 'unknown' as const, text: 'Your session could not be used to ask the campaign engine.' };
      case 'refused': return { state: 'unknown' as const, text: 'The campaign engine refused this session, so this cannot be checked.' };
      case 'unavailable': return { state: 'unknown' as const, text: ENGINE_SILENT };
      case 'read': return null;
    }
  })();
  if (engine.kind === 'read') add('campaign-engine', 'on', 'Switched on, and the campaign engine answered.');
  else add('campaign-engine', engineReading!.state, engineReading!.text);
  if (engine.kind !== 'read') {
    add('marketing-entitlement', engineReading!.state, engineReading!.text);
  } else {
    const s = engine.status;
    add('marketing-entitlement', s.marketing ? 'on' : 'off', s.marketing ? `Held${s.tier ? ` (${s.tier === 'addon' ? 'marketing add-on' : `${s.tier} tier`})` : ''}.` : 'Not held by this practice.');
  }

  if (signup.kind === 'not_set') add('get-updates-link', 'off', engine.kind === 'switched_off' || engine.kind === 'misconfigured' ? 'Off, because the campaign engine is switched off or misconfigured on this server.' : 'No practice is named for this deployment\'s program pages.');
  else if (signup.kind === 'unavailable') add('get-updates-link', 'unknown', ENGINE_SILENT);
  else {
    const labels = signup.open.map(p => funnels.find(f => f.updates?.programKey === p)?.programLabel ?? p);
    add('get-updates-link', signup.open.length ? 'on' : 'off', signup.open.length
      ? `Shown for: ${labels.join(', ')}${funnels.every(f => f.status !== 'published') ? '. No program page is published yet, so no visitor sees it.' : '.'}`
      : 'The named practice\'s sign-up pages are not open, so no program page shows the link.');
  }

  if (engine.kind !== 'read') {
    add('sending-domain', engineReading!.state, engineReading!.text);
    add('campaign-sending', engineReading!.state, engineReading!.text);
  } else {
    const s = engine.status;
    if (!s.domain) add('sending-domain', 'off', 'No sending domain is set for this practice.');
    else add('sending-domain', s.domain.verifiedForSending ? 'on' : 'off', s.domain.verifiedForSending
      ? 'Verified for sending.'
      : `Waiting for the practice's DNS records (DKIM: ${s.domain.dkim.replace(/_/g, ' ')}; MAIL FROM: ${s.domain.mailFrom.replace(/_/g, ' ')}).`);
    const missing = [...s.readiness.missing];
    if (s.sesProductionAccess === 'not_granted') missing.push('SES production access has not been granted for this AWS account.');
    const activity = `${s.activeSequences.length} welcome sequence${s.activeSequences.length === 1 ? '' : 's'} active, ${s.scheduledBroadcasts} broadcast${s.scheduledBroadcasts === 1 ? '' : 's'} scheduled, ${s.approvedTemplates} approved email${s.approvedTemplates === 1 ? '' : 's'}.`;
    if (missing.length) add('campaign-sending', 'off', `Not ready: ${missing.join(' ')} ${activity}`);
    else if (s.sesProductionAccess === 'unknown') add('campaign-sending', 'unknown', `Everything this practice sets is ready, but SES production access could not be checked. ${activity}`);
    else add('campaign-sending', 'on', `Ready to send. ${activity} Whether the stack's sending schedule is enabled is not visible from here.`);
  }

  // 15-16. Texts, set in the two services.
  add('sms-reminders', 'unknown', ELSEWHERE('telehealth service'));
  add('sms-notices', 'unknown', ELSEWHERE('identity service'));

  // 17. Buying a program from its page.
  const bound = funnels.some(f => f.programBinding !== null);
  if (offers.kind === 'disabled') add('purchase-offers', 'off', `Withheld: no offer ledger is configured on this server.${bound ? '' : ' No program page is bound to a program yet either.'}`);
  else if (offers.kind === 'fictional') add('purchase-offers', 'off', 'Only the test fixture\'s fictional offers exist on this server; nothing real can be bought.');
  else add('purchase-offers', 'unknown', 'The offer ledger on this server is of a kind this screen does not know.');

  return rows;
}

/** Everything the page needs, read once per request. */
export async function loadOutreachRows(token: string | null, env: Env = process.env): Promise<OutreachRow[]> {
  const funnels = allFunnels();
  const [engine, signup] = await Promise.all([readEngineStatus(token, env), readSignupPages(env, funnels)]);
  return outreachRows({ env, funnels, engine, signup });
}
