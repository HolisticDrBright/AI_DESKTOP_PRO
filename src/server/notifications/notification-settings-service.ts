import { clinicNotificationSettingsRequest, notificationSettingsRequest, type ClinicNotificationSettingsView, type ConsentWording,
  type NotificationSettingsResponse, type NotificationSettingsView, type PatientNotificationPreferences } from '@/contracts/patientNotifications';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { PatientNotificationError } from './patient-notification-ledger';

/**
 * The two settings surfaces, as the identity API serves them (synthetic boundary only):
 *
 * - **The patient's own** (consumer): read, read the approved text-consent wording, save, agree to texts at a
 *   number, withdraw. Only the patient can turn texts on, and only at a number with the exact approved
 *   wording on record.
 * - **The clinic's read-only view** (workforce): a connected patient's choices, the number reduced to its
 *   last two digits. There is no clinic request that changes anything.
 *
 * Both answer only through the BLOCKED candidate's functions. Where the candidate is not installed, the
 * handler is never given this service and the routes answer 503: the settings are not available, which is
 * not the same as "no settings".
 */
export type PatientSettingsPort = {
  read(context: ClinicalRequestContext): Promise<NotificationSettingsView>;
  wording(context: ClinicalRequestContext): Promise<ConsentWording | null>;
  save(context: ClinicalRequestContext, preferences: PatientNotificationPreferences, timeZone: string | null, expectedVersion: number): Promise<NotificationSettingsView>;
  consent(context: ClinicalRequestContext, phone: string, wordingVersion: string, wordingSha256: string): Promise<NotificationSettingsView>;
  withdraw(context: ClinicalRequestContext): Promise<NotificationSettingsView>;
};
export type ClinicSettingsReader = (context: ClinicalRequestContext, connectionId: string) => Promise<ClinicNotificationSettingsView>;

export function createNotificationSettingsService(ports: { patient: PatientSettingsPort; clinic: ClinicSettingsReader }) {
  return {
    async patient(context: ClinicalRequestContext, body: unknown): Promise<NotificationSettingsResponse> {
      if (context.identityPool !== 'consumer') throw new PatientNotificationError('identity_refused');
      const request = notificationSettingsRequest.safeParse(body);
      if (!request.success) throw new PatientNotificationError('request_invalid');
      const r = request.data;
      switch (r.action) {
        case 'wording': return { action: 'wording', wording: await ports.patient.wording(context) };
        case 'read': return { action: 'read', settings: await ports.patient.read(context) };
        case 'save': return { action: 'save', settings: await ports.patient.save(context, r.preferences, r.timeZone, r.expectedVersion) };
        case 'consent': return { action: 'consent', settings: await ports.patient.consent(context, r.phone, r.wordingVersion, r.wordingSha256) };
        case 'withdraw': return { action: 'withdraw', settings: await ports.patient.withdraw(context) };
      }
    },
    async clinic(context: ClinicalRequestContext, body: unknown): Promise<ClinicNotificationSettingsView> {
      if (context.identityPool !== 'workforce') throw new PatientNotificationError('identity_refused');
      const request = clinicNotificationSettingsRequest.safeParse(body);
      if (!request.success) throw new PatientNotificationError('request_invalid');
      return ports.clinic(context, request.data.connectionId);
    },
  };
}
export type NotificationSettingsService = ReturnType<typeof createNotificationSettingsService>;
