import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';

import { externalCalendarBrowserRequest } from '@/contracts/externalCalendar';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { beginCalendarAuthorization, syncCalendarBusyTime } from '@/server/calendar/externalCalendarConnectionFlow';
import { createCalendarHttp } from '@/server/calendar/externalCalendarHttp';
import { createCalendarTokenKeyResolver } from '@/server/calendar/externalCalendarKey';
import { readCalendarConfiguration } from '@/server/calendar/externalCalendarTransport';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { getRequestSession } from '@/server/session';

import { calendarWorkforceCall, CalendarWorkforceError } from './workforce';
import { liveGuard } from '../route-helpers';

/**
 * The practitioner's own calendar connection.
 *
 * The browser's vocabulary is narrower than the stored contract's, and that narrowing is
 * the point: a page can read, start, choose which calendars are read, and disconnect. It
 * cannot name an authorization state, supply a verifier, hand over a sealed token or
 * record a provider outcome — those belong to this route and the callback.
 *
 * `start` is answered with a provider URL and nothing else. The state and the verifier are
 * generated here and the verifier is sealed before it is stored, so the browser never
 * holds the proof the exchange depends on.
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  try {
    const body = externalCalendarBrowserRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 65536, 5000))));
    const workforce = calendarWorkforceCall(session.token, request.signal);
    if (body.action !== 'start' && body.action !== 'sync_busy') return json(200, { data: await workforce(body) });
    const configuration = readCalendarConfiguration(process.env as Record<string, string | undefined>);
    // Not configured is a plain answer, not a failure: the connector is off by default.
    if (!configuration.ok) return json(409, { error: 'calendar_not_configured', reason: configuration.refusal });
    const secrets = new SecretsManagerClient({});
    const tokenKey = createCalendarTokenKeyResolver({
      environment: process.env as Record<string, string | undefined>, secrets,
    });
    const clientSecret = async () => {
      const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const secret = await secrets.send(
        new GetSecretValueCommand({ SecretId: configuration.value.clientSecretArn }),
      ) as { SecretString?: string };
      if (typeof secret.SecretString !== 'string') throw new Error('client_secret_unreadable');
      return secret.SecretString.trim();
    };
    if (body.action === 'sync_busy') {
      const http = createCalendarHttp(fetch);
      const synced = await syncCalendarBusyTime({
        configuration: configuration.value, workforce,
        postForm: http.postForm, postJson: http.postJson,
        tokenKey, clientSecret, now: () => new Date(),
      }, { from: body.windowFrom, to: body.windowTo });
      // A refusal here is a decided answer about the connection, not a server fault.
      if (!synced.ok) return json(409, { error: 'calendar_busy_sync_refused', reason: synced.refusal });
      return json(200, { data: { action: 'sync_busy', ...synced.value } });
    }
    const started = await beginCalendarAuthorization({
      configuration: configuration.value,
      workforce,
      postForm: createCalendarHttp(fetch).postForm,
      tokenKey,
      clientSecret,
      now: () => new Date(),
    });
    if (!started.ok) return json(started.refusal === 'workforce_refused' ? 409 : 503, { error: 'calendar_authorization_refused', reason: started.refusal });
    return json(200, { data: { action: 'start', ...started.value } });
  } catch (error) {
    if (error instanceof CalendarWorkforceError) return json(error.status, { error: 'calendar_request_refused' });
    return json(503, { error: 'service_unavailable' });
  }
}
