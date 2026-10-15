if (typeof window !== 'undefined') throw new Error('notification runtime is server-only');
import type { ClinicalCoreDatabase } from '../clinical-core/database';
import { createAppointmentTextReminders, createNoticeDispatcher, createNoticeEmitter, type AppointmentReminderChannels, type NoticeEmitter } from './notification-dispatcher';
import type { EmailSender, PatientEmailDirectory, TextSender } from './notification-providers';
import { createNotificationSettingsService, type NotificationSettingsService } from './notification-settings-service';
import { createSqlClinicNotificationSettingsReader, createSqlNoticeEnqueuer, createSqlPatientNotificationSettings, type PatientNotificationWorkerLedger } from './patient-notification-ledger';
import { patientNotificationSwitches, type SwitchEnvironment } from './notification-switches';

/**
 * How the switches become ports. Each function builds a port only when its switch is on, so a host that
 * calls these with every switch off gets exactly what it had before: no emitter, no settings service, no
 * reminder text port, no dispatcher.
 *
 * Senders are passed in, never built here. Building an AWS client is the host's decision, made with a
 * reviewed configuration; this file only decides whether a sender may be used at all.
 */

/** The identity API's two optional ports. */
export function identityNotificationPortsFrom(env: SwitchEnvironment, database: ClinicalCoreDatabase): {
  patientNotices?: NoticeEmitter; notificationSettings?: NotificationSettingsService;
} {
  const on = patientNotificationSwitches(env);
  return {
    // A notice is enqueued once, whatever channel later carries it, so either notice switch enqueues.
    ...(on.PATIENT_NOTICES_ENABLED || on.SMS_NOTICES_ENABLED ? { patientNotices: createNoticeEmitter(createSqlNoticeEnqueuer(database)) } : {}),
    ...(on.NOTIFICATION_PREFERENCES_ENABLED ? { notificationSettings: createNotificationSettingsService({
      patient: createSqlPatientNotificationSettings(database), clinic: createSqlClinicNotificationSettingsReader(database) }) } : {}),
  };
}

/** The telehealth reminder handler's text port. Off: undefined, and reminders stay email only and unchanged. */
export function reminderTextPortFrom(env: SwitchEnvironment, deps: { ledger: PatientNotificationWorkerLedger; text: TextSender | null; origin: string }): AppointmentReminderChannels | undefined {
  if (!patientNotificationSwitches(env).SMS_REMINDERS_ENABLED) return undefined;
  // On, but without a configured sender: refuse loudly rather than run a reminder path that cannot text.
  if (!deps.text) throw new Error('sms_reminders_configuration_invalid');
  return createAppointmentTextReminders({ ledger: deps.ledger, text: deps.text, origin: deps.origin });
}

/** A sender for a switched-off channel. It is never called: the dispatcher skips the channel first. */
const switchedOff: EmailSender & TextSender = { async send() { throw new Error('channel_switched_off'); } };

/**
 * The notice dispatcher, or null when neither notice switch is on (nothing runs). With one channel on, the
 * other channel's deliveries are recorded as skipped (`channel_switched_off`) and its sender is never called.
 */
export function noticeDispatcherFrom(env: SwitchEnvironment, deps: {
  ledger: PatientNotificationWorkerLedger; directory: PatientEmailDirectory; email: EmailSender | null; text: TextSender | null; origin: string; now?: () => Date;
}) {
  const on = patientNotificationSwitches(env);
  if (!on.PATIENT_NOTICES_ENABLED && !on.SMS_NOTICES_ENABLED) return null;
  if ((on.PATIENT_NOTICES_ENABLED && !deps.email) || (on.SMS_NOTICES_ENABLED && !deps.text)) throw new Error('patient_notices_configuration_invalid');
  return createNoticeDispatcher({
    ledger: deps.ledger, directory: deps.directory, origin: deps.origin, now: deps.now,
    email: on.PATIENT_NOTICES_ENABLED && deps.email ? deps.email : switchedOff,
    text: on.SMS_NOTICES_ENABLED && deps.text ? deps.text : switchedOff,
    channels: { email: on.PATIENT_NOTICES_ENABLED, sms: on.SMS_NOTICES_ENABLED },
  });
}
