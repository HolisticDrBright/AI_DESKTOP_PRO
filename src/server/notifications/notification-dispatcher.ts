if (typeof window !== 'undefined') throw new Error('notification dispatcher is server-only');
import { e164 } from '@/contracts/patientNotifications';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import {
  START_NEEDS_APP, START_RESUMED, STOP_CONFIRMATION, classifyInboundText, helpText, nextTextWindow, noticeEmail, noticeText, reminderText, withinTextHours,
} from './notification-policy';
import type { DeliveryOutcome, DueDelivery, NoticeEnqueuer, NoticeSubject, PatientNotificationWorkerLedger, ReminderChannels } from './patient-notification-ledger';
import type { EmailSender, PatientEmailDirectory, SendReply, TextSender } from './notification-providers';

/* -------------------------------------------------------------- the notice dispatcher (worker) */

export type DispatchResult = { deliveryId: string; channel: 'email' | 'sms'; outcome: DeliveryOutcome['outcome'] | 'unrecorded'; reason?: string };
export type DispatchPass = { ok: true; formed: number; results: DispatchResult[] } | { ok: false; reason: 'ledger_unavailable' };

/**
 * One pass: form notices whose batch window has closed, take the due deliveries the database hands
 * out (it has re-checked consent, STOP, preferences, connection and quiet hours), apply the same text
 * hours again, render the fixed wording and send. Every delivery ends recorded as sent, skipped,
 * failed, deferred or retry; a delivery whose outcome cannot be recorded is left to its lease.
 */
export function createNoticeDispatcher(deps: {
  ledger: PatientNotificationWorkerLedger; directory: PatientEmailDirectory; email: EmailSender; text: TextSender;
  origin: string; now?: () => Date; windowSeconds?: number; batchLimit?: number;
  /** Which channels may send. A channel left out is skipped (`channel_switched_off`) and its sender never called. */
  channels?: { email: boolean; sms: boolean };
}) {
  const now = deps.now ?? (() => new Date());
  const channels = deps.channels ?? { email: true, sms: true };
  const windowSeconds = deps.windowSeconds ?? 600, batchLimit = deps.batchLimit ?? 50;
  const fromReply = (reply: SendReply, optedOut: DeliveryOutcome): DeliveryOutcome =>
    reply.outcome === 'accepted' ? { outcome: 'sent', providerRef: reply.providerRef }
      : reply.outcome === 'opted_out' ? optedOut
        : reply.detail === 'request_invalid' ? { outcome: 'failed', reason: 'provider_refused' } : { outcome: 'retry', reason: 'provider_unavailable' };

  async function decide(delivery: DueDelivery): Promise<DeliveryOutcome> {
    if (!channels[delivery.channel]) return { outcome: 'skipped', reason: 'channel_switched_off' };
    if (delivery.channel === 'email') {
      const contact = await deps.directory.emailFor(delivery.consumerSubject).catch(() => ({ kind: 'unavailable' as const, reason: 'service_unavailable' as const }));
      if (contact.kind === 'unavailable') return contact.reason === 'no_contact' ? { outcome: 'skipped', reason: 'no_contact' } : { outcome: 'retry', reason: 'contact_unavailable' };
      if (contact.suppressed) return { outcome: 'skipped', reason: 'email_suppressed' };
      let message: ReturnType<typeof noticeEmail>;
      try { message = noticeEmail(delivery.kinds, delivery.clinicName, deps.origin); } catch { return { outcome: 'failed', reason: 'template_refused' }; }
      return fromReply(await deps.email.send({ to: contact.address, ...message }), { outcome: 'skipped', reason: 'email_suppressed' });
    }
    const zone = delivery.timeZone, phone = delivery.phone;
    if (!zone || !phone) return { outcome: 'skipped', reason: 'time_zone_missing' };
    const at = now();
    if (!withinTextHours(at, zone)) return { outcome: 'deferred', reason: 'quiet_hours', notBefore: nextTextWindow(at, zone) };
    let body: string;
    try { body = noticeText(delivery.kinds, delivery.clinicName, deps.origin); } catch { return { outcome: 'failed', reason: 'template_refused' }; }
    return fromReply(await deps.text.send({ to: phone, body }), { outcome: 'skipped', reason: 'carrier_opted_out' });
  }

  return {
    async run(): Promise<DispatchPass> {
      let formed: number, due: DueDelivery[];
      try {
        formed = (await deps.ledger.formNotices(windowSeconds, 500)).formed;
        due = await deps.ledger.dueDeliveries(batchLimit);
      } catch { return { ok: false, reason: 'ledger_unavailable' }; }
      const results: DispatchResult[] = [];
      for (const delivery of due) {
        let outcome: DeliveryOutcome;
        try { outcome = await decide(delivery); } catch { outcome = { outcome: 'retry', reason: 'dispatch_error' }; }
        try {
          await deps.ledger.recordDelivery(delivery.deliveryId, outcome);
          results.push({ deliveryId: delivery.deliveryId, channel: delivery.channel, outcome: outcome.outcome, ...('reason' in outcome ? { reason: outcome.reason } : {}) });
        } catch { results.push({ deliveryId: delivery.deliveryId, channel: delivery.channel, outcome: 'unrecorded' }); }
      }
      return { ok: true, formed, results };
    },
  };
}

