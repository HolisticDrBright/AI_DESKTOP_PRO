import { describe, expect, it, vi } from 'vitest';
import { createAppointmentTextReminders, createInboundTextHandler, createNoticeDispatcher, createNoticeEmitter, noticeSubjectsFor } from './notification-dispatcher';
import { createEndUserMessagingTextSender, createFictionalSenders, createSesEmailSender, sesNotificationConfig, textNotificationConfig } from './notification-providers';
import type { DeliveryOutcome, DueDelivery, InboundOutcome, PatientNotificationWorkerLedger } from './patient-notification-ledger';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';

/** The sending side over a scripted ledger and fictional senders. Fictional patients, addresses and numbers only. */
const ORIGIN = 'https://app.fictional.example';
const id = (n: number) => '7e000000-0000-4000-8000-' + String(n).padStart(12, '0');
const email = (n: number, kinds: DueDelivery['kinds'] = ['message']): DueDelivery => ({ deliveryId: id(n), channel: 'email', kinds, attempt: 1, clinicName: 'Fictional Clinic', consumerSubject: 'cn_fictional_ava_0001', timeZone: null, phone: null });
const sms = (n: number, timeZone = 'America/Los_Angeles'): DueDelivery => ({ deliveryId: id(n), channel: 'sms', kinds: ['lab_result', 'form'], attempt: 1, clinicName: 'Fictional Clinic', consumerSubject: 'cn_fictional_ava_0001', timeZone, phone: '+15555550101' });

function scriptedLedger(due: DueDelivery[], inbound?: InboundOutcome) {
  const recorded: [string, DeliveryOutcome][] = [];
  const claims = new Set<string>(); const settled: [string, unknown][] = [];
  const ledger: PatientNotificationWorkerLedger = {
    formNotices: vi.fn(async () => ({ formed: 1 })),
    dueDeliveries: vi.fn(async () => due),
    recordDelivery: vi.fn(async (deliveryId: string, outcome: DeliveryOutcome) => { recorded.push([deliveryId, outcome]); }),
    recordInbound: vi.fn(async (): Promise<InboundOutcome> => inbound ?? { outcome: 'ignored', duplicate: false, clinic: null }),
    reminderChannels: vi.fn(async () => ({ email: true, text: null, textReason: 'texts_disabled' })),
    claimReminderText: vi.fn(async (ref: string) => { if (claims.has(ref)) return false; claims.add(ref); return true; }),
    settleReminderText: vi.fn(async (ref: string, outcome: unknown) => { settled.push([ref, outcome]); }),
  };
  return { ledger, recorded, settled };
}
const directory = (reply: Awaited<ReturnType<import('./notification-providers').PatientEmailDirectory['emailFor']>> = { kind: 'address', address: 'ava@fictional.example', suppressed: false }) => ({ emailFor: vi.fn(async () => reply) });
// 12:00 in Los Angeles (PDT) and 03:00 the same night.
const NOON = new Date('2026-10-13T19:00:00Z'), NIGHT = new Date('2026-10-13T10:00:00Z');

