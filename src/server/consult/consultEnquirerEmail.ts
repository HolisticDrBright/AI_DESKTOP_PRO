import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

/**
 * "We received your request": the one email a person who used the public consult form receives from the
 * clinic before anyone has replied. Clinical side only: it is sent through the clinic's existing
 * `alp-transactional` SES configuration, never through the campaign service, and the person is never added
 * to any list.
 *
 * It is sent from the one place the visitor's address legitimately exists in plaintext: the public consult
 * route, after the clinical API has accepted the request and before the plaintext is discarded. Nothing is
 * unsealed for it. It goes out only when the request was actually received; a throttled or refused
 * submission sends nothing, so the database's own limits (per link per hour, per address per day) bound how
 * often anyone can make the clinic write to an address.
 *
 * The email names the clinic, says someone will reply about a time, and gives the clinic's contact line. It
 * repeats nothing the visitor chose: no reason, visit type, program, preferred time, name or reference.
 *
 * Off by default: `CONSULT_ENQUIRER_EMAILS_ENABLED` must be `true`, and the sender, the configuration set
 * (exactly `alp-transactional`) and the contact line must all be set, or nothing is sent.
 */
export type EnquirerEmailConfig = { sender: string; configurationSet: 'alp-transactional'; contactLine: string; region: string | undefined };
export type EnquirerEmailRefusal = 'disabled' | 'incomplete';

const SENDER = /^([\p{L}\p{N} .,'&-]{1,60} <)?[^\s@<>]{1,64}@[a-z0-9.-]{3,190}>?$/u;
const CONTACT_LINE = /^[\p{L}\p{N} .,:;'()&@+/-]{8,200}$/u;
const CLINIC = /^[\p{L}\p{N} .,'&-]{2,120}$/u;

export function consultEnquirerEmailConfig(env: Record<string, string | undefined>): { ok: true; config: EnquirerEmailConfig } | { ok: false; reason: EnquirerEmailRefusal } {
  if ((env.CONSULT_ENQUIRER_EMAILS_ENABLED ?? '').trim() !== 'true') return { ok: false, reason: 'disabled' };
  const sender = (env.CONSULT_ENQUIRER_SENDER ?? '').trim();
  const configurationSet = (env.CONSULT_ENQUIRER_CONFIGURATION_SET ?? '').trim();
  const contactLine = (env.CONSULT_ENQUIRER_CONTACT_LINE ?? '').trim();
  if (!SENDER.test(sender) || configurationSet !== 'alp-transactional' || !CONTACT_LINE.test(contactLine)) return { ok: false, reason: 'incomplete' };
  return { ok: true, config: { sender, configurationSet, contactLine, region: env.AWS_REGION?.trim() || undefined } };
}

export function receivedEmail(input: { clinic: string; contactLine: string }) {
  if (!CLINIC.test(input.clinic) || !CONTACT_LINE.test(input.contactLine)) throw new Error('enquirer_email_template_refused');
  return {
    subject: 'We received your consultation request',
    text: `${input.clinic} received your request for a consultation.\n\n`
      + 'Someone from the clinic will reply to you about a time. You do not need to do anything else for now.\n\n'
      + `If you need to reach the clinic: ${input.contactLine}\n\n`
      + 'Please do not reply to this email with health information.\n',
  };
}

export type EnquirerMailer = (to: string, message: { subject: string; text: string }) => Promise<boolean>;
export function createSesEnquirerMailer(config: EnquirerEmailConfig, client: Pick<SESv2Client, 'send'> = new SESv2Client(config.region ? { region: config.region } : {})): EnquirerMailer {
  return async (to, message) => {
    const reply = await client.send(new SendEmailCommand({ FromEmailAddress: config.sender, ConfigurationSetName: config.configurationSet,
      Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: message.subject }, Body: { Text: { Data: message.text } } } } }));
    return Boolean(reply.MessageId);
  };
}

/**
 * Called after the request is recorded. It never throws and never changes the visitor's answer: the request
 * stands whether or not the email goes out, and an outcome is returned only for tests and counts.
 */
export async function sendReceivedEmail(deps: {
  env: Record<string, string | undefined>; to: string; clinic: () => Promise<string | null>; mailer?: (config: EnquirerEmailConfig) => EnquirerMailer; timeoutMs?: number;
}): Promise<'sent' | 'disabled' | 'incomplete' | 'clinic_unknown' | 'failed'> {
  const resolved = consultEnquirerEmailConfig(deps.env);
  if (!resolved.ok) return resolved.reason;
  try {
    const clinic = await deps.clinic();
    if (!clinic || !CLINIC.test(clinic)) return 'clinic_unknown';
    const mail = (deps.mailer ?? createSesEnquirerMailer)(resolved.config);
    const timeout = new Promise<false>(resolve => setTimeout(() => resolve(false), deps.timeoutMs ?? 5000).unref?.());
    return (await Promise.race([mail(deps.to, receivedEmail({ clinic, contactLine: resolved.config.contactLine })), timeout])) ? 'sent' : 'failed';
  } catch { return 'failed'; }
}