/* -------------------------------------------------------------- inbound replies (STOP / HELP / START) */

/**
 * End User Messaging two-way SMS publishes each reply to an SNS topic. Only that topic, to one of our
 * own sending numbers, is accepted. The reply body is classified here and never stored or passed on;
 * the database records the keyword and suppresses the number on STOP before anything else happens.
 * The number must be configured with self-managed opt-outs so that this, not the service's own
 * keyword handling, is the authority, and there is exactly one confirmation reply.
 */
type InboundRecord = { EventSource?: string; Sns?: { TopicArn?: string; Message?: string } };
export function createInboundTextHandler(deps: { ledger: PatientNotificationWorkerLedger; text: TextSender; topicArn: string; sendingNumbers: readonly string[]; platformHelpLine: string; platformName?: string }) {
  if (!/^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/.test(deps.topicArn) || deps.sendingNumbers.length === 0
    || deps.sendingNumbers.some(n => !e164.safeParse(n).success) || !e164.safeParse(deps.platformHelpLine).success) throw new Error('inbound_text_configuration_invalid');
  const platform = deps.platformName ?? 'AI Longevity Pro';
  return async (envelope: { Records?: InboundRecord[] }) => {
    const results: { outcome: string; replied: boolean }[] = [];
    for (const record of envelope.Records ?? []) {
      if (record.EventSource !== 'aws:sns' || record.Sns?.TopicArn !== deps.topicArn) throw new Error('inbound_text_refused');
      let message: { originationNumber?: unknown; destinationNumber?: unknown; messageBody?: unknown; inboundMessageId?: unknown };
      try { message = JSON.parse(String(record.Sns?.Message ?? '')); } catch { throw new Error('inbound_text_refused'); }
      const from = String(message.originationNumber ?? ''), to = String(message.destinationNumber ?? ''), ref = String(message.inboundMessageId ?? '');
      if (!e164.safeParse(from).success || !deps.sendingNumbers.includes(to) || !/^[A-Za-z0-9._:/+=-]{8,200}$/.test(ref) || typeof message.messageBody !== 'string') throw new Error('inbound_text_refused');
      const classification = classifyInboundText(message.messageBody);
      const recorded = await deps.ledger.recordInbound(from, classification, ref);
      const reply = recorded.duplicate ? null
        : recorded.outcome === 'stopped' ? STOP_CONFIRMATION
          : recorded.outcome === 'help_clinic' && recorded.clinic ? helpText(recorded.clinic.displayName, recorded.clinic.helpLine)
            : recorded.outcome === 'help_platform' ? helpText(platform, deps.platformHelpLine)
              : recorded.outcome === 'resumed' ? START_RESUMED
                : recorded.outcome === 'consent_required' ? START_NEEDS_APP : null;
      let replied = false;
      if (reply) replied = (await deps.text.send({ to: from, body: reply }).catch(() => ({ outcome: 'refused' as const }))).outcome === 'accepted';
      results.push({ outcome: recorded.outcome, replied });
    }
    return { results };
  };
}

/* -------------------------------------------------------------- text appointment reminders (telehealth port) */

export type ReminderTextInput = {
  organizationId: string; personId: string; requestId: string; generation: string; offset: '24h' | '1h'; scheduledStart: string;
  text: NonNullable<ReminderChannels['text']>;
};
/** The port the telehealth reminder handler takes. Unset, reminders are email only and unchanged. */
export interface AppointmentReminderChannels {
  channels(organizationId: string, personId: string): Promise<ReminderChannels>;
  sendText(input: ReminderTextInput): Promise<{ sent: boolean; reason?: string }>;
}
/**
 * Same schedules, offsets, cancel and reschedule removal as the email reminders: the text is sent by
 * the same scheduled event, beside the email. Outside 08:00–21:00 in the patient's own time zone the
 * text is skipped (the email is not); each (request, generation, offset) is claimed once, so a
 * retried schedule never texts twice.
 */
