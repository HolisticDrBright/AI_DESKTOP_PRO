if (typeof window !== 'undefined') throw new Error('notification policy is server-only');
import {
  NOTICE_KINDS, NOTICE_KIND_PHRASE, TEXT_HOURS, type NoticeKind, type PatientNotificationPreferences, type TextConsent,
} from '@/contracts/patientNotifications';

/**
 * The rules every patient notification follows, as pure functions over their inputs: quiet hours in
 * the patient's own time zone, inbound text keywords, batching, channel choice and the fixed wording.
 * Nothing here reads a store or sends anything; the dispatcher applies these at send time.
 */

/* -------------------------------------------------------------- quiet hours */

function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
/** The UTC offset (milliseconds) of `timeZone` at `at`. */
function offsetAt(at: Date, timeZone: string) {
  const p = localParts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}
/** The instant that is `hour`:00 local on the local calendar date of (year, month, day). */
function localInstant(year: number, month: number, day: number, hour: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour);
  let t = guess - offsetAt(new Date(guess), timeZone);
  t = guess - offsetAt(new Date(t), timeZone);
  return new Date(t);
}
/** Whether a text may be sent at `at` to someone in `timeZone`: 08:00 up to (not including) 21:00 local. */
export function withinTextHours(at: Date, timeZone: string): boolean {
  const hour = localParts(at, timeZone).hour;
  return hour >= TEXT_HOURS.startHour && hour < TEXT_HOURS.endHour;
}
/** The next instant a text may be sent: `at` itself inside the window, else the next 08:00 local. */
export function nextTextWindow(at: Date, timeZone: string): Date {
  if (withinTextHours(at, timeZone)) return at;
  const p = localParts(at, timeZone);
  const today = localInstant(p.year, p.month, p.day, TEXT_HOURS.startHour, timeZone);
  if (today.getTime() > at.getTime()) return today;
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
  const q = localParts(tomorrow, 'UTC');
  return localInstant(q.year, q.month, q.day, TEXT_HOURS.startHour, timeZone);
}

/* -------------------------------------------------------------- inbound text keywords */

const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const HELP = new Set(['HELP', 'INFO']);
const START = new Set(['START', 'UNSTOP']);
/** A reply to a text: STOP-family words end texts at once; HELP-family words get the help line; START re-enables only where consent is on record. */
export function classifyInboundText(body: string): 'stop' | 'help' | 'start' | 'other' {
  const word = body.trim().replace(/[.!\s]+$/u, '').toUpperCase();
  if (STOP.has(word)) return 'stop';
  if (HELP.has(word)) return 'help';
  if (START.has(word)) return 'start';
  return 'other';
}

/* -------------------------------------------------------------- batching */

export type VisibleItem = { eventId: string; patientId: string; kind: NoticeKind; visibleAt: string };
export type NoticeBatch = { patientId: string; kinds: NoticeKind[]; eventIds: string[]; firstVisibleAt: string };
/**
 * Items that became visible close together make ONE notice: per patient, a batch closes `windowMs`
 * after its first item became visible, and carries each kind once, in the fixed order.
 */
export function batchVisibleItems(items: readonly VisibleItem[], now: Date, windowMs: number): NoticeBatch[] {
  const byPatient = new Map<string, VisibleItem[]>();
  for (const item of items) byPatient.set(item.patientId, [...(byPatient.get(item.patientId) ?? []), item]);
  const batches: NoticeBatch[] = [];
  for (const [patientId, list] of byPatient) {
    const sorted = [...list].sort((a, b) => Date.parse(a.visibleAt) - Date.parse(b.visibleAt));
    const first = sorted[0]!;
    if (Date.parse(first.visibleAt) + windowMs > now.getTime()) continue;
    const kinds = NOTICE_KINDS.filter(kind => sorted.some(item => item.kind === kind));
    batches.push({ patientId, kinds, eventIds: sorted.map(item => item.eventId), firstVisibleAt: first.visibleAt });
  }
  return batches.sort((a, b) => Date.parse(a.firstVisibleAt) - Date.parse(b.firstVisibleAt));
}

/* -------------------------------------------------------------- channels */

