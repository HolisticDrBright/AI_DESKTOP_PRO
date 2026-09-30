import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_BUSY_WINDOW_DAYS,
  assertCallback,
  buildAuthorizationStart,
  codeChallengeFor,
  describeTransportFailure,
  exchangeAuthorizationCode,
  newAuthorizationEntropy,
  openCalendarToken,
  readBusyIntervals,
  readCalendarConfiguration,
  refreshAccessToken,
  sealCalendarToken,
  type CalendarConfiguration,
  type FormPost,
  type JsonPost,
  type TransportDependencies,
} from './externalCalendarTransport';
import type { CalendarConnection } from './externalCalendarSync';

const ARN = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:external-calendar/client-abc123';
const READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';

const environment = (overrides: Record<string, string | undefined> = {}) => ({
  EXTERNAL_CALENDAR_ENABLED: '1',
  EXTERNAL_CALENDAR_PROVIDER: 'google',
  EXTERNAL_CALENDAR_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  EXTERNAL_CALENDAR_CLIENT_SECRET_ARN: ARN,
  EXTERNAL_CALENDAR_REDIRECT_URI: 'https://desktop.example/api/live/calendar-connection/callback',
  EXTERNAL_CALENDAR_SCOPES: `${READ_SCOPE} ${FREEBUSY_SCOPE}`,
  ...overrides,
});

const configuration = (): CalendarConfiguration => {
  const outcome = readCalendarConfiguration(environment());
  if (!outcome.ok) throw new Error(`configuration refused: ${outcome.refusal}`);
  return outcome.value;
};

const connected = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  state: 'connected',
  scopes: [READ_SCOPE, FREEBUSY_SCOPE],
  expiresAt: '2026-10-01T12:00:00.000Z',
  hasRefreshToken: true,
  ...overrides,
});

const dependencies = (postForm: FormPost, now = '2026-10-01T11:00:00.000Z'): TransportDependencies => ({
  postForm,
  clientSecret: async () => 'client-secret-value',
  now: () => new Date(now),
});

const tokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: `${READ_SCOPE} ${FREEBUSY_SCOPE}`,
  ...overrides,
});

describe('external calendar configuration', () => {
  it('stays off unless it is explicitly enabled', () => {
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_ENABLED: undefined }))).toEqual({ ok: false, refusal: 'not_enabled' });
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_ENABLED: 'true' }))).toEqual({ ok: false, refusal: 'not_enabled' });
  });

  it('refuses an unsupported provider rather than guessing at one', () => {
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_PROVIDER: 'outlook' })))
      .toEqual({ ok: false, refusal: 'provider_unsupported' });
  });

  it('requires a client id and a well-formed secret ARN', () => {
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_CLIENT_ID: '  ' })))
      .toEqual({ ok: false, refusal: 'client_id_absent' });
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_CLIENT_SECRET_ARN: 'client-secret-in-plain-text' })))
      .toEqual({ ok: false, refusal: 'client_secret_arn_invalid' });
  });

  it('refuses a redirect that is not https, or that carries its own query or fragment', () => {
    for (const redirect of [
      'http://desktop.example/callback',
      'https://desktop.example/callback?next=/inbox',
      'https://desktop.example/callback#done',
      'not-a-url',
    ]) {
      expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_REDIRECT_URI: redirect })))
        .toEqual({ ok: false, refusal: 'redirect_uri_invalid' });
    }
  });

  it('refuses a write scope in configuration, including the one that reads like a read', () => {
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_SCOPES: 'https://www.googleapis.com/auth/calendar' })))
      .toEqual({ ok: false, refusal: 'scopes_invalid' });
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_SCOPES: 'https://www.googleapis.com/auth/calendar.events' })))
      .toEqual({ ok: false, refusal: 'scopes_invalid' });
    expect(readCalendarConfiguration(environment({ EXTERNAL_CALENDAR_SCOPES: '' })))
      .toEqual({ ok: false, refusal: 'scopes_invalid' });
  });
});