describe('the notice dispatcher', () => {
  it('sends the fixed wording to the address from the identity directory and records each outcome', async () => {
    const senders = createFictionalSenders();
    const { ledger, recorded } = scriptedLedger([email(1, ['lab_result', 'message']), sms(2)]);
    const pass = await createNoticeDispatcher({ ledger, directory: directory(), email: senders.email, text: senders.text, origin: ORIGIN, now: () => NOON }).run();
    expect(pass).toMatchObject({ ok: true, formed: 1 });
    expect(senders.outbox).toEqual([
      { channel: 'email', to: 'ava@fictional.example', subject: 'Something new is waiting for you', body: expect.stringContaining('Fictional Clinic has a new lab result and a new message waiting for you') },
      { channel: 'sms', to: '+15555550101', body: 'Fictional Clinic: you have a new lab result and a new form waiting in AI Longevity Pro. Sign in to see it: https://app.fictional.example/sign-in Reply STOP to stop texts, HELP for help.' },
    ]);
    expect(recorded.map(([, o]) => o.outcome)).toEqual(['sent', 'sent']);
    // The body names kinds only; the delivery record is never given any of it.
    expect(JSON.stringify(recorded)).not.toMatch(/Fictional Clinic|lab result|ava@/);
  });
  it('a text outside 08:00 to 21:00 in the patient\'s zone is deferred to the next 08:00, never sent', async () => {
    const senders = createFictionalSenders();
    const { ledger, recorded } = scriptedLedger([sms(3)]);
    await createNoticeDispatcher({ ledger, directory: directory(), email: senders.email, text: senders.text, origin: ORIGIN, now: () => NIGHT }).run();
    expect(senders.outbox).toEqual([]);
    expect(recorded).toEqual([[id(3), { outcome: 'deferred', reason: 'quiet_hours', notBefore: new Date('2026-10-13T15:00:00Z') }]]);
  });
  it('no address, a suppressed address and a carrier opt-out are skipped; a provider failure is retried, a refused request fails', async () => {
    const cases: [Parameters<typeof directory>[0], string][] = [[{ kind: 'unavailable', reason: 'no_contact' }, 'no_contact'], [{ kind: 'address', address: 'x@fictional.example', suppressed: true }, 'email_suppressed']];
    for (const [contact, reason] of cases) {
      const senders = createFictionalSenders(); const { ledger, recorded } = scriptedLedger([email(4)]);
      await createNoticeDispatcher({ ledger, directory: directory(contact), email: senders.email, text: senders.text, origin: ORIGIN, now: () => NOON }).run();
      expect(recorded[0]![1]).toEqual({ outcome: 'skipped', reason }); expect(senders.outbox).toEqual([]);
    }
    const senders = createFictionalSenders(); senders.optedOut.add('+15555550101');
    let s = scriptedLedger([sms(5)]);
    await createNoticeDispatcher({ ledger: s.ledger, directory: directory(), email: senders.email, text: senders.text, origin: ORIGIN, now: () => NOON }).run();
    expect(s.recorded[0]![1]).toEqual({ outcome: 'skipped', reason: 'carrier_opted_out' });
    senders.failNext(1); s = scriptedLedger([email(6)]);
    await createNoticeDispatcher({ ledger: s.ledger, directory: directory(), email: senders.email, text: senders.text, origin: ORIGIN, now: () => NOON }).run();
    expect(s.recorded[0]![1]).toEqual({ outcome: 'retry', reason: 'provider_unavailable' });
    s = scriptedLedger([email(7)]);
    await createNoticeDispatcher({ ledger: s.ledger, directory: directory(), email: { send: async () => ({ outcome: 'refused', detail: 'request_invalid' }) }, text: senders.text, origin: ORIGIN, now: () => NOON }).run();
    expect(s.recorded[0]![1]).toEqual({ outcome: 'failed', reason: 'provider_refused' });
  });
  it('a clinic name the template refuses fails the delivery instead of sending something else', async () => {
    const senders = createFictionalSenders(); const { ledger, recorded } = scriptedLedger([{ ...email(8), clinicName: 'Bad <b>' }]);
    await createNoticeDispatcher({ ledger, directory: directory(), email: senders.email, text: senders.text, origin: ORIGIN, now: () => NOON }).run();
    expect(recorded[0]![1]).toEqual({ outcome: 'failed', reason: 'template_refused' }); expect(senders.outbox).toEqual([]);
  });
  it('an unreachable ledger sends nothing', async () => {
    const senders = createFictionalSenders(); const { ledger } = scriptedLedger([email(9)]);
    ledger.formNotices = async () => { throw new Error('down'); };
    expect(await createNoticeDispatcher({ ledger, directory: directory(), email: senders.email, text: senders.text, origin: ORIGIN }).run()).toEqual({ ok: false, reason: 'ledger_unavailable' });
    expect(senders.outbox).toEqual([]);
  });
});