export type PatientContact = { email: string | null; phone: string | null; timeZone: string | null; clinicName: string };
export type ChannelState = { emailSuppressed: boolean; textStopped: boolean };
export type ChannelDecision = { channel: 'email' | 'sms'; kinds: NoticeKind[]; to: string } ;
/**
 * Which channels a notice goes out on, and for which of its kinds. Email needs an address that has not
 * bounced or complained; a text needs consent on record at exactly the contact number, no STOP, a time
 * zone, and the patient's text preference for that kind. Push is not offered: the app does not support it.
 */
export function noticeChannels(kinds: readonly NoticeKind[], prefs: PatientNotificationPreferences, contact: PatientContact,
  consent: TextConsent | null, state: ChannelState): ChannelDecision[] {
  const out: ChannelDecision[] = [];
  const emailKinds = kinds.filter(kind => prefs.notices[kind].email);
  if (emailKinds.length && contact.email && !state.emailSuppressed) out.push({ channel: 'email', kinds: emailKinds, to: contact.email });
  const textKinds = kinds.filter(kind => prefs.notices[kind].sms);
  if (textKinds.length && textAllowed(contact, consent, state)) out.push({ channel: 'sms', kinds: textKinds, to: contact.phone! });
  return out;
}
export function textAllowed(contact: PatientContact, consent: TextConsent | null, state: ChannelState): boolean {
  return !!contact.phone && !!consent && consent.phone === contact.phone && !state.textStopped && !!contact.timeZone;
}

/* -------------------------------------------------------------- wording (fixed templates; counsel reviews before use) */

export const NOTICE_TEMPLATE_VERSION = 'patient-notice-wording/1';
/** A sign-in link: the app's own https origin and a fixed path, with no query, fragment or token. */
export function signInLink(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('notification_link_invalid');
  return url.origin + '/sign-in';
}
function phraseList(kinds: readonly NoticeKind[]): string {
  const phrases = NOTICE_KINDS.filter(kind => kinds.includes(kind)).map(kind => NOTICE_KIND_PHRASE[kind]);
  if (phrases.length === 0) throw new Error('notification_kinds_empty');
  return phrases.length === 1 ? phrases[0]! : phrases.slice(0, -1).join(', ') + ' and ' + phrases.at(-1)!;
}
const CLINIC = /^[A-Za-z0-9][A-Za-z0-9 .,&'()-]{0,79}$/;
const clinicName = (name: string) => { if (!CLINIC.test(name)) throw new Error('notification_clinic_invalid'); return name; };
export function noticeEmail(kinds: readonly NoticeKind[], clinic: string, origin: string) {
  return {
    subject: 'Something new is waiting for you',
    text: `${clinicName(clinic)} has ${phraseList(kinds)} waiting for you in AI Longevity Pro.\n\nSign in to see it: ${signInLink(origin)}\n\nThis email does not contain your health information. Do not reply with health information.`,
  };
}
export function noticeText(kinds: readonly NoticeKind[], clinic: string, origin: string) {
  return `${clinicName(clinic)}: you have ${phraseList(kinds)} waiting in AI Longevity Pro. Sign in to see it: ${signInLink(origin)} Reply STOP to stop texts, HELP for help.`;
}
/** A reminder by text: the clinic, the date and time in the patient's time zone, and where to join or reschedule. Nothing else. */
export function reminderText(clinic: string, scheduledStart: Date, timeZone: string, origin: string) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(scheduledStart);
  return `${clinicName(clinic)}: reminder of your appointment on ${when}. To join or reschedule, sign in to AI Longevity Pro: ${signInLink(origin)} Reply STOP to stop texts, HELP for help.`;
}
export function helpText(clinic: string, helpLine: string) {
  if (!/^\+[1-9][0-9]{7,14}$/.test(helpLine)) throw new Error('notification_help_line_invalid');
  return `${clinicName(clinic)}: for help, call ${helpLine}. Reply STOP to stop texts. Msg & data rates may apply.`;
}
export const STOP_CONFIRMATION = 'You will not receive more texts from AI Longevity Pro. Reply START to resume if you agreed to texts in the app.';
export const START_RESUMED = 'Texts from AI Longevity Pro are back on. Reply STOP to stop, HELP for help.';
export const START_NEEDS_APP = 'To get texts from AI Longevity Pro, turn them on in the app first, then reply START.';
