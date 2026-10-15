import { leadUserId } from './signup-token';
import type { CampaignDirectory } from './dittofeed';

/**
 * SES events for the marketing configuration set, delivered by SNS to this function (Lambda protocol: no
 * public endpoint), and only from the one configured topic.
 *
 * 1. **Suppression.** Hard bounces and complaints remove the address from every future send. Dittofeed
 *    records SES events (as DFEmailBounced / DFEmailMarkedSpam) but its source shows no automatic
 *    suppression, so this function unsubscribes the person from every program list. The SES configuration
 *    set's own suppression (BOUNCE, COMPLAINT) is the second, independent stop.
 * 2. **Relay.** Each notification is then passed to Dittofeed's SES webhook on the campaign network, so its
 *    delivered and bounced totals exist. That webhook is never published on the internet: Dittofeed checks
 *    an SNS signature but not which topic signed it, and it confirms any subscription request, so a
 *    public webhook would accept genuinely signed events from a stranger's own topic.
 *
 * A failure in either step throws, so the invocation is retried (and lands on the dead-letter queue after
 * the retries) rather than losing a removal. Addresses are never logged.
 */
type SnsRecord = {
  EventSource?: string;
  Sns?: {
    Type?: string; MessageId?: string; TopicArn?: string; Subject?: string | null; Message?: string; Timestamp?: string;
    SignatureVersion?: string; Signature?: string; SigningCertUrl?: string; UnsubscribeUrl?: string;
  };
};
type Envelope = { Records?: SnsRecord[] };
/** The body SNS would have posted over HTTPS, rebuilt from the Lambda record so its signature still verifies. */
export type SnsHttpNotification = {
  Type: string; MessageId: string; TopicArn: string; Subject?: string; Message: string; Timestamp: string;
  SignatureVersion: string; Signature: string; SigningCertURL: string; UnsubscribeURL: string;
};
export type SesEventRelay = (notification: SnsHttpNotification) => Promise<void>;

function httpShape(sns: NonNullable<SnsRecord['Sns']>): SnsHttpNotification {
  const fields = [sns.Type, sns.MessageId, sns.TopicArn, sns.Message, sns.Timestamp, sns.SignatureVersion, sns.Signature, sns.SigningCertUrl, sns.UnsubscribeUrl];
  if (fields.some(field => typeof field !== 'string' || field.length === 0)) throw new Error('bounce_event_refused');
  return {
    Type: sns.Type!, MessageId: sns.MessageId!, TopicArn: sns.TopicArn!, ...(typeof sns.Subject === 'string' && sns.Subject ? { Subject: sns.Subject } : {}),
    Message: sns.Message!, Timestamp: sns.Timestamp!, SignatureVersion: sns.SignatureVersion!, Signature: sns.Signature!,
    SigningCertURL: sns.SigningCertUrl!, UnsubscribeURL: sns.UnsubscribeUrl!,
  };
}

export function createBounceHandler(deps: { topicArn: string; idKey: Buffer; directory: CampaignDirectory; relay?: SesEventRelay }) {
  if (!/^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/.test(deps.topicArn)) throw new Error('bounce_configuration_invalid');
  return async (envelope: Envelope) => {
    let removed = 0, ignored = 0, relayed = 0;
    for (const record of envelope.Records ?? []) {
      if (record.EventSource !== 'aws:sns' || record.Sns?.TopicArn !== deps.topicArn) throw new Error('bounce_event_refused');
      let message: { eventType?: string; notificationType?: string; bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] }; complaint?: { complainedRecipients?: { emailAddress?: string }[] } };
      try { message = JSON.parse(String(record.Sns?.Message ?? '')); } catch { throw new Error('bounce_event_refused'); }
      const kind = String(message.eventType ?? message.notificationType ?? '').toLowerCase();
      // A soft (transient) bounce may recover; only permanent bounces and every complaint remove the address.
      const removes = kind === 'complaint' || (kind === 'bounce' && String(message.bounce?.bounceType ?? '').toLowerCase() === 'permanent');
      if (!removes) ignored++;
      else {
        const recipients = (kind === 'bounce' ? message.bounce?.bouncedRecipients : message.complaint?.complainedRecipients) ?? [];
        for (const recipient of recipients) {
          const address = String(recipient?.emailAddress ?? '').trim().toLowerCase();
          if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(address)) { ignored++; continue; }
          await deps.directory.unsubscribeAll(leadUserId(deps.idKey, address));
          removed++;
        }
      }
      // Removal first: a relay failure retries the whole record, and the removal is idempotent.
      if (deps.relay) { await deps.relay(httpShape(record.Sns!)); relayed++; }
    }
    return { removed, ignored, relayed };
  };
}

type Fetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean; status: number }>;
/** Posts to Dittofeed's SES webhook on the campaign network only (an http address inside the VPC, never the public one). */
export function createDittofeedSesRelay(internalBaseUrl: string, fetcher: Fetch = fetch as unknown as Fetch, timeoutMs = 5000): SesEventRelay {
  if (!/^https?:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/.test(internalBaseUrl)) throw new Error('relay_configuration_invalid');
  const url = `${internalBaseUrl}/api/public/webhooks/amazon-ses`;
  return async notification => {
    let response: { ok: boolean; status: number };
    try { response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' }, body: JSON.stringify(notification), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch { throw new Error('ses_event_relay_failed'); }
    if (!response.ok) throw new Error('ses_event_relay_failed');
  };
}
