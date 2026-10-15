import { CAMPAIGN_PROGRAMS } from './contract';
import { contactId, loadPractice, type ContactBody, type EngineDeps } from './practice-context';
import { leaveListOps } from './public';

/**
 * SES events for the marketing configuration sets. SES publishes them to one SNS topic, which invokes this function
 * directly (the Lambda protocol: there is no public endpoint to forge events at), and only that topic is accepted.
 *
 * Each email carries its practice, kind, template and contact (the address hash) as SES message tags, so an event
 * is attributed without reading an address out of it.
 *
 * - A **permanent bounce** or a **complaint** removes the address from every list of that practice at once, and
 *   records a suppression so a later sign-up sends nothing. The configuration sets also put the address on the
 *   account suppression list (BOUNCE, COMPLAINT), an independent second stop.
 * - **Delivered**, **bounced**, **complained**: counted per email.
 * - **Opens and clicks**: counted only for a practice that has turned that counting on. Never per person.
 *
 * A failure throws, so the invocation is retried and lands on the dead-letter queue rather than losing a removal.
 */
type SnsRecord = { EventSource?: string; Sns?: { TopicArn?: string; Message?: string } };
type SesEvent = { eventType?: string; notificationType?: string; bounce?: { bounceType?: string }; mail?: { tags?: Record<string, string[] | undefined> } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export function createSesEventHandler(deps: EngineDeps & { topicArn: string }) {
  if (!/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(deps.topicArn)) throw new Error('campaign_events_configuration_invalid');
  const now = () => deps.now?.() ?? new Date();
  return async (envelope: { Records?: SnsRecord[] }) => {
    const summary = { removed: 0, counted: 0, ignored: 0 };
    for (const record of envelope.Records ?? []) {
      if (record.EventSource !== 'aws:sns' || record.Sns?.TopicArn !== deps.topicArn) throw new Error('campaign_event_refused');
      let event: SesEvent;
      try { event = JSON.parse(String(record.Sns.Message ?? '')) as SesEvent; } catch { throw new Error('campaign_event_refused'); }
      const tag = (name: string) => { const value = event.mail?.tags?.[name]?.[0]; return typeof value === 'string' ? value : null; };
      const practiceId = tag('practice'), templateId = tag('template'), hash = tag('contact');
      if (!practiceId || !UUID.test(practiceId)) { summary.ignored++; continue; }
      const kind = String(event.eventType ?? event.notificationType ?? '').toLowerCase();
      const ctx = await loadPractice(deps, practiceId);
      const count = async (field: string) => { if (templateId && UUID.test(templateId)) { await ctx.store.increment('result', templateId, field, 1); summary.counted++; } };
      const removes = kind === 'complaint' || (kind === 'bounce' && String(event.bounce?.bounceType ?? '').toLowerCase() === 'permanent');
      if (removes) {
        if (hash && HASH.test(hash)) {
          const to = kind === 'complaint' ? 'complained' as const : 'bounced' as const;
          await ctx.store.put('suppression', hash, { reason: to, at: now().toISOString() }, { expected: null }).catch(() => 'conflict');
          for (const program of CAMPAIGN_PROGRAMS) {
            for (let attempt = 0; attempt < 3; attempt++) {
              const contact = await ctx.store.get<ContactBody>('contact', contactId(program, hash));
              if (!contact || contact.body.state === 'bounced' || contact.body.state === 'complained') break;
              if (await ctx.store.transact(await leaveListOps(ctx.store, program, hash, contact, to, now().toISOString()))) { summary.removed++; break; }
              if (attempt === 2) throw new Error('campaign_event_removal_failed');
            }
          }
        }
        await count(kind === 'complaint' ? 'complained' : 'bounced');
      } else if (kind === 'delivery') await count('delivered');
      else if ((kind === 'open' || kind === 'click') && ctx.settings.trackOpensAndClicks) await count(kind === 'open' ? 'opened' : 'clicked');
      else summary.ignored++;
    }
    return summary;
  };
}
