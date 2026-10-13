import { z } from 'zod';

/**
 * Patient notifications (patient-notifications/1): appointment reminders and "something new is
 * waiting" notices, sent from the CLINICAL side about the patient's own care. Never marketing: nothing
 * here is shared with, read by or sent through the campaign service.
 *
 * Content is fixed. A notice names only the KIND of item that is waiting, from the phrases below, and
 * links to sign in; it never carries a result, value, product, dose, diagnosis, title or message text,
 * and its link carries no token. A reminder names the clinic, the date and time in the patient's time
 * zone, and how to join or reschedule, and nothing about the reason for the visit.
 *
 * Defaults: appointment reminders by email ON; every kind of notice by email ON (each one the patient
 * can turn off); everything by text OFF until the patient opts in with recorded consent at that
 * number; push OFF (the patient app has no push support yet).
 *
 * This file is mirrored byte for byte into the consumer app when the app gains a preferences screen.
 */
export const PATIENT_NOTIFICATIONS_CONTRACT = 'patient-notifications/1' as const;
export const NOTICE_KINDS = ['lab_result', 'protocol', 'message', 'form', 'program_lesson'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
/** Decided by Brandon on 2026-10-12: the kind of item is the only detail a notice carries, in exactly these words. */
export const NOTICE_KIND_PHRASE: Record<NoticeKind, string> = {
  lab_result: 'a new lab result',
  protocol: 'a new protocol',
  message: 'a new message',
  form: 'a new form',
  program_lesson: 'a new program lesson',
};
export const NOTICE_CHANNELS = ['email', 'sms', 'push'] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];
/** Decided by Brandon on 2026-10-12: reminders 24 hours and 1 hour before the visit (the existing email schedule). */
export const REMINDER_OFFSETS = ['24h', '1h'] as const;
/** No text is sent outside 08:00 to 21:00 in the patient's own time zone. */
export const TEXT_HOURS = Object.freeze({ startHour: 8, endHour: 21 });

const flag = z.boolean();
/** Push stays false until the patient app supports it; turning it on is a contract change, not a setting. */
export const noticePreference = z.object({ email: flag, sms: flag, push: z.literal(false) }).strict();
export const patientNotificationPreferences = z.object({
  contract: z.literal(PATIENT_NOTIFICATIONS_CONTRACT),
  appointmentReminders: z.object({ email: flag, sms: flag }).strict(),
  notices: z.object(Object.fromEntries(NOTICE_KINDS.map(kind => [kind, noticePreference])) as Record<NoticeKind, typeof noticePreference>).strict(),
}).strict();
export type PatientNotificationPreferences = z.infer<typeof patientNotificationPreferences>;

export function defaultNotificationPreferences(): PatientNotificationPreferences {
  return {
    contract: PATIENT_NOTIFICATIONS_CONTRACT,
    appointmentReminders: { email: true, sms: false },
    notices: Object.fromEntries(NOTICE_KINDS.map(kind => [kind, { email: true, sms: false, push: false }])) as PatientNotificationPreferences['notices'],
  };
}

/** A US-style E.164 number; the sending number registration decides which countries are reachable. */
export const e164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
/**
 * Consent to texts at ONE number, with the exact wording the patient agreed to (its version and
 * SHA-256). A changed number needs new consent. Wording versions are reviewed by counsel before use.
 */
export const textConsent = z.object({
  phone: e164,
  wordingVersion: z.string().regex(/^text-consent\/[1-9][0-9]{0,3}$/),
  wordingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  agreedAt: z.string().datetime({ offset: true }),
  source: z.literal('patient_app'),
}).strict();
export type TextConsent = z.infer<typeof textConsent>;

/** A patient's IANA time zone, as the patient set it; without one, no text is sent. */
export const timeZone = z.string().min(3).max(64).refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, 'time_zone_invalid');
