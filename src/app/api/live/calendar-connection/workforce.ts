import { readBoundedRequestBody } from '@/server/bounded-request-body';
import {
  externalCalendarRequest,
  parseExternalCalendarResponse,
  type ExternalCalendarRequest,
  type ExternalCalendarResponse,
} from '@/contracts/externalCalendar';

/**
 * The authenticated call into the workforce API that owns a stored calendar connection.
 *
 * It is shared by the two routes because both must pin the same backend origin shape:
 * an API Gateway host on HTTPS with nothing else in the URL. A misconfigured origin is
 * a service failure, not something to fall back from.
 */
export class CalendarWorkforceError extends Error {
  constructor(readonly status: number) { super(`calendar_workforce_${status}`); }
}

export function calendarWorkforceCall(token: string, signal?: AbortSignal) {
  const requestSignal = signal ?? AbortSignal.timeout(20000);
  return async (request: ExternalCalendarRequest): Promise<ExternalCalendarResponse> => {
    const parsed = externalCalendarRequest.parse(request);
    const origin = new URL(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
      || origin.username || origin.password || origin.port
      || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) {
      throw new CalendarWorkforceError(503);
    }
    const response = await fetch(`${origin.origin}/clinical-core/workforce/calendar-connection`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!response.ok) throw new CalendarWorkforceError([401, 403, 409, 429].includes(response.status) ? response.status : 503);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new CalendarWorkforceError(503);
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: requestSignal }, 200000, 20000);
    return parseExternalCalendarResponse(parsed, JSON.parse(new TextDecoder().decode(bytes)).data);
  };
}
