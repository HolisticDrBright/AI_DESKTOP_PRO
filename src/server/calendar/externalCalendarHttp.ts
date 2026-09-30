/**
 * The actual network for the calendar connector, kept in one small file so the rules
 * in `externalCalendarSync.ts` and the flow in `externalCalendarTransport.ts` stay
 * testable without it.
 *
 * Everything here is bounded on purpose. A provider that stops replying, replies with
 * a gigabyte, or replies with HTML from a captive portal must not be able to hold a
 * request open or to be parsed as a token response.
 */
export const CALENDAR_HTTP_TIMEOUT_MS = 10_000;
export const CALENDAR_HTTP_MAX_BYTES = 262_144;

export type CalendarFetch = (url: string, init: RequestInit) => Promise<Response>;

const readBounded = async (response: Response, maxBytes: number): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response_too_large');
  // A provider that only claims JSON is not enough; a body that is not JSON must not
  // be coerced into one, because "{}" is a very different answer from a login page.
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('response_not_json');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('response_too_large');
  return JSON.parse(text) as unknown;
};

/**
 * The two ports the transport asks for. Redirects are refused rather than followed:
 * a token endpoint that redirects is not one, and following it would send the client
 * secret somewhere nobody reviewed.
 */
export function createCalendarHttp(
  fetchImplementation: CalendarFetch,
  options: { timeoutMs?: number; maxBytes?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? CALENDAR_HTTP_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CALENDAR_HTTP_MAX_BYTES;
  const send = async (url: string, init: RequestInit) => {
    const response = await fetchImplementation(url, {
      ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
    // A rejection status still carries a body the transport reads to classify it.
    const json = response.status === 204 ? {} : await readBounded(response, maxBytes).catch(() => ({}));
    return { status: response.status, json };
  };
  return {
    postForm: async (input: { url: string; body: Record<string, string> }) => send(input.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(input.body).toString(),
    }),
    postJson: async (input: { url: string; accessToken: string; body: Record<string, unknown> }) => send(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify(input.body),
    }),
  };
}
