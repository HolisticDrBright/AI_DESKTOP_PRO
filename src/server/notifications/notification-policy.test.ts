import { describe, expect, it } from 'vitest';
import { defaultNotificationPreferences, NOTICE_KINDS, patientNotificationPreferences, textConsent } from '@/contracts/patientNotifications';
import {
  batchVisibleItems, classifyInboundText, helpText, nextTextWindow, noticeChannels, noticeEmail, noticeText, reminderText, signInLink, withinTextHours,
} from './notification-policy';

/** The notification rules as pure functions, with fictional patients, addresses and numbers only. */
const ORIGIN = 'https://app.fictional.example';
const consent = { phone: '+15555550123', wordingVersion: 'text-consent/1', wordingSha256: 'a'.repeat(64), agreedAt: '2026-10-13T00:00:00Z', source: 'patient_app' as const };
const contact = { email: 'patient@fictional.example', phone: '+15555550123', timeZone: 'America/Los_Angeles', clinicName: 'Fictional Clinic' };
const clear = { emailSuppressed: false, textStopped: false };

describe('defaults and preferences', () => {
  it('reminders and every kind of notice by email; nothing by text or push until the patient chooses', () => {
    const prefs = defaultNotificationPreferences();
    expect(patientNotificationPreferences.parse(prefs)).toEqual(prefs);
    expect(prefs.appointmentReminders).toEqual({ email: true, sms: false });
    for (const kind of NOTICE_KINDS) expect(prefs.notices[kind]).toEqual({ email: true, sms: false, push: false });
  });
  it('each kind is a separate preference; an unknown kind or field is refused', () => {
    const prefs = defaultNotificationPreferences();
    expect(patientNotificationPreferences.safeParse({ ...prefs, notices: { ...prefs.notices, marketing: { email: true, sms: false, push: false } } }).success).toBe(false);
    expect(patientNotificationPreferences.safeParse({ ...prefs, appointmentReminders: { email: true, sms: false, voice: true } }).success).toBe(false);
  });
  it('text consent names one number and the exact wording agreed to', () => {
    expect(textConsent.safeParse(consent).success).toBe(true);
    expect(textConsent.safeParse({ ...consent, phone: '5555550123' }).success).toBe(false);
    expect(textConsent.safeParse({ ...consent, wordingSha256: 'x' }).success).toBe(false);
  });
});