describe('inbound replies', () => {
  const topic = 'arn:aws:sns:us-east-2:111122223333:fictional-inbound-texts';
  const env = (body: string, ref = 'inbound-fictional-0001', to = '+15555550100', from = '+15555550101', topicArn = topic) => ({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: topicArn,
    Message: JSON.stringify({ originationNumber: from, destinationNumber: to, messageKeyword: 'KEYWORD', messageBody: body, inboundMessageId: ref }) } }] });
  const handler = (inbound: InboundOutcome, senders = createFictionalSenders()) => {
    const s = scriptedLedger([], inbound);
    return { s, senders, run: createInboundTextHandler({ ledger: s.ledger, text: senders.text, topicArn: topic, sendingNumbers: ['+15555550100'], platformHelpLine: '+15555550199' }) };
  };
  it('STOP is recorded with the classified word only and confirmed once; a repeat is not confirmed again', async () => {
    const h = handler({ outcome: 'stopped', duplicate: false, clinic: null });
    expect(await h.run(env(' stop. '))).toEqual({ results: [{ outcome: 'stopped', replied: true }] });
    expect(h.s.ledger.recordInbound).toHaveBeenCalledWith('+15555550101', 'stop', 'inbound-fictional-0001');
    expect(h.senders.outbox).toEqual([{ channel: 'sms', to: '+15555550101', body: expect.stringContaining('You will not receive more texts') }]);
    const again = handler({ outcome: 'stopped', duplicate: true, clinic: null });
    expect(await again.run(env('STOP'))).toEqual({ results: [{ outcome: 'stopped', replied: false }] });
    expect(again.senders.outbox).toEqual([]);
  });
  it('HELP answers with the clinic\'s line, or the platform line; START needs consent; anything else gets no reply', async () => {
    let h = handler({ outcome: 'help_clinic', duplicate: false, clinic: { displayName: 'Fictional Clinic', helpLine: '+15555550111' } });
    await h.run(env('HELP')); expect(h.senders.outbox[0]!.body).toBe('Fictional Clinic: for help, call +15555550111. Reply STOP to stop texts. Msg & data rates may apply.');
    h = handler({ outcome: 'help_platform', duplicate: false, clinic: null });
    await h.run(env('info')); expect(h.senders.outbox[0]!.body).toContain('call +15555550199');
    h = handler({ outcome: 'consent_required', duplicate: false, clinic: null });
    await h.run(env('START')); expect(h.senders.outbox[0]!.body).toContain('turn them on in the app first');
    h = handler({ outcome: 'ignored', duplicate: false, clinic: null });
    expect(await h.run(env('my result please'))).toEqual({ results: [{ outcome: 'ignored', replied: false }] });
    expect(h.s.ledger.recordInbound).toHaveBeenCalledWith('+15555550101', 'other', 'inbound-fictional-0001');
  });
  it('refuses another topic, another destination number or a malformed message, before recording anything', async () => {
    const h = handler({ outcome: 'stopped', duplicate: false, clinic: null });
    await expect(h.run(env('STOP', 'inbound-fictional-0001', '+15555550100', '+15555550101', 'arn:aws:sns:us-east-2:111122223333:other'))).rejects.toThrow('inbound_text_refused');
    await expect(h.run(env('STOP', 'inbound-fictional-0001', '+15555550188'))).rejects.toThrow('inbound_text_refused');
    await expect(h.run(env('STOP', 'x'))).rejects.toThrow('inbound_text_refused');
    await expect(h.run(env('STOP', 'inbound-fictional-0001', '+15555550100', 'not-a-number'))).rejects.toThrow('inbound_text_refused');
    expect(h.s.ledger.recordInbound).not.toHaveBeenCalled();
    expect(() => createInboundTextHandler({ ledger: h.s.ledger, text: h.senders.text, topicArn: 'topic', sendingNumbers: ['+15555550100'], platformHelpLine: '+15555550199' })).toThrow('inbound_text_configuration_invalid');
  });
});

