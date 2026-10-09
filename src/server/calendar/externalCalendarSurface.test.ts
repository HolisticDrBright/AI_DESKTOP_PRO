import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { externalCalendarBrowserRequest, externalCalendarRequest } from '../../contracts/externalCalendar';
import { REQUIRED_CALENDAR_CONFIGURATION } from './externalCalendarSync';

const read = (path: string) => readFileSync(path, 'utf8');
const POST_ROUTE = 'src/app/api/live/calendar-connection/route.ts';
const CALLBACK_ROUTE = 'src/app/api/live/calendar-connection/callback/route.ts';
const PANEL = 'src/components/calendar/ExternalCalendarConnectionPanel.tsx';

describe('what a browser may ask about a calendar connection', () => {
  it('accepts only the actions a page has any business naming', () => {
    for (const action of ['read', 'start', 'set_calendars', 'disconnect', 'sync_busy']) {
      const body = action === 'set_calendars' ? { action, expectedRevision: '1', calendarIds: ['a@example.com'] }
        : action === 'disconnect' ? { action, expectedRevision: '1' }
        : action === 'sync_busy' ? { action, windowFrom: '2026-10-05T00:00:00.000Z', windowTo: '2026-10-06T00:00:00.000Z' }
        : { action };
      expect(externalCalendarBrowserRequest.safeParse(body).success, action).toBe(true);
    }
  });

  it('will not let a page supply the busy intervals themselves', () => {
    // The intervals come from the provider, on the server. A page that could name them
    // could declare itself free.
    expect(externalCalendarBrowserRequest.safeParse({
      action: 'sync_busy', windowFrom: '2026-10-05T00:00:00.000Z', windowTo: '2026-10-06T00:00:00.000Z',
      busy: [], unavailableCalendars: 0,
    }).success).toBe(false);
    expect(externalCalendarBrowserRequest.safeParse({
      action: 'busy_sync', windowFrom: '2026-10-05T00:00:00.000Z', windowTo: '2026-10-06T00:00:00.000Z',
      busy: [], unavailableCalendars: 0,
    }).success).toBe(false);
  });

  it('cannot express the actions that move sealed material', () => {
    for (const body of [
      { action: 'begin', stateDigest: 'a'.repeat(64), scopes: ['https://x'], verifier: { ciphertext: 'c', iv: 'A'.repeat(16), tag: 'A'.repeat(24) } },
      { action: 'pending', stateDigest: 'a'.repeat(64) },
      { action: 'material' },
      { action: 'complete', expectedRevision: '1', scopes: ['https://x'], refresh: null, expiresAt: '2026-10-01T12:00:00.000Z' },
      { action: 'record_state', expectedRevision: '1', state: 'revoked' },
    ]) {
      expect(externalCalendarBrowserRequest.safeParse(body).success, String(body.action)).toBe(false);
    }
  });

  it('keeps those actions available on the stored contract, where the server uses them', () => {
    expect(externalCalendarRequest.safeParse({ action: 'material' }).success).toBe(true);
    expect(externalCalendarRequest.safeParse({ action: 'pending', stateDigest: 'a'.repeat(64) }).success).toBe(true);
  });

  it('refuses a sealed envelope whose parts are the wrong size', () => {
    const request = {
      action: 'begin', stateDigest: 'a'.repeat(64), scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      verifier: { ciphertext: 'c', iv: 'A'.repeat(15), tag: 'A'.repeat(24) },
    };
    expect(externalCalendarRequest.safeParse(request).success).toBe(false);
  });
});

describe('the routes', () => {
  it('checks the browser origin on the action route, through the shared helper', () => {
    const source = read(POST_ROUTE);
    expect(source).toContain('sameBrowserOrigin');
    expect(source).toContain('export async function POST');
  });

  it('does not check the browser origin on the callback, and says why in the file', () => {
    const source = read(CALLBACK_ROUTE);
    // An authorization callback is a cross-site top-level navigation by design. The
    // absence of the check is a decision, so the file has to carry the reason.
    expect(source).not.toContain('sameBrowserOrigin(');
    expect(source).toMatch(/cross-site top-level navigation/);
    // What replaces it: a session, and a state digest that has to match a pending row.
    expect(source).toContain('getRequestSession');
    expect(source).toContain('completeCalendarAuthorization');
  });

  it('carries no provider message, code or token back in the redirect', () => {
    const source = read(CALLBACK_ROUTE);
    expect(source).not.toMatch(/searchParams\.set\(\s*['"](code|error|state|token)['"]/);
    // Only a short, fixed vocabulary of outcomes reaches the URL.
    for (const outcome of ['connected', 'declined', 'scope_refused', 'failed']) expect(source).toContain(`'${outcome}'`);
  });

  it('neither route logs', () => {
    for (const path of [POST_ROUTE, CALLBACK_ROUTE, 'src/app/api/live/calendar-connection/workforce.ts']) {
      expect(read(path), path).not.toMatch(/console\./);
    }
  });
});

describe('the panel', () => {
  const source = read(PANEL);

  it('separates loading, empty, failed, pending and needs-authorizing', () => {
    for (const testId of [
      'external-calendar-loading', 'external-calendar-empty', 'external-calendar-error',
      'external-calendar-pending', 'external-calendar-reauthorize', 'external-calendar-connected',
    ]) expect(source, testId).toContain(testId);
  });

  it('never tells a practitioner a calendar is being read when it is not', () => {
    // The re-authorize branch has to say the busy time is not being read; a connection
    // that silently stopped working is the failure mode this product cannot have.
    expect(source).toMatch(/not<\/strong> being read/);
  });

  it('states the shape of what is read, on the screen', () => {
    expect(source).toMatch(/never event titles, guests or locations/);
    expect(source).toMatch(/Read-only/);
  });

  it('cannot send a verifier, a state or a sealed token', () => {
    for (const forbidden of ['stateDigest', 'verifier', 'ciphertext', 'refresh:']) expect(source, forbidden).not.toContain(forbidden);
  });

  it('offers the busy refresh and says what an unconfirmed booking does', () => {
    expect(source).toContain('external-calendar-refresh-busy');
    // The consequence of not refreshing is on the screen, because it is a refusal the
    // practitioner will otherwise meet at the moment of booking with no explanation.
    expect(source).toMatch(/the booking is refused rather than guessed at/);
    expect(source).toMatch(/bookings will not be confirmed against this one/);
  });
});

describe('configuration', () => {
  it('declares every name and holds no value for any of them', () => {
    expect(REQUIRED_CALENDAR_CONFIGURATION).toHaveLength(7);
    const sources = [POST_ROUTE, CALLBACK_ROUTE, PANEL, 'src/server/calendar/externalCalendarTransport.ts'].map(read).join('\n');
    for (const name of REQUIRED_CALENDAR_CONFIGURATION) {
      expect(sources, name).not.toMatch(new RegExp(`${name}\\s*[:=]\\s*['"][^'"]+['"]`));
    }
  });

  it('is declared as a workforce route in the API extension, with a JWT authorizer', () => {
    const template = JSON.parse(read('infra/aws-clinical-core/identity-api-extension.json')) as {
      Resources: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
    };
    const route = template.Resources.WorkforceCalendarConnectionRoute;
    expect(route?.Type).toBe('AWS::ApiGatewayV2::Route');
    expect(route?.Properties?.RouteKey).toBe('POST /clinical-core/workforce/calendar-connection');
    expect(route?.Properties?.AuthorizationType).toBe('JWT');
    expect(route?.Properties?.AuthorizerId).toEqual({ Ref: 'WorkforceJwtAuthorizer' });
  });
});
