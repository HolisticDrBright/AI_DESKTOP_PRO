/**
 * The named switches for patient reminders and notices. Each is off unless it reads exactly `true`
 * (after trimming); anything else, including unset, `TRUE`, `1` or `yes`, is off.
 *
 * With every switch off, nothing here is built: no notice is enqueued, no settings route answers, no
 * text sender exists and no dispatcher runs, so the clinical paths behave exactly as they did before
 * this work. The database candidate keeps its own activation row (`notices_enabled`, `texts_enabled`,
 * both false) on top of these, so turning a switch on is necessary but not sufficient.
 */
export const PATIENT_NOTIFICATION_SWITCHES = Object.freeze({
  PATIENT_NOTICES_ENABLED: '"Something new" emails to patients',
  SMS_NOTICES_ENABLED: '"Something new" texts to patients who agreed to texts',
  SMS_REMINDERS_ENABLED: 'Appointment reminder texts beside the reminder email',
  NOTIFICATION_PREFERENCES_ENABLED: "The patient's Notifications settings and the clinic's read-only view of them",
} as const);
export type PatientNotificationSwitch = keyof typeof PATIENT_NOTIFICATION_SWITCHES;
export const PATIENT_NOTIFICATION_SWITCH_NAMES = Object.freeze(Object.keys(PATIENT_NOTIFICATION_SWITCHES) as PatientNotificationSwitch[]);

export type SwitchEnvironment = Readonly<Record<string, string | undefined>>;

export function patientNotificationSwitches(env: SwitchEnvironment): Record<PatientNotificationSwitch, boolean> {
  return Object.fromEntries(PATIENT_NOTIFICATION_SWITCH_NAMES.map(name => [name, env[name]?.trim() === 'true'])) as Record<PatientNotificationSwitch, boolean>;
}
