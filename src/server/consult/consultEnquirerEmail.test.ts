import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { consultEnquirerEmailConfig, createSesEnquirerMailer, receivedEmail, sendReceivedEmail } from './consultEnquirerEmail';

/**
 * "We received your request": off by default, sent only through the clinic's `alp-transactional` set, and it
 * repeats nothing the visitor chose. Fictional addresses only.
 */
const env = { CONSULT_ENQUIRER_EMAILS_ENABLED: 'true', CONSULT_ENQUIRER_SENDER: 'Fictional Clinic <hello@clinic.fictional.example>',
  CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional', CONSULT_ENQUIRER_CONTACT_LINE: 'call (555) 010-0000 or write to hello@clinic.fictional.example' };

describe('the received email settings', () => {
  it('are off unless explicitly true, and refuse an incomplete configuration or any set but alp-transactional', () => {
    expect(consultEnquirerEmailConfig({})).toEqual({ ok: false, reason: 'disabled' });
    for (const value of ['false', '1', 'yes', 'TRUE', '']) expect(consultEnquirerEmailConfig({ ...env, CONSULT_ENQUIRER_EMAILS_ENABLED: value })).toEqual({ ok: false, reason: 'disabled' });
    expect(consultEnquirerEmailConfig(env)).toMatchObject({ ok: true, config: { configurationSet: 'alp-transactional' } });
    for (const broken of [{ CONSULT_ENQUIRER_SENDER: '' }, { CONSULT_ENQUIRER_SENDER: 'not an address' }, { CONSULT_ENQUIRER_CONFIGURATION_SET: '' },
      { CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-marketing' }, { CONSULT_ENQUIRER_CONTACT_LINE: '' }, { CONSULT_ENQUIRER_CONTACT_LINE: '<a href=x>' }]) {
      expect(consultEnquirerEmailConfig({ ...env, ...broken }), JSON.stringify(broken)).toEqual({ ok: false, reason: 'incomplete' });
    }
  });
});

describe('the received email', () => {
  it('names the clinic, says someone will reply about a time, gives the contact line, and repeats nothing the visitor chose', () => {
    const email = receivedEmail({ clinic: 'Fictional Clinic', contactLine: env.CONSULT_ENQUIRER_CONTACT_LINE });
    expect(email.subject).toBe('We received your consultation request');
    expect(email.text).toBe('Fictional Clinic received your request for a consultation.\n\n'
      + 'Someone from the clinic will reply to you about a time. You do not need to do anything else for now.\n\n'
      + `If you need to reach the clinic: ${env.CONSULT_ENQUIRER_CONTACT_LINE}\n\n`
      + 'Please do not reply to this email with health information.\n');
    expect(email.text).not.toMatch(/program|longevity|weight|diabetes|lab|supplement|insurance|initial|follow|urgent|reference|preferred|Ava/i);
  });
  it('is sent once, to the address typed, through alp-transactional only', async () => {
    const send = vi.fn(async () => ({ MessageId: 'fictional' }));
    const resolved = consultEnquirerEmailConfig(env);
    if (!resolved.ok) throw new Error('config');
    expect(await createSesEnquirerMailer(resolved.config, { send } as never)('ava.fictional@example.test', receivedEmail({ clinic: 'Fictional Clinic', contactLine: env.CONSULT_ENQUIRER_CONTACT_LINE }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [{ input: unknown }])[0].input).toMatchObject({ FromEmailAddress: env.CONSULT_ENQUIRER_SENDER, ConfigurationSetName: 'alp-transactional',
      Destination: { ToAddresses: ['ava.fictional@example.test'] } });
  });
  it('never throws: disabled, an unknown clinic, a failing or slow mailer are outcomes, not errors', async () => {
    const mailer = vi.fn(async () => true);
    expect(await sendReceivedEmail({ env: {}, to: 'ava.fictional@example.test', clinic: async () => 'Fictional Clinic', mailer: () => mailer })).toBe('disabled');
    expect(await sendReceivedEmail({ env: { ...env, CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-marketing' }, to: 'x@example.test', clinic: async () => 'Fictional Clinic', mailer: () => mailer })).toBe('incomplete');
    expect(await sendReceivedEmail({ env, to: 'x@example.test', clinic: async () => null, mailer: () => mailer })).toBe('clinic_unknown');
    expect(await sendReceivedEmail({ env, to: 'x@example.test', clinic: async () => { throw new Error('down'); }, mailer: () => mailer })).toBe('failed');
    expect(mailer).not.toHaveBeenCalled();
    expect(await sendReceivedEmail({ env, to: 'x@example.test', clinic: async () => 'Fictional Clinic', mailer: () => async () => { throw new Error('ses'); } })).toBe('failed');
    expect(await sendReceivedEmail({ env, to: 'x@example.test', clinic: async () => 'Fictional Clinic', mailer: () => () => new Promise(() => undefined), timeoutMs: 10 })).toBe('failed');
    expect(await sendReceivedEmail({ env, to: 'x@example.test', clinic: async () => 'Fictional Clinic', mailer: () => mailer })).toBe('sent');
  });
  it('lives on the clinical side only: it knows nothing of the campaign service and no list', () => {
    const source = readFileSync('src/server/consult/consultEnquirerEmail.ts', 'utf8');
    expect([...source.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])).toEqual(['@aws-sdk/client-sesv2']);
    expect(source).not.toMatch(/dittofeed|DFSubscription|subscriptionGroup/i);
    expect(source).not.toMatch(/console\./);
  });
});