describe('authorization start', () => {
  it('asks for offline access with a PKCE challenge and no granted-scope inheritance', () => {
    const entropy = newAuthorizationEntropy();
    const start = buildAuthorizationStart(configuration(), entropy);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const url = new URL(start.value.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(codeChallengeFor(entropy.codeVerifier));
    expect(url.searchParams.get('state')).toBe(entropy.state);
    expect(url.searchParams.get('scope')).toBe(`${READ_SCOPE} ${FREEBUSY_SCOPE}`);
  });

  it('never puts the verifier itself in the URL', () => {
    const entropy = newAuthorizationEntropy();
    const start = buildAuthorizationStart(configuration(), entropy);
    if (!start.ok) throw new Error(start.refusal);
    expect(start.value.url).not.toContain(entropy.codeVerifier);
  });

  it('refuses weak state and a malformed verifier', () => {
    expect(buildAuthorizationStart(configuration(), { state: 'short', codeVerifier: newAuthorizationEntropy().codeVerifier }))
      .toEqual({ ok: false, refusal: 'state_too_short' });
    expect(buildAuthorizationStart(configuration(), { state: 'a'.repeat(32), codeVerifier: 'too-short' }))
      .toEqual({ ok: false, refusal: 'code_verifier_invalid' });
  });
});

describe('authorization callback', () => {
  const state = 'a'.repeat(43);

  it('accepts only the state it issued', () => {
    expect(assertCallback({ state, code: 'auth-code' }, state)).toBeNull();
    expect(assertCallback({ state: `${state}x`, code: 'auth-code' }, state)).toBe('state_mismatch');
    expect(assertCallback({ state: 'b'.repeat(43), code: 'auth-code' }, state)).toBe('state_mismatch');
    expect(assertCallback({ code: 'auth-code' }, state)).toBe('state_absent');
  });

  it('separates a declined authorization from a provider failure and a missing code', () => {
    expect(assertCallback({ state, error: 'access_denied' }, state)).toBe('authorization_declined');
    expect(assertCallback({ state, error: 'server_error' }, state)).toBe('provider_error');
    expect(assertCallback({ state, code: '  ' }, state)).toBe('code_absent');
  });
});

describe('authorization code exchange', () => {
  const entropy = newAuthorizationEntropy();

  it('returns a grant whose expiry is pulled in by the skew', async () => {
    const outcome = await exchangeAuthorizationCode(
      dependencies(async () => ({ status: 200, json: tokenBody() })),
      configuration(),
      { code: 'auth-code', codeVerifier: entropy.codeVerifier },
    );
    expect(outcome).toEqual({
      ok: true,
      value: {
        accessToken: 'access-token-value',
        refreshToken: 'refresh-token-value',
        // 3600 seconds from 11:00, less the 60 second skew.
        expiresAt: '2026-10-01T11:59:00.000Z',
        scopes: [READ_SCOPE, FREEBUSY_SCOPE],
      },
    });
  });

  it('sends the verifier and the resolved secret, and nothing else that identifies a person', async () => {
    let sent: Record<string, string> = {};
    await exchangeAuthorizationCode(
      dependencies(async input => { sent = input.body; return { status: 200, json: tokenBody() }; }),
      configuration(),
      { code: 'auth-code', codeVerifier: entropy.codeVerifier },
    );
    expect(sent.grant_type).toBe('authorization_code');
    expect(sent.code_verifier).toBe(entropy.codeVerifier);
    expect(sent.client_secret).toBe('client-secret-value');
    expect(Object.keys(sent).sort()).toEqual(['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  });

  it('refuses a grant that came back with a write scope, however the request was made', async () => {
    const outcome = await exchangeAuthorizationCode(
      dependencies(async () => ({ status: 200, json: tokenBody({ scope: 'https://www.googleapis.com/auth/calendar' }) })),
      configuration(),
      { code: 'auth-code', codeVerifier: entropy.codeVerifier },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'granted_scope_refused' });
  });

  it('refuses a grant wider than the one requested even when every scope is read-only', async () => {
    const outcome = await exchangeAuthorizationCode(
      dependencies(async () => ({ status: 200, json: tokenBody({ scope: `${READ_SCOPE} ${FREEBUSY_SCOPE} https://www.googleapis.com/auth/calendar.events.readonly` }) })),
      configuration(),
      { code: 'auth-code', codeVerifier: entropy.codeVerifier },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'granted_scope_widened' });
  });

  it('refuses a malformed or unusable token response', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ access_token: '' }, 'response_malformed'],
      [tokenBody({ token_type: 'mac' }), 'token_type_unsupported'],
      [tokenBody({ expires_in: 0 }), 'expiry_invalid'],
      [tokenBody({ expires_in: 1.5 }), 'expiry_invalid'],
      [tokenBody({ expires_in: '3600' }), 'expiry_invalid'],
    ];
    for (const [json, refusal] of cases) {
      const outcome = await exchangeAuthorizationCode(
        dependencies(async () => ({ status: 200, json })),
        configuration(),
        { code: 'auth-code', codeVerifier: entropy.codeVerifier },
      );
      expect(outcome).toEqual({ ok: false, refusal });
    }
  });

  it('maps provider rejections without reading their bodies back out', async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { error: 'invalid_grant', error_description: 'code already redeemed' }, 'invalid_grant'],
      [401, { error: 'invalid_client' }, 'unauthorized'],
      [429, { error: 'rate_limit_exceeded' }, 'rate_limited'],
      [503, {}, 'unavailable'],
      [400, { error: 'invalid_client' }, 'unauthorized'],
    ];
    for (const [status, json, refusal] of cases) {
      const outcome = await exchangeAuthorizationCode(
        dependencies(async () => ({ status, json })),
        configuration(),
        { code: 'auth-code', codeVerifier: entropy.codeVerifier },
      );
      expect(outcome).toEqual({ ok: false, refusal });
    }
  });

  it('treats a thrown transport as a refusal, not a crash', async () => {
    const outcome = await exchangeAuthorizationCode(
      dependencies(async () => { throw new Error('socket hang up'); }),
      configuration(),
      { code: 'auth-code', codeVerifier: entropy.codeVerifier },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'transport_failed' });
  });
});

