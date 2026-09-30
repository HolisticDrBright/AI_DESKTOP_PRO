import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ExternalCalendarRequest, ExternalCalendarResponse } from '../../contracts/externalCalendar';
import { beginCalendarAuthorization, completeCalendarAuthorization, type CalendarFlowDependencies } from './externalCalendarConnectionFlow';
import { calendarStateDigest, openCalendarToken, readCalendarConfiguration, sealCalendarToken } from './externalCalendarTransport';

const READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const CONNECTION = '40000000-0000-4000-8000-000000000001';
const key = randomBytes(32);

const configuration = () => {
  const outcome = readCalendarConfiguration({
    EXTERNAL_CALENDAR_ENABLED: '1',
    EXTERNAL_CALENDAR_PROVIDER: 'google',
    EXTERNAL_CALENDAR_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    EXTERNAL_CALENDAR_CLIENT_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:external-calendar/client-abc123',
    EXTERNAL_CALENDAR_REDIRECT_URI: 'https://desktop.example/api/live/calendar-connection/callback',
    EXTERNAL_CALENDAR_SCOPES: `${READ_SCOPE} ${FREEBUSY_SCOPE}`,
    EXTERNAL_CALENDAR_TOKEN_KEY_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:external-calendar/token-key-abc123',
  });
  if (!outcome.ok) throw new Error(outcome.refusal);
  return outcome.value;
};

const entropy = { state: 'a'.repeat(43), codeVerifier: 'v'.repeat(64) };

type Recorded = { requests: ExternalCalendarRequest[] };

function dependencies(over: {
  workforce?: CalendarFlowDependencies['workforce'];
  postForm?: CalendarFlowDependencies['postForm'];
  tokenKey?: CalendarFlowDependencies['tokenKey'];
} = {}, recorded: Recorded = { requests: [] }): CalendarFlowDependencies {
  const stateDigest = calendarStateDigest(entropy.state);
  const verifier = sealCalendarToken(key, stateDigest, entropy.codeVerifier);
  if (!verifier.ok) throw new Error(verifier.refusal);
  const workforce: CalendarFlowDependencies['workforce'] = async request => {
    recorded.requests.push(request);
    if (request.action === 'begin') return { action: 'begin', connectionId: CONNECTION, revision: '1' };
    if (request.action === 'pending') {
      return {
        action: 'pending', connectionId: CONNECTION, revision: '1',
        verifier: { ...verifier.value, connectionId: CONNECTION },
        scopes: [READ_SCOPE, FREEBUSY_SCOPE],
      } as ExternalCalendarResponse;
    }
    if (request.action === 'complete') {
      return { action: 'complete', connectionId: CONNECTION, state: 'connected', revision: '2', expiresAt: request.expiresAt };
    }
    throw new Error('unexpected');
  };
  return {
    configuration: configuration(),
    workforce: over.workforce ?? workforce,
    postForm: over.postForm ?? (async () => ({
      status: 200,
      json: { access_token: 'access-token-value', refresh_token: 'refresh-token-value', expires_in: 3600, token_type: 'Bearer', scope: READ_SCOPE },
    })),
    tokenKey: over.tokenKey ?? (async () => key),
    clientSecret: async () => 'client-secret-value',
    now: () => new Date('2026-10-01T11:00:00.000Z'),
    entropy: () => entropy,
  };
}

describe('beginning a calendar authorization', () => {
  it('hands the browser a provider URL and stores the verifier sealed to the attempt', async () => {
    const recorded: Recorded = { requests: [] };
    const outcome = await beginCalendarAuthorization(dependencies({}, recorded));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.connectionId).toBe(CONNECTION);
    expect(outcome.value.authorizationUrl).toContain('accounts.google.com');
    // The verifier never travels to the client.
    expect(outcome.value.authorizationUrl).not.toContain(entropy.codeVerifier);
    const begin = recorded.requests[0];
    expect(begin.action).toBe('begin');
    if (begin.action !== 'begin') return;
    expect(begin.stateDigest).toBe(calendarStateDigest(entropy.state));
    // What is stored opens only against the attempt's digest, not against the row id.
    expect(openCalendarToken(key, begin.stateDigest, begin.verifier)).toEqual({ ok: true, value: entropy.codeVerifier });
    expect(openCalendarToken(key, CONNECTION, begin.verifier)).toEqual({ ok: false, refusal: 'not_authentic' });
  });

  it('stores nothing when the store refuses', async () => {
    const outcome = await beginCalendarAuthorization(dependencies({ workforce: async () => { throw new Error('refused'); } }));
    expect(outcome).toEqual({ ok: false, refusal: 'workforce_refused' });
  });

  it('refuses when the sealing key is unusable, before anything is stored', async () => {
    const recorded: Recorded = { requests: [] };
    const outcome = await beginCalendarAuthorization(dependencies({ tokenKey: async () => randomBytes(16) }, recorded));
    expect(outcome).toEqual({ ok: false, refusal: 'seal_failed' });
    expect(recorded.requests).toEqual([]);
  });
});