describe('text appointment reminders', () => {
  const input = { organizationId: id(1), personId: id(2), requestId: id(3), generation: id(4), offset: '24h' as const, scheduledStart: '2026-10-14T17:30:00Z',
    text: { phone: '+15555550101', timeZone: 'America/Los_Angeles', clinicName: 'Fictional Clinic' } };
  it('sends the clinic, the local date and time and the sign-in link, once per reminder', async () => {
    const senders = createFictionalSenders(); const s = scriptedLedger([]);
    const port = createAppointmentTextReminders({ ledger: s.ledger, text: senders.text, origin: ORIGIN, now: () => NOON });
    expect(await port.sendText(input)).toEqual({ sent: true });
    expect(await port.sendText(input)).toEqual({ sent: false, reason: 'duplicate' });
    expect(senders.outbox).toEqual([{ channel: 'sms', to: '+15555550101', body: 'Fictional Clinic: reminder of your appointment on Wed, Oct 14, 10:30 AM PDT. To join or reschedule, sign in to AI Longevity Pro: https://app.fictional.example/sign-in Reply STOP to stop texts, HELP for help.' }]);
    expect(s.ledger.claimReminderText).toHaveBeenCalledWith(`appointment-reminder/2:${id(3)}:${id(4)}:24h`, id(1), id(2), '+15555550101');
    expect(s.settled).toEqual([[`appointment-reminder/2:${id(3)}:${id(4)}:24h`, { outcome: 'sent', providerRef: expect.stringMatching(/^fictional-text-/) }]]);
  });
  it('is skipped in quiet hours without claiming, and records a carrier opt-out', async () => {
    const senders = createFictionalSenders(); let s = scriptedLedger([]);
    expect(await createAppointmentTextReminders({ ledger: s.ledger, text: senders.text, origin: ORIGIN, now: () => NIGHT }).sendText(input)).toEqual({ sent: false, reason: 'quiet_hours' });
    expect(s.ledger.claimReminderText).not.toHaveBeenCalled();
    senders.optedOut.add('+15555550101'); s = scriptedLedger([]);
    expect(await createAppointmentTextReminders({ ledger: s.ledger, text: senders.text, origin: ORIGIN, now: () => NOON }).sendText(input)).toEqual({ sent: false, reason: 'carrier_opted_out' });
    expect(s.settled[0]![1]).toEqual({ outcome: 'skipped', reason: 'carrier_opted_out' });
  });
});