describe('refresh', () => {
  it('keeps the existing refresh token when the provider omits it', async () => {
    const outcome = await refreshAccessToken(
      dependencies(async () => ({ status: 200, json: tokenBody({ refresh_token: undefined }) })),
      configuration(),
      connected(),
      'stored-refresh-token',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.refreshToken).toBe('stored-refresh-token');
  });

  it('revokes on invalid_grant and leaves the state alone on a rate limit', async () => {
    const revoked = await refreshAccessToken(
      dependencies(async () => ({ status: 400, json: { error: 'invalid_grant' } })),
      configuration(),
      connected(),
      'stored-refresh-token',
    );
    expect(revoked).toEqual({ ok: false, refusal: 'invalid_grant', nextState: 'revoked' });

    const limited = await refreshAccessToken(
      dependencies(async () => ({ status: 429, json: { error: 'rate_limit_exceeded' } })),
      configuration(),
      connected(),
      'stored-refresh-token',
    );
    expect(limited).toEqual({ ok: false, refusal: 'rate_limited', nextState: 'connected' });
  });

  it('refuses an absent refresh token without asking the provider', async () => {
    let called = false;
    const outcome = await refreshAccessToken(
      dependencies(async () => { called = true; return { status: 200, json: tokenBody() }; }),
      configuration(),
      connected(),
      '   ',
    );
    expect(called).toBe(false);
    expect(outcome).toEqual({ ok: false, refusal: 'invalid_grant', nextState: 'revoked' });
  });
});

