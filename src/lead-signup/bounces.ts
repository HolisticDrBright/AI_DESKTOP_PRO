import { leadUserId } from './signup-token';
import type { CampaignDirectory } from './dittofeed';

/**
 * Hard bounces and complaints remove the address from every future send. Dittofeed records SES
 * events (as DFEmailBounced / DFEmailMarkedSpam) but its source shows no automatic suppression, so
 * this function, subscribed to the marketing configuration set's SNS topic, unsubscribes the person
 * from every program list. The SES configuration set's own suppression (BOUNCE, COMPLAINT) is the
 * second, independent stop. Only the topic configured here is accepted; addresses are never logged.
 */
type Envelope = { Records?: { EventSource?: string; Sns?: { TopicArn?: string; Message?: string } }[] };
export function createBounceHandler(deps: { topicArn: string; idKey: Buffer; directory: CampaignDirectory }) {
  if (!/^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/.test(deps.topicArn)) throw new Error('bounce_configuration_invalid');
  return async (envelope: Envelope) => {
    let removed = 0, ignored = 0;
    for (const record of envelope.Records ?? []) {
      if (record.EventSource !== 'aws:sns' || record.Sns?.TopicArn !== deps.topicArn) throw new Error('bounce_event_refused');
      let message: { eventType?: string; notificationType?: string; bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] }; complaint?: { complainedRecipients?: { emailAddress?: string }[] } };
      try { message = JSON.parse(String(record.Sns?.Message ?? '')); } catch { throw new Error('bounce_event_refused'); }
      const kind = String(message.eventType ?? message.notificationType ?? '').toLowerCase();
      // A soft (transient) bounce may recover; only permanent bounces and every complaint remove the address.
      if (kind !== 'bounce' && kind !== 'complaint') { ignored++; continue; }
      if (kind === 'bounce' && String(message.bounce?.bounceType ?? '').toLowerCase() !== 'permanent') { ignored++; continue; }
      const recipients = (kind === 'bounce' ? message.bounce?.bouncedRecipients : message.complaint?.complainedRecipients) ?? [];
      for (const recipient of recipients) {
        const address = String(recipient?.emailAddress ?? '').trim().toLowerCase();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(address)) { ignored++; continue; }
        // A failure here throws, so SNS retries the delivery rather than losing the removal.
        await deps.directory.unsubscribeAll(leadUserId(deps.idKey, address));
        removed++;
      }
    }
    return { removed, ignored };
  };
}
