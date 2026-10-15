import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { defaultNotificationPreferences, type ClinicNotificationSettingsView } from '@/contracts/patientNotifications';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { PatientNotificationChoicesView, type PatientNotificationChoicesState } from './PatientNotificationChoicesView';

/**
 * The clinic's read-only view of a linked patient's reminder and notice choices. What matters: staff can
 * see the choices and cannot change them; a failed read never looks like "chose nothing"; nothing
 * recorded reads "Unknown"; and a text that is switched on but cannot be sent says so. Fictional only.
 */
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const base: ClinicNotificationSettingsView = { contract: 'patient-notifications/1', connectionId: CONNECTION, preferences: defaultNotificationPreferences(),
  timeZone: 'America/Los_Angeles', textConsent: null, textStopped: false, pushAvailable: false };
const view = (state: PatientNotificationChoicesState) => createElement(PatientNotificationChoicesView, { state, busy: false, onRefresh: () => {} });
const withTexts = (over: Partial<ClinicNotificationSettingsView> = {}): ClinicNotificationSettingsView => {
  const preferences = defaultNotificationPreferences();
  preferences.appointmentReminders.sms = true; preferences.notices.lab_result.sms = true; preferences.notices.message.email = false;
  return { ...base, preferences, textConsent: { phoneLastTwo: '01', wordingVersion: 'text-consent/1', agreedAt: '2026-10-01T16:00:00.000Z' }, ...over };
};

describe('the patient notification choices view', () => {
  it('has no control that changes a choice, in any state, and says only the patient can turn on texts', () => {
    for (const state of [{ status: 'loading' }, { status: 'unavailable' }, { status: 'refused' }, { status: 'loaded', view: withTexts() }] as PatientNotificationChoicesState[]) {
      const markup = renderToMarkup(view(state));
      expect(markup).not.toMatch(/<input|<select|<textarea|type="checkbox"|role="switch"/);
      expect(markup.match(/<button/g)?.length, state.status).toBe(1);
      expect(renderToText(view(state))).toContain('Only the patient can turn on texts, from the app');
    }
    // The one button reads; nothing offers to turn anything on for the patient.
    expect(renderToMarkup(view({ status: 'loaded', view: base }))).toMatch(/<button[^>]*>Load the patient(&#x27;|')s choices<\/button>/);
    expect(renderToText(view({ status: 'loaded', view: base }))).not.toMatch(/Opt (them|the patient) in|Enable texts|Turn on texts for/i);
  });
  it('loading, unavailable, refused and loaded are four different things on screen', () => {
    const ids = ['loading', 'unavailable', 'refused', 'loaded'].map(status => renderToMarkup(view(
      status === 'loaded' ? { status: 'loaded', view: base } : { status } as PatientNotificationChoicesState)));
    expect(ids[0]).toContain('data-testid="patient-notification-choices-loading"');
    expect(ids[1]).toContain('data-testid="patient-notification-choices-unavailable"');
    expect(ids[2]).toContain('data-testid="patient-notification-choices-refused"');
    expect(ids[3]).toContain('data-testid="patient-notification-choices-loaded"');
    expect(renderToText(view({ status: 'unavailable' }))).toContain('This does not mean they chose nothing.');
    expect(ids[1]).not.toContain('choice-');
  });
  it('shows each kind with the fixed phrase, email and text, and push as not available', () => {
    const text = renderToText(view({ status: 'loaded', view: withTexts() }));
    for (const phrase of ['Appointment reminders', 'A new lab result', 'A new protocol', 'A new message', 'A new form', 'A new program lesson']) expect(text).toContain(phrase);
    const markup = renderToMarkup(view({ status: 'loaded', view: withTexts() }));
    expect(markup).toMatch(/data-testid="choice-message"><td>A new message<\/td><td>Off<\/td><td>Off<\/td><td>Not available<\/td>/);
    expect(markup).toMatch(/data-testid="choice-lab_result"><td>A new lab result<\/td><td>On<\/td><td>On<\/td>/);
    expect(text).toContain('Agreed to texts at a number ending 01 on Oct 1, 2026 (wording text-consent/1).');
    expect(text).not.toMatch(/\+1555/);
  });
  it('a text switched on is not a text sent: no agreement, or STOP, says so', () => {
    const noAgreement = renderToMarkup(view({ status: 'loaded', view: withTexts({ textConsent: null }) }));
    expect(noAgreement).toMatch(/choice-lab_result"><td>A new lab result<\/td><td>On<\/td><td>On, but not sent: no agreement on record<\/td>/);
    expect(renderToText(view({ status: 'loaded', view: withTexts({ textConsent: null }) }))).toContain('Has not agreed to texts. No text is sent.');
    const stopped = renderToText(view({ status: 'loaded', view: withTexts({ textStopped: true }) }));
    expect(stopped).toContain('On, but stopped: the patient replied STOP');
    expect(stopped).toContain('Replied STOP. No text is sent until they agree again from the app.');
  });
  it('a time zone nobody recorded reads Unknown, never blank or None', () => {
    const text = renderToText(view({ status: 'loaded', view: { ...base, timeZone: null } }));
    expect(text).toContain('Time zone: Unknown. No text is sent without one.');
    expect(text).not.toMatch(/Time zone: (None|\s*$)/);
  });
  it('the panel is mounted beside a linked patient only when the server says the switch is on', () => {
    const panel = readFileSync('src/components/programs/AppProgramAssignmentsPanel.tsx', 'utf8');
    expect(panel).toContain('{notificationChoices&&connectionId.trim()?<PatientNotificationChoicesPanel');
    expect(panel).toContain('notificationChoices=false');
    const page = readFileSync('src/app/inbox/page.tsx', 'utf8');
    expect(page).toContain('notificationChoices={patientNotificationSwitches(process.env).NOTIFICATION_PREFERENCES_ENABLED}');
    const client = readFileSync('src/components/notifications/PatientNotificationChoicesPanel.tsx', 'utf8');
    expect(client).toContain('JSON.stringify({ action: "read", connectionId })');
    expect(client).not.toMatch(/action: "(save|consent|withdraw)"/);
  });
});