describe('completing a calendar authorization', () => {
  it('exchanges the code and stores the refresh token sealed to the connection', async () => {
    const recorded: Recorded = { requests: [] };
    const outcome = await completeCalendarAuthorization(dependencies({}, recorded), { state: entropy.state, code: 'auth-code' });
    expect(outcome).toEqual({ ok: true, value: { connectionId: CONNECTION, expiresAt: '2026-10-01T11:59:00.000Z' } });
    const complete = recorded.requests.find(request => request.action === 'complete');
    expect(complete?.action).toBe('complete');
    if (complete?.action !== 'complete') return;
    expect(complete.refresh).not.toBeNull();
    expect(openCalendarToken(key, CONNECTION, complete.refresh!)).toEqual({ ok: true, value: 'refresh-token-value' });
    // The scopes recorded are the ones the provider granted, not the ones requested.
    expect(complete.scopes).toEqual([READ_SCOPE]);
  });

  it('separates a decline, a provider error, a missing state and a missing code', async () => {
    const cases: Array<[Parameters<typeof completeCalendarAuthorization>[1], string]> = [
      [{ code: 'auth-code' }, 'state_absent'],
      [{ state: entropy.state, error: 'access_denied' }, 'authorization_declined'],
      [{ state: entropy.state, error: 'server_error' }, 'provider_error'],
      [{ state: entropy.state }, 'code_absent'],
    ];
    for (const [parameters, refusal] of cases) {
      await expect(completeCalendarAuthorization(dependencies(), parameters)).resolves.toEqual({ ok: false, refusal });
    }
  });

  it('asks the provider for nothing when there is no pending attempt for that state', async () => {
    let asked = false;
    const outcome = await completeCalendarAuthorization(
      dependencies({
        workforce: async request => { if (request.action === 'pending') throw new Error('conflict'); throw new Error('unexpected'); },
        postForm: async () => { asked = true; return { status: 200, json: {} }; },
      }),
      { state: 'b'.repeat(43), code: 'auth-code' },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'workforce_refused' });
    expect(asked).toBe(false);
  });

  it('refuses when the stored verifier does not open, and does not exchange the code', async () => {
    let asked = false;
    const outcome = await completeCalendarAuthorization(
      dependencies({
        workforce: async request => {
          if (request.action === 'pending') {
            const wrong = sealCalendarToken(randomBytes(32), calendarStateDigest(entropy.state), entropy.codeVerifier);
            if (!wrong.ok) throw new Error(wrong.refusal);
            return {
              action: 'pending', connectionId: CONNECTION, revision: '1',
              verifier: { ...wrong.value, connectionId: CONNECTION }, scopes: [READ_SCOPE],
            } as ExternalCalendarResponse;
          }
          throw new Error('unexpected');
        },
        postForm: async () => { asked = true; return { status: 200, json: {} }; },
      }),
      { state: entropy.state, code: 'auth-code' },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'verifier_unreadable' });
    expect(asked).toBe(false);
  });

  it('passes a provider rejection through without storing a connection', async () => {
    const recorded: Recorded = { requests: [] };
    const outcome = await completeCalendarAuthorization(
      dependencies({ postForm: async () => ({ status: 400, json: { error: 'invalid_grant' } }) }, recorded),
      { state: entropy.state, code: 'auth-code' },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'invalid_grant' });
    expect(recorded.requests.some(request => request.action === 'complete')).toBe(false);
  });

  it('refuses a grant that came back wider than the request, without storing it', async () => {
    const recorded: Recorded = { requests: [] };
    const outcome = await completeCalendarAuthorization(
      dependencies({
        postForm: async () => ({
          status: 200,
          json: { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/calendar' },
        }),
      }, recorded),
      { state: entropy.state, code: 'auth-code' },
    );
    expect(outcome).toEqual({ ok: false, refusal: 'granted_scope_refused' });
    expect(recorded.requests.some(request => request.action === 'complete')).toBe(false);
  });

  it('records a connection with no refresh token rather than inventing one', async () => {
    const recorded: Recorded = { requests: [] };
    const outcome = await completeCalendarAuthorization(
      dependencies({
        postForm: async () => ({ status: 200, json: { access_token: 'a', expires_in: 3600, token_type: 'Bearer', scope: READ_SCOPE } }),
      }, recorded),
      { state: entropy.state, code: 'auth-code' },
    );
    expect(outcome.ok).toBe(true);
    const complete = recorded.requests.find(request => request.action === 'complete');
    if (complete?.action !== 'complete') throw new Error('no complete');
    expect(complete.refresh).toBeNull();
  });
});
