import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { NextResponse } from 'next/server';

import { completeCalendarAuthorization } from '@/server/calendar/externalCalendarConnectionFlow';
import { createCalendarHttp } from '@/server/calendar/externalCalendarHttp';
import { createCalendarTokenKeyResolver } from '@/server/calendar/externalCalendarKey';
import { readCalendarConfiguration } from '@/server/calendar/externalCalendarTransport';
import { getRequestSession } from '@/server/session';

import { calendarWorkforceCall } from '../workforce';
import { liveGuard } from '../../route-helpers';

/**
 * Where the provider sends the practitioner back.
 *
 * This route deliberately does **not** apply the same-browser origin check. An
 * authorization callback is a cross-site top-level navigation by design, so requiring a
 * same-origin fetch would refuse every real one. What protects it instead is the state
 * parameter: its digest is the only way to find the pending attempt, the attempt expires
 * in ten minutes, and the sealed verifier opens only against that digest. A session is
 * still required, so an unauthenticated navigation completes nothing.
 *
 * The outcome is carried back as a short code in the redirect. No provider message, code
 * or token appears in the URL, in a log line, or in the page the practitioner lands on.
 */
const back = (request: Request, outcome: string) => {
  const target = new URL('/calendar', new URL(request.url).origin);
  target.searchParams.set('calendar', outcome);
  return NextResponse.redirect(target, { status: 303, headers: { 'Cache-Control': 'no-store' } });
};

export async function GET(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  const session = await getRequestSession(); if (!session.token) return back(request, 'reauth_required');
  const parameters = new URL(request.url).searchParams;
  try {
    const configuration = readCalendarConfiguration(process.env as Record<string, string | undefined>);
    if (!configuration.ok) return back(request, 'not_configured');
    const completed = await completeCalendarAuthorization({
      configuration: configuration.value,
      workforce: calendarWorkforceCall(session.token, request.signal),
      postForm: createCalendarHttp(fetch).postForm,
      tokenKey: createCalendarTokenKeyResolver({
        environment: process.env as Record<string, string | undefined>,
        secrets: new SecretsManagerClient({}),
      }),
      clientSecret: async () => {
        const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
        const secret = await new SecretsManagerClient({}).send(
          new GetSecretValueCommand({ SecretId: configuration.value.clientSecretArn }),
        ) as { SecretString?: string };
        if (typeof secret.SecretString !== 'string') throw new Error('client_secret_unreadable');
        return secret.SecretString.trim();
      },
      now: () => new Date(),
    }, {
      state: parameters.get('state'), code: parameters.get('code'), error: parameters.get('error'),
    });
    // The practitioner is told which kind of outcome it was, in the app's own words.
    return back(request, completed.ok ? 'connected'
      : completed.refusal === 'authorization_declined' ? 'declined'
      : completed.refusal === 'granted_scope_refused' || completed.refusal === 'granted_scope_widened' ? 'scope_refused'
      : 'failed');
  } catch { return back(request, 'failed'); }
}