export function createAppointmentTextReminders(deps: { ledger: PatientNotificationWorkerLedger; text: TextSender; origin: string; now?: () => Date }): AppointmentReminderChannels {
  const now = deps.now ?? (() => new Date());
  return {
    channels: (organizationId, personId) => deps.ledger.reminderChannels(organizationId, personId),
    async sendText(input) {
      if (!withinTextHours(now(), input.text.timeZone)) return { sent: false, reason: 'quiet_hours' };
      const ref = `appointment-reminder/2:${input.requestId}:${input.generation}:${input.offset}`;
      if (!await deps.ledger.claimReminderText(ref, input.organizationId, input.personId, input.text.phone)) return { sent: false, reason: 'duplicate' };
      let body: string;
      try { body = reminderText(input.text.clinicName, new Date(input.scheduledStart), input.text.timeZone, deps.origin); }
      catch { await deps.ledger.settleReminderText(ref, { outcome: 'failed', reason: 'template_refused' }); return { sent: false, reason: 'template_refused' }; }
      const reply = await deps.text.send({ to: input.text.phone, body }).catch((): SendReply => ({ outcome: 'refused', detail: 'provider_unavailable' }));
      if (reply.outcome === 'accepted') { await deps.ledger.settleReminderText(ref, { outcome: 'sent', providerRef: reply.providerRef }); return { sent: true }; }
      const reason = reply.outcome === 'opted_out' ? 'carrier_opted_out' : 'provider_unavailable';
      await deps.ledger.settleReminderText(ref, { outcome: reply.outcome === 'opted_out' ? 'skipped' : 'failed', reason });
      return { sent: false, reason };
    },
  };
}

/* -------------------------------------------------------------- the post-commit emitter */

/**
 * Which items a COMMITTED workforce action made visible to a patient, read from the request and the
 * action's own validated reply. Nothing else becomes a notice: consumer actions, reads, drafts,
 * rejections and duplicates do not.
 */
export function noticeSubjectsFor(operation: string, pool: string, request: unknown, reply: unknown): NoticeSubject[] {
  if (pool !== 'workforce' || !request || typeof request !== 'object' || !reply || typeof reply !== 'object') return [];
  const q = request as Record<string, unknown>, r = reply as Record<string, unknown>;
  const s = (value: unknown) => typeof value === 'string' ? value : '';
  if (operation === 'care_messages' && q.action === 'send' && r.action === 'send' && r.duplicate === false && s(q.connectionId) && s(r.messageId)) {
    return [{ kind: 'message', connectionId: s(q.connectionId), messageId: s(r.messageId) }];
  }
  if (operation === 'intake_packets_workforce' && q.action === 'assign' && r.action === 'assign' && r.status === 'open' && s(q.connectionId) && s(r.packetId)) {
    return [{ kind: 'form', connectionId: s(q.connectionId), packetId: s(r.packetId) }];
  }
  if (operation === 'program_assignments' && q.action === 'assign' && r.action === 'assign' && s(r.enrollmentId)) return [{ kind: 'program_lesson', enrollmentId: s(r.enrollmentId) }];
  if (operation === 'program_assignments' && q.action === 'release' && r.action === 'release' && s(q.enrollmentId) && s(q.phaseId)) {
    return [{ kind: 'program_lesson', enrollmentId: s(q.enrollmentId), phaseId: s(q.phaseId) }];
  }
  if (operation === 'review_lab' && q.decision === 'accept' && r.state === 'accepted' && r.duplicate === false && s(r.observationId)) return [{ kind: 'lab_result', observationId: s(r.observationId) }];
  return [];
}
export type NoticeEmitter = (context: ClinicalRequestContext, operation: string, request: unknown, reply: unknown) => Promise<void>;
/** Never throws and never changes the reply: a failed or refused enqueue is reported to `report` and nothing else. */
export function createNoticeEmitter(enqueue: NoticeEnqueuer, report: (event: { kind: string; outcome: string }) => void = () => {}): NoticeEmitter {
  return async (context, operation, request, reply) => {
    for (const subject of noticeSubjectsFor(operation, context.identityPool, request, reply)) {
      try {
        const result = await enqueue(context, subject);
        report({ kind: subject.kind, outcome: result.queued ? (result.duplicate ? 'duplicate' : 'queued') : result.reason });
      } catch (error) { report({ kind: subject.kind, outcome: error instanceof Error ? error.message : 'enqueue_failed' }); }
    }
  };
}
