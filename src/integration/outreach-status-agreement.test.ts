import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allFunnels } from '@/funnels';
import { consultEnquirerEmailConfig } from '@/server/consult/consultEnquirerEmail';
import { campaignEngineEnabled } from '@/server/campaign-api';
import { patientNotificationSwitches, PATIENT_NOTIFICATION_SWITCH_NAMES } from '@/server/notifications/notification-switches';
import { OUTREACH_STEPS, outreachRows, type EngineRead } from '@/server/outreach-status';

/**
 * On the integrated line the Outreach status screen and the code that actually sends agree: a row reads On exactly
 * when the reader its workstream ships says the piece is on, and every outreach switch any workstream added has a row.
 * Fictional values only.
 */
const rows = (env: Record<string, string>, engine: EngineRead = { kind: 'switched_off' }) =>
  outreachRows({ env, funnels: allFunnels(), engine, signup: { kind: 'not_set' }, offers: { kind: 'disabled', reason: 'commerce_disabled' } });
const state = (env: Record<string, string>, id: string) => rows(env).find(r => r.id === id)!.state;

describe('the Outreach status screen agrees with the readers that send', () => {
  it('"we received your request" is On exactly when the consult route would send it', () => {
    const complete = { CONSULT_ENQUIRER_EMAILS_ENABLED: 'true', CONSULT_ENQUIRER_SENDER: 'Fictional Clinic <hello@clinic.fictional.example>',
      CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional', CONSULT_ENQUIRER_CONTACT_LINE: 'call (555) 010-0000 during office hours' };
    const cases: Record<string, string>[] = [{}, complete, { ...complete, CONSULT_ENQUIRER_EMAILS_ENABLED: 'yes' }, { ...complete, CONSULT_ENQUIRER_SENDER: '' },
      { ...complete, CONSULT_ENQUIRER_SENDER: 'not an address' }, { ...complete, CONSULT_ENQUIRER_CONTACT_LINE: 'short' }, { ...complete, CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-marketing' }];
    for (const env of cases) expect(state(env, 'consult-received-email'), JSON.stringify(env)).toBe(consultEnquirerEmailConfig(env).ok ? 'on' : 'off');
    expect(rows({ ...complete, CONSULT_ENQUIRER_SENDER: 'not an address' }).find(r => r.id === 'consult-received-email')!.reading).toContain('not in a form the email accepts');
  });
  it('the Desktop\'s notification-choices view is On exactly when its switch is', () => {
    for (const value of ['', 'true', 'TRUE', '1', ' true ']) {
      const env = { NOTIFICATION_PREFERENCES_ENABLED: value };
      expect(state(env, 'notification-preferences-desktop'), value).toBe(patientNotificationSwitches(env).NOTIFICATION_PREFERENCES_ENABLED ? 'on' : 'off');
    }
  });
  it('the campaign engine row is never On while the Desktop\'s switch is off', () => {
    for (const value of ['', 'false', 'TRUE', 'true']) {
      const env = { CAMPAIGN_ENGINE_ENABLED: value, CAMPAIGN_API_ORIGIN: 'https://abcdefghij.execute-api.us-east-2.amazonaws.com' };
      if (!campaignEngineEnabled(env)) expect(state(env, 'campaign-engine'), value).toBe('off');
    }
  });
  it('every outreach switch any workstream added has a row, and is off in .env.example', () => {
    const settings = OUTREACH_STEPS.map(s => s.setting).join(' ');
    const added = ['CAMPAIGN_ENGINE_ENABLED', 'CAMPAIGN_API_ORIGIN', 'FUNNEL_PRACTICE_SLUG', 'CONSULT_ENQUIRER_EMAILS_ENABLED', 'REMINDERS_ENABLED', 'NOTIFICATION_SETTINGS_RELEASED', ...PATIENT_NOTIFICATION_SWITCH_NAMES];
    for (const name of added) expect(settings, name).toContain(`\`${name}\``);
    const example = readFileSync('.env.example', 'utf8');
    for (const name of ['CAMPAIGN_ENGINE_ENABLED', 'CONSULT_ENQUIRER_EMAILS_ENABLED']) expect(example, name).toMatch(new RegExp(`^${name}=false$`, 'm'));
    for (const name of PATIENT_NOTIFICATION_SWITCH_NAMES) expect(example, name).not.toMatch(new RegExp(`^${name}=true`, 'm'));
  });
});
