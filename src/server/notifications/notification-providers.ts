if (typeof window !== 'undefined') throw new Error('notification providers are server-only');
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { e164 } from '@/contracts/patientNotifications';

/**
 * The two senders, as narrow ports with AWS implementations. Nothing here decides WHETHER to send:
 * the dispatcher and the database have already applied consent, STOP, preferences and quiet hours.
 * The AWS implementations are source only: no client is constructed until a reviewed host passes a
 * complete configuration, and nothing in this repository does.
 *
 *   Email: Amazon SES v2, a dedicated configuration set for patient notifications (bounce and
 *          complaint events feed the same suppression the reminders use).
 *   Text:  AWS End User Messaging SMS (pinpoint-sms-voice-v2 SendTextMessage), TRANSACTIONAL, from one
 *          registered origination identity. Not Amazon Pinpoint campaigns or journeys.
 */
export type SendReply = { outcome: 'accepted'; providerRef: string } | { outcome: 'opted_out' } | { outcome: 'refused'; detail: 'provider_unavailable' | 'request_invalid' };
export interface EmailSender { send(message: { to: string; subject: string; text: string }): Promise<SendReply> }
export interface TextSender { send(message: { to: string; body: string }): Promise<SendReply> }
/** Where a patient's email address comes from: the consumer identity, never a notification table. */
export interface PatientEmailDirectory {
  emailFor(consumerSubject: string): Promise<{ kind: 'address'; address: string; suppressed: boolean } | { kind: 'unavailable'; reason: 'no_contact' | 'service_unavailable' }>;
}

export type SesNotificationConfig = { region: string; sender: string; configurationSet: string };
export type TextNotificationConfig = { region: string; originationIdentity: string; configurationSet: string };
const REGION = /^[a-z]{2}-[a-z]+-[0-9]$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function sesNotificationConfig(input: Partial<Record<keyof SesNotificationConfig, string>>): SesNotificationConfig | null {
  const { region = '', sender = '', configurationSet = '' } = input;
  if (!REGION.test(region) || !/^[^\s@<>]{1,64}@[a-z0-9.-]{3,190}$/.test(sender) || !NAME.test(configurationSet)) return null;
  return { region, sender, configurationSet };
}
export function textNotificationConfig(input: Partial<Record<keyof TextNotificationConfig, string>>): TextNotificationConfig | null {
  const { region = '', originationIdentity = '', configurationSet = '' } = input;
  // A phone number in E.164 or a phone-number/pool ARN or id from End User Messaging.
  const identity = e164.safeParse(originationIdentity).success || /^(arn:aws:sms-voice:[a-z0-9-]+:[0-9]{12}:(phone-number|pool)\/)?(phone|pool)-[a-f0-9]{32}$/.test(originationIdentity);
  if (!REGION.test(region) || !identity || !NAME.test(configurationSet)) return null;
  return { region, originationIdentity, configurationSet };
}

export function createSesEmailSender(config: SesNotificationConfig, client: Pick<SESv2Client, 'send'> = new SESv2Client({ region: config.region })): EmailSender {
  return {
    async send({ to, subject, text }) {
      try {
        const result = await client.send(new SendEmailCommand({ FromEmailAddress: config.sender, ConfigurationSetName: config.configurationSet,
          Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } }));
        return result.MessageId ? { outcome: 'accepted', providerRef: result.MessageId } : { outcome: 'refused', detail: 'provider_unavailable' };
      } catch (error) {
        const name = (error as { name?: string }).name;
        return { outcome: 'refused', detail: name === 'BadRequestException' || name === 'MessageRejected' ? 'request_invalid' : 'provider_unavailable' };
      }
    },
  };
}

export function createEndUserMessagingTextSender(config: TextNotificationConfig, client: Pick<PinpointSMSVoiceV2Client, 'send'> = new PinpointSMSVoiceV2Client({ region: config.region })): TextSender {
  return {
    async send({ to, body }) {
      if (!e164.safeParse(to).success || body.length < 1 || body.length > 306) return { outcome: 'refused', detail: 'request_invalid' };
      try {
        // No Context map: anything attached here is copied into delivery events and logs.
        const result = await client.send(new SendTextMessageCommand({ DestinationPhoneNumber: to, OriginationIdentity: config.originationIdentity,
          MessageBody: body, MessageType: 'TRANSACTIONAL', ConfigurationSetName: config.configurationSet }));
        return result.MessageId ? { outcome: 'accepted', providerRef: result.MessageId } : { outcome: 'refused', detail: 'provider_unavailable' };
      } catch (error) {
        const { name, Reason } = error as { name?: string; Reason?: string };
        if (name === 'ConflictException' && Reason === 'DESTINATION_PHONE_NUMBER_OPTED_OUT') return { outcome: 'opted_out' };
        return { outcome: 'refused', detail: name === 'ValidationException' ? 'request_invalid' : 'provider_unavailable' };
      }
    },
  };
}

/* -------------------------------------------------------------- fictional senders for tests and fixtures */

export function createFictionalSenders() {
  const outbox: { channel: 'email' | 'sms'; to: string; subject?: string; body: string }[] = [];
  const optedOut = new Set<string>();
  let failNext = 0, n = 0;
  const reply = (): SendReply | null => { if (failNext > 0) { failNext--; return { outcome: 'refused', detail: 'provider_unavailable' }; } return null; };
  return {
    outbox, optedOut,
    failNext(count: number) { failNext = count; },
    email: { async send(m) { const r = reply(); if (r) return r; outbox.push({ channel: 'email', to: m.to, subject: m.subject, body: m.text }); return { outcome: 'accepted', providerRef: `fictional-email-${++n}` }; } } satisfies EmailSender,
    text: { async send(m) { const r = reply(); if (r) return r; if (optedOut.has(m.to)) return { outcome: 'opted_out' }; outbox.push({ channel: 'sms', to: m.to, body: m.body }); return { outcome: 'accepted', providerRef: `fictional-text-${++n}` }; } } satisfies TextSender,
  };
}