describe('the post-commit emitter', () => {
  const wf = { identityPool: 'workforce' } as ClinicalRequestContext, consumer = { identityPool: 'consumer' } as ClinicalRequestContext;
  it('maps only committed workforce actions that made something visible', () => {
    const c = id(10), m = id(11);
    expect(noticeSubjectsFor('care_messages', 'workforce', { action: 'send', connectionId: c }, { action: 'send', messageId: m, duplicate: false })).toEqual([{ kind: 'message', connectionId: c, messageId: m }]);
    expect(noticeSubjectsFor('care_messages', 'workforce', { action: 'send', connectionId: c }, { action: 'send', messageId: m, duplicate: true })).toEqual([]);
    expect(noticeSubjectsFor('care_messages', 'consumer', { action: 'send', connectionId: c }, { action: 'send', messageId: m, duplicate: false })).toEqual([]);
    expect(noticeSubjectsFor('intake_packets_workforce', 'workforce', { action: 'assign', connectionId: c }, { action: 'assign', packetId: m, status: 'open' })).toEqual([{ kind: 'form', connectionId: c, packetId: m }]);
    expect(noticeSubjectsFor('intake_packets_workforce', 'workforce', { action: 'cancel', packetId: m }, { action: 'cancel', packetId: m, status: 'cancelled' })).toEqual([]);
    expect(noticeSubjectsFor('program_assignments', 'workforce', { action: 'assign', connectionId: c }, { action: 'assign', enrollmentId: m })).toEqual([{ kind: 'program_lesson', enrollmentId: m }]);
    expect(noticeSubjectsFor('program_assignments', 'workforce', { action: 'release', enrollmentId: m, phaseId: 'phase-2' }, { action: 'release', enrollmentId: m, phaseId: 'phase-2' })).toEqual([{ kind: 'program_lesson', enrollmentId: m, phaseId: 'phase-2' }]);
    expect(noticeSubjectsFor('program_assignments', 'workforce', { action: 'status' }, { action: 'status', assignments: [] })).toEqual([]);
    expect(noticeSubjectsFor('review_lab', 'workforce', { eventId: c, decision: 'accept' }, { eventId: c, state: 'accepted', observationId: m, duplicate: false })).toEqual([{ kind: 'lab_result', observationId: m }]);
    expect(noticeSubjectsFor('review_lab', 'workforce', { eventId: c, decision: 'reject', note: 'x' }, { eventId: c, state: 'rejected', duplicate: false })).toEqual([]);
    expect(noticeSubjectsFor('review_lab', 'workforce', { eventId: c, decision: 'accept' }, { eventId: c, state: 'accepted', observationId: m, duplicate: true })).toEqual([]);
  });
  it('never throws and never touches the reply, whatever the enqueue does', async () => {
    const report = vi.fn();
    const failing = createNoticeEmitter(async () => { throw new Error('service_unavailable'); }, report);
    await expect(failing(wf, 'care_messages', { action: 'send', connectionId: id(1) }, { action: 'send', messageId: id(2), duplicate: false })).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith({ kind: 'message', outcome: 'service_unavailable' });
    const enqueue = vi.fn(async () => ({ queued: true as const, duplicate: false }));
    await createNoticeEmitter(enqueue)(consumer, 'care_messages', { action: 'send', connectionId: id(1) }, { action: 'send', messageId: id(2), duplicate: false });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('the AWS senders (no network)', () => {
  it('build exactly one SES or End User Messaging request and map an opted-out destination', async () => {
    const ses = { send: vi.fn(async (_: unknown) => ({ MessageId: 'ses-fictional' })) };
    const config = sesNotificationConfig({ region: 'us-east-2', sender: 'no-reply@fictional.example', configurationSet: 'alp-patient-notices' })!;
    expect(await createSesEmailSender(config, ses as never).send({ to: 'ava@fictional.example', subject: 's', text: 't' })).toEqual({ outcome: 'accepted', providerRef: 'ses-fictional' });
    expect((ses.send.mock.calls[0]![0] as { input: unknown }).input).toEqual({ FromEmailAddress: 'no-reply@fictional.example', ConfigurationSetName: 'alp-patient-notices',
      Destination: { ToAddresses: ['ava@fictional.example'] }, Content: { Simple: { Subject: { Data: 's' }, Body: { Text: { Data: 't' } } } } });
    const textConfig = textNotificationConfig({ region: 'us-east-2', originationIdentity: '+15555550100', configurationSet: 'alp-patient-texts' })!;
    const sms = { send: vi.fn(async (_: unknown) => ({ MessageId: 'sms-fictional' })) };
    expect(await createEndUserMessagingTextSender(textConfig, sms as never).send({ to: '+15555550101', body: 'b' })).toEqual({ outcome: 'accepted', providerRef: 'sms-fictional' });
    expect((sms.send.mock.calls[0]![0] as { input: unknown }).input).toEqual({ DestinationPhoneNumber: '+15555550101', OriginationIdentity: '+15555550100', MessageBody: 'b', MessageType: 'TRANSACTIONAL', ConfigurationSetName: 'alp-patient-texts' });
    const optedOut = { send: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'ConflictException', Reason: 'DESTINATION_PHONE_NUMBER_OPTED_OUT' }); }) };
    expect(await createEndUserMessagingTextSender(textConfig, optedOut as never).send({ to: '+15555550101', body: 'b' })).toEqual({ outcome: 'opted_out' });
    expect(await createEndUserMessagingTextSender(textConfig, sms as never).send({ to: '+15555550101', body: 'x'.repeat(307) })).toEqual({ outcome: 'refused', detail: 'request_invalid' });
  });
  it('refuse an incomplete configuration', () => {
    expect(sesNotificationConfig({ region: 'us-east-2', sender: 'no-reply@fictional.example' })).toBeNull();
    expect(textNotificationConfig({ region: 'us-east-2', originationIdentity: 'my-number', configurationSet: 'x' })).toBeNull();
  });
});
