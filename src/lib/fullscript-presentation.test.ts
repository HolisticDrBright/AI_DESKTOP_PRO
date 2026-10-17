import { describe, expect, it } from 'vitest';
import { FULLSCRIPT_INTEGRATE_URL, FULLSCRIPT_RECONNECT_COPY, fullscriptConnectionCopy, fullscriptPanelState, readFullscriptCallbackOutcome, type FullscriptPosture } from './fullscript-presentation';

describe('Fullscript connection presentation', () => {
  it('does not imply a production login will work against the sandbox identity system', () => {
    const copy = fullscriptConnectionCopy('sandbox_us');
    expect(copy.button).toBe('Connect Fullscript sandbox');
    expect(copy.guidance).toContain('normal Fullscript practitioner email and password may not work');
    expect(copy.failure).toContain('sandbox practitioner or staff account');
  });

  it('keeps the production and unconfigured messages distinct', () => {
    expect(fullscriptConnectionCopy('production_us').guidance).not.toContain('sandbox');
    expect(fullscriptConnectionCopy(null).guidance).toContain('configured');
    expect(FULLSCRIPT_INTEGRATE_URL).toBe('https://fullscript.dev');
  });
});

describe('the Fullscript card states', () => {
  const ready: FullscriptPosture = { configured: true, connected: false, environment: 'sandbox_us' };
  const state = (posture: FullscriptPosture | null, extra: Partial<Parameters<typeof fullscriptPanelState>[0]> = {}) =>
    fullscriptPanelState({ posture, loadError: null, outcome: null, busy: null, ...extra });

  it('an outage is "Unavailable": never "Not configured" or "Ready to connect", nothing offered, no setup steps (failing before: "Not configured")', () => {
    for (const posture of [null, ready, { ...ready, connected: true }, { configured: false, connected: false, environment: null } as FullscriptPosture]) {
      const s = state(posture, { loadError: 'Fullscript status could not be read.' });
      expect(s).toMatchObject({ badge: 'Unavailable', showConnect: false, connectEnabled: false, showDisconnect: false, setupHint: null, reconnectMessage: null });
    }
  });
  it('a deployment without Fullscript is "Not configured", with the setup steps, and nothing to press', () => {
    expect(state({ configured: false, connected: false, environment: null, reason: 'not_configured' }))
      .toMatchObject({ badge: 'Not configured', showConnect: true, connectEnabled: false, setupHint: expect.stringContaining('AWS secret') });
  });
  it('ready, connecting, connected and disconnecting', () => {
    expect(state(ready)).toMatchObject({ badge: 'Ready to connect', connectEnabled: true, showDisconnect: false, setupHint: null });
    expect(state(ready, { busy: 'connecting' })).toMatchObject({ badge: 'Connecting\u2026', connectEnabled: false });
    expect(state({ ...ready, connected: true })).toMatchObject({ badge: 'Connected', showConnect: false, showDisconnect: true, disconnectEnabled: true });
    expect(state({ ...ready, connected: true }, { busy: 'disconnecting' })).toMatchObject({ badge: 'Disconnecting\u2026', disconnectEnabled: false });
  });
  it('a reconnect names its own reason (failing before: the email-key text for both)', () => {
    expect(state({ ...ready, reconnectRequired: true, reconnectReason: 'membership_changed' }))
      .toMatchObject({ badge: 'Reconnect needed', connectEnabled: true, reconnectMessage: FULLSCRIPT_RECONNECT_COPY.membership_changed });
    expect(state({ ...ready, reconnectRequired: true, reconnectReason: 'account_binding' }).reconnectMessage).toBe(FULLSCRIPT_RECONNECT_COPY.account_binding);
    expect(FULLSCRIPT_RECONNECT_COPY.membership_changed).not.toBe(FULLSCRIPT_RECONNECT_COPY.account_binding);
  });
  it('only "not authorized" blames the authorization; a used link beside a live connection says nothing changed', () => {
    const connected = { ...ready, connected: true };
    expect(state(connected, { outcome: 'link_used' })).toMatchObject({ badge: 'Connected', notice: expect.stringContaining('nothing was changed') });
    expect(state(ready, { outcome: 'not_authorized' }).notice).toBe(fullscriptConnectionCopy('sandbox_us').failure);
    for (const outcome of ['already_connected', 'link_used', 'session_changed', 'unavailable'] as const) {
      expect(state(ready, { outcome }).notice).not.toBe(fullscriptConnectionCopy('sandbox_us').failure);
    }
    expect(state(connected, { outcome: 'connected' }).notice).toBeNull();
  });
  it('reads only the closed set from the address bar', () => {
    expect(readFullscriptCallbackOutcome('link_used')).toBe('link_used');
    expect(readFullscriptCallbackOutcome('connection_failed')).toBe('connection_failed');
    for (const value of [null, '', 'connected ', '<script>', 'CONNECTED']) expect(readFullscriptCallbackOutcome(value)).toBeNull();
  });
});