describe('free/busy read', () => {
  const window = { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' };
  const reader = (postJson: JsonPost) => ({ postJson, now: () => new Date('2026-10-01T11:00:00.000Z') });
  const ok = (busy: Array<{ start: string; end: string }>): JsonPost => async () => ({
    status: 200,
    json: { calendars: { 'practitioner@example.com': { busy } } },
  });

  it('merges overlapping busy time and keeps nothing but the interval', async () => {
    const outcome = await readBusyIntervals(
      reader(ok([
        { start: '2026-10-01T09:00:00.000Z', end: '2026-10-01T10:00:00.000Z' },
        { start: '2026-10-01T09:30:00.000Z', end: '2026-10-01T11:00:00.000Z' },
      ])),
      connected(),
      { accessToken: 'access-token-value', window, calendarIds: ['practitioner@example.com'] },
    );
    expect(outcome).toEqual({
      ok: true,
      value: {
        busy: [{ start: '2026-10-01T09:00:00.000Z', end: '2026-10-01T11:00:00.000Z' }],
        discarded: 0,
        unavailableCalendars: 0,
      },
    });
  });

  it('counts a calendar it could not read instead of treating it as free', async () => {
    const outcome = await readBusyIntervals(
      reader(async () => ({
        status: 200,
        json: {
          calendars: {
            'practitioner@example.com': { busy: [{ start: '2026-10-01T09:00:00.000Z', end: '2026-10-01T10:00:00.000Z' }] },
            'shared@example.com': { errors: [{ reason: 'notFound' }] },
          },
        },
      })),
      connected(),
      { accessToken: 'access-token-value', window, calendarIds: ['practitioner@example.com', 'shared@example.com'] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.unavailableCalendars).toBe(1);
    expect(outcome.value.busy).toHaveLength(1);
  });

  it('counts a calendar the provider left out of its answer', async () => {
    const outcome = await readBusyIntervals(
      reader(ok([])),
      connected(),
      { accessToken: 'access-token-value', window, calendarIds: ['practitioner@example.com', 'absent@example.com'] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ busy: [], discarded: 0, unavailableCalendars: 1 });
  });

  it('refuses to read through a connection that may not be used', async () => {
    for (const connection of [
      connected({ state: 'revoked' }),
      connected({ state: 'disconnected' }),
      connected({ state: 'expired', hasRefreshToken: false }),
      connected({ scopes: ['https://www.googleapis.com/auth/calendar'] }),
    ]) {
      const outcome = await readBusyIntervals(
        reader(async () => { throw new Error('must not be called'); }),
        connection,
        { accessToken: 'access-token-value', window, calendarIds: ['practitioner@example.com'] },
      );
      expect(outcome).toEqual({ ok: false, refusal: 'not_readable', nextState: connection.state });
    }
  });

  it('bounds the window and the calendar list', async () => {
    const never: JsonPost = async () => { throw new Error('must not be called'); };
    const cases: Array<[{ window: { start: string; end: string }; calendarIds: string[] }, string]> = [
      [{ window: { start: window.end, end: window.start }, calendarIds: ['a@example.com'] }, 'window_invalid'],
      [{ window: { start: 'not-a-date', end: window.end }, calendarIds: ['a@example.com'] }, 'window_invalid'],
      [{ window: { start: '2026-10-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' }, calendarIds: ['a@example.com'] }, 'window_too_long'],
      [{ window, calendarIds: [] }, 'calendars_absent'],
      [{ window, calendarIds: Array.from({ length: 11 }, (_unused, index) => `c${index}@example.com`) }, 'too_many_calendars'],
      [{ window, calendarIds: ['  '] }, 'calendar_id_invalid'],
    ];
    for (const [input, refusal] of cases) {
      const outcome = await readBusyIntervals(reader(never), connected(), { accessToken: 'access-token-value', ...input });
      expect(outcome).toEqual({ ok: false, refusal, nextState: 'connected' });
    }
    expect(MAX_BUSY_WINDOW_DAYS).toBe(31);
  });

  it('moves the connection on a provider rejection and refuses a malformed answer', async () => {
    const unauthorized = await readBusyIntervals(
      reader(async () => ({ status: 401, json: { error: 'invalid_credentials' } })),
      connected(),
      { accessToken: 'access-token-value', window, calendarIds: ['a@example.com'] },
    );
    expect(unauthorized).toEqual({ ok: false, refusal: 'unauthorized', nextState: 'expired' });

    const malformed = await readBusyIntervals(
      reader(async () => ({ status: 200, json: { calendars: [] } })),
      connected(),
      { accessToken: 'access-token-value', window, calendarIds: ['a@example.com'] },
    );
    expect(malformed).toEqual({ ok: false, refusal: 'response_malformed', nextState: 'connected' });
  });

  it('asks the provider only for the window and the calendars, never for event content', async () => {
    let body: Record<string, unknown> = {};
    await readBusyIntervals(
      reader(async input => { body = input.body; return { status: 200, json: { calendars: {} } }; }),
      connected(),
      { accessToken: 'access-token-value', window, calendarIds: ['a@example.com'] },
    );
    expect(Object.keys(body).sort()).toEqual(['items', 'timeMax', 'timeMin']);
    expect(body.items).toEqual([{ id: 'a@example.com' }]);
  });
});

describe('sealed tokens', () => {
  const key = randomBytes(32);

  it('round-trips a refresh token for the binding it was sealed to', () => {
    const sealed = sealCalendarToken(key, 'connection-1', 'refresh-token-value');
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.value.ciphertext).not.toContain('refresh-token-value');
    expect(openCalendarToken(key, 'connection-1', sealed.value)).toEqual({ ok: true, value: 'refresh-token-value' });
  });

  it('does not open against a different binding or a different key', () => {
    const sealed = sealCalendarToken(key, 'connection-1', 'refresh-token-value');
    if (!sealed.ok) throw new Error(sealed.refusal);
    expect(openCalendarToken(key, 'connection-2', sealed.value)).toEqual({ ok: false, refusal: 'not_authentic' });
    expect(openCalendarToken(randomBytes(32), 'connection-1', sealed.value)).toEqual({ ok: false, refusal: 'not_authentic' });
  });

  it('refuses a tampered envelope and a key of the wrong length', () => {
    const sealed = sealCalendarToken(key, 'connection-1', 'refresh-token-value');
    if (!sealed.ok) throw new Error(sealed.refusal);
    expect(openCalendarToken(key, 'connection-1', { ...sealed.value, tag: randomBytes(16).toString('base64') }))
      .toEqual({ ok: false, refusal: 'not_authentic' });
    expect(openCalendarToken(key, 'connection-1', { ...sealed.value, iv: randomBytes(8).toString('base64') }))
      .toEqual({ ok: false, refusal: 'envelope_malformed' });
    expect(openCalendarToken(key, 'connection-1', { ...sealed.value, ciphertext: '' }))
      .toEqual({ ok: false, refusal: 'envelope_malformed' });
    expect(sealCalendarToken(randomBytes(16), 'connection-1', 'refresh-token-value')).toEqual({ ok: false, refusal: 'key_invalid' });
    expect(openCalendarToken(randomBytes(16), 'connection-1', sealed.value)).toEqual({ ok: false, refusal: 'key_invalid' });
  });

  it('refuses to seal without a binding or without a token', () => {
    expect(sealCalendarToken(key, '  ', 'refresh-token-value')).toEqual({ ok: false, refusal: 'binding_absent' });
    expect(sealCalendarToken(key, 'connection-1', '')).toEqual({ ok: false, refusal: 'token_absent' });
  });

  it('produces a different envelope every time the same token is sealed', () => {
    const first = sealCalendarToken(key, 'connection-1', 'refresh-token-value');
    const second = sealCalendarToken(key, 'connection-1', 'refresh-token-value');
    if (!first.ok || !second.ok) throw new Error('seal refused');
    expect(first.value.ciphertext).not.toBe(second.value.ciphertext);
    expect(first.value.iv).not.toBe(second.value.iv);
  });
});

describe('failure description', () => {
  it('separates retrying from re-authorising', () => {
    expect(describeTransportFailure('invalid_grant')).toEqual({ code: 'invalid_grant', retryable: false, reauthorize: true });
    expect(describeTransportFailure('rate_limited')).toEqual({ code: 'rate_limited', retryable: true, reauthorize: false });
    expect(describeTransportFailure('authorization_declined')).toEqual({ code: 'authorization_declined', retryable: false, reauthorize: true });
    expect(describeTransportFailure('granted_scope_refused')).toEqual({ code: 'granted_scope_refused', retryable: false, reauthorize: false });
  });
});

describe('the module itself', () => {
  const source = readFileSync(path.join(__dirname, 'externalCalendarTransport.ts'), 'utf8');

  it('never logs, so a token cannot reach a log line through this file', () => {
    expect(source).not.toMatch(/console\./);
  });

  it('reads no environment value except through the declared configuration names', () => {
    expect(source).not.toMatch(/process\.env/);
  });

  it('holds no credential, endpoint override or default secret', () => {
    expect(source).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(source).not.toMatch(/client_secret\s*[:=]\s*['"][^'"]/);
  });
});