describe('quiet hours in the patient\'s time zone', () => {
  it('allows 08:00 up to 21:00 local and nothing else', () => {
    const tz = 'America/Los_Angeles';
    expect(withinTextHours(new Date('2026-10-13T14:59:00Z'), tz)).toBe(false); // 07:59 PDT
    expect(withinTextHours(new Date('2026-10-13T15:00:00Z'), tz)).toBe(true);  // 08:00 PDT
    expect(withinTextHours(new Date('2026-10-14T03:59:00Z'), tz)).toBe(true);  // 20:59 PDT
    expect(withinTextHours(new Date('2026-10-14T04:00:00Z'), tz)).toBe(false); // 21:00 PDT
  });
  it('defers to the next 08:00 local, today or tomorrow, across a daylight-saving change', () => {
    const tz = 'America/New_York';
    expect(nextTextWindow(new Date('2026-10-13T10:00:00Z'), tz).toISOString()).toBe('2026-10-13T12:00:00.000Z'); // 06:00 EDT -> 08:00 EDT
    expect(nextTextWindow(new Date('2026-10-14T02:00:00Z'), tz).toISOString()).toBe('2026-10-14T12:00:00.000Z'); // 22:00 EDT -> next day 08:00
    expect(nextTextWindow(new Date('2026-10-13T16:00:00Z'), tz).toISOString()).toBe('2026-10-13T16:00:00.000Z'); // inside the window
    // 22:00 EDT on the Saturday before clocks go back -> 08:00 EST on Sunday (13:00Z).
    expect(nextTextWindow(new Date('2026-11-01T02:00:00Z'), tz).toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(nextTextWindow(new Date('2026-10-13T20:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-10-14T02:30:00.000Z'); // 01:30 IST -> 08:00 IST
  });
});

describe('inbound replies', () => {
  it('reads STOP, HELP and START words, nothing else', () => {
    for (const word of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'cancel', 'END', 'quit', 'stop.']) expect(classifyInboundText(word), word).toBe('stop');
    for (const word of ['HELP', 'info']) expect(classifyInboundText(word)).toBe('help');
    for (const word of ['START', 'unstop']) expect(classifyInboundText(word)).toBe('start');
    for (const word of ['please stop texting me tomorrow', 'yes', '', 'STOP NOW']) expect(classifyInboundText(word), word).toBe('other');
  });
});

describe('batching', () => {
  const at = (minutes: number) => new Date(Date.parse('2026-10-13T16:00:00Z') + minutes * 60_000).toISOString();
  it('items close together make one notice, each kind once, and only after the window closes', () => {
    const items = [
      { eventId: 'e1', patientId: 'p1', kind: 'message' as const, visibleAt: at(0) },
      { eventId: 'e2', patientId: 'p1', kind: 'lab_result' as const, visibleAt: at(2) },
      { eventId: 'e3', patientId: 'p1', kind: 'message' as const, visibleAt: at(4) },
      { eventId: 'e4', patientId: 'p2', kind: 'form' as const, visibleAt: at(9) },
    ];
    expect(batchVisibleItems(items, new Date(at(9)), 10 * 60_000)).toEqual([]);
    expect(batchVisibleItems(items, new Date(at(10)), 10 * 60_000)).toEqual([{ patientId: 'p1', kinds: ['lab_result', 'message'], eventIds: ['e1', 'e2', 'e3'], firstVisibleAt: at(0) }]);
    expect(batchVisibleItems(items, new Date(at(19)), 10 * 60_000).map(b => b.patientId)).toEqual(['p1', 'p2']);
  });
});

describe('channels', () => {
  const prefs = defaultNotificationPreferences();
  it('email by default; a text only with consent at that exact number, no STOP, a time zone and the preference', () => {
    expect(noticeChannels(['message'], prefs, contact, null, clear)).toEqual([{ channel: 'email', kinds: ['message'], to: contact.email }]);
    const textOn = { ...prefs, notices: { ...prefs.notices, message: { email: false, sms: true, push: false as const } } };
    expect(noticeChannels(['message', 'form'], textOn, contact, consent, clear)).toEqual([{ channel: 'email', kinds: ['form'], to: contact.email }, { channel: 'sms', kinds: ['message'], to: contact.phone }]);
    expect(noticeChannels(['message'], textOn, { ...contact, phone: '+15555550199' }, consent, clear)).toEqual([]);
    expect(noticeChannels(['message'], textOn, contact, consent, { ...clear, textStopped: true })).toEqual([]);
    expect(noticeChannels(['message'], textOn, { ...contact, timeZone: null }, consent, clear)).toEqual([]);
  });
  it('a suppressed address gets no email; a kind turned off is not sent on any channel', () => {
    expect(noticeChannels(['message'], prefs, contact, null, { ...clear, emailSuppressed: true })).toEqual([]);
    const off = { ...prefs, notices: { ...prefs.notices, lab_result: { email: false, sms: false, push: false as const } } };
    expect(noticeChannels(['lab_result'], off, contact, consent, clear)).toEqual([]);
  });
});

describe('wording', () => {
  it('names only the kinds, in fixed words, with a sign-in link that carries nothing', () => {
    const email = noticeEmail(['message', 'lab_result'], 'Fictional Clinic', ORIGIN);
    expect(email.subject).toBe('Something new is waiting for you');
    expect(email.text).toContain('Fictional Clinic has a new lab result and a new message waiting for you in AI Longevity Pro.');
    expect(email.text).toContain('Sign in to see it: https://app.fictional.example/sign-in');
    expect(noticeText(['form', 'protocol', 'program_lesson'], 'Fictional Clinic', ORIGIN))
      .toBe('Fictional Clinic: you have a new protocol, a new form and a new program lesson waiting in AI Longevity Pro. Sign in to see it: https://app.fictional.example/sign-in Reply STOP to stop texts, HELP for help.');
    for (const origin of ['http://app.fictional.example', 'https://app.fictional.example/?token=x', 'https://user@app.fictional.example', 'https://app.fictional.example/path']) expect(() => signInLink(origin), origin).toThrow();
    expect(() => noticeEmail([], 'Fictional Clinic', ORIGIN)).toThrow();
    expect(() => noticeEmail(['message'], 'Fictional <b>Clinic</b>', ORIGIN)).toThrow();
  });
  it('a text reminder names the clinic and the local date and time, and nothing about the visit', () => {
    const text = reminderText('Fictional Clinic', new Date('2026-10-14T17:30:00Z'), 'America/Los_Angeles', ORIGIN);
    expect(text).toBe('Fictional Clinic: reminder of your appointment on Wed, Oct 14, 10:30 AM PDT. To join or reschedule, sign in to AI Longevity Pro: https://app.fictional.example/sign-in Reply STOP to stop texts, HELP for help.');
    expect(helpText('Fictional Clinic', '+15555550100')).toContain('call +15555550100');
    expect(() => helpText('Fictional Clinic', 'call us')).toThrow();
  });
  it('a text stays within two SMS segments with the longest clinic name', () => {
    const longest = 'A'.repeat(80);
    expect(noticeText([...NOTICE_KINDS], longest, ORIGIN).length).toBeLessThanOrEqual(306);
    expect(reminderText(longest, new Date('2026-10-14T17:30:00Z'), 'America/Los_Angeles', ORIGIN).length).toBeLessThanOrEqual(306);
  });
});
