import { describe, expect, it } from 'vitest';

import { CALENDAR_HTTP_MAX_BYTES, createCalendarHttp, type CalendarFetch } from './externalCalendarHttp';

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('calendar http ports', () => {
  it('posts a form body and returns the parsed answer', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const http = createCalendarHttp(async (url, init) => { seen = { url, init }; return jsonResponse({ access_token: 'value' }); });
    const result = await http.postForm({ url: 'https://oauth2.googleapis.com/token', body: { grant_type: 'refresh_token' } });
    expect(result).toEqual({ status: 200, json: { access_token: 'value' } });
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.redirect).toBe('error');
    expect(seen!.init.cache).toBe('no-store');
    expect(String(seen!.init.body)).toBe('grant_type=refresh_token');
    expect((seen!.init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('sends the bearer token on the JSON port and nowhere else', async () => {
    let headers: Record<string, string> = {};
    let body = '';
    const http = createCalendarHttp(async (_url, init) => {
      headers = init.headers as Record<string, string>;
      body = String(init.body);
      return jsonResponse({ calendars: {} });
    });
    await http.postJson({ url: 'https://www.googleapis.com/calendar/v3/freeBusy', accessToken: 'access-token-value', body: { timeMin: 'a' } });
    expect(headers.authorization).toBe('Bearer access-token-value');
    expect(body).not.toContain('access-token-value');
  });

  it('keeps a rejection status while giving the caller an empty body to classify', async () => {
    const http = createCalendarHttp(async () => new Response('<html>signed out</html>', { status: 401, headers: { 'content-type': 'text/html' } }));
    await expect(http.postForm({ url: 'https://oauth2.googleapis.com/token', body: {} })).resolves.toEqual({ status: 401, json: {} });
  });

  it('refuses to parse a body that is not JSON as though it were', async () => {
    const http = createCalendarHttp(async () => new Response('access_token=leaked', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await expect(http.postForm({ url: 'https://oauth2.googleapis.com/token', body: {} })).resolves.toEqual({ status: 200, json: {} });
  });

  it('refuses an oversized body, by its declared length and by what actually arrives', async () => {
    const declared = createCalendarHttp(async () => jsonResponse({}, 200, { 'content-length': String(CALENDAR_HTTP_MAX_BYTES + 1) }));
    await expect(declared.postForm({ url: 'https://oauth2.googleapis.com/token', body: {} })).resolves.toEqual({ status: 200, json: {} });
    const actual = createCalendarHttp(async () => jsonResponse({ padding: 'x'.repeat(64) }), { maxBytes: 16 });
    await expect(actual.postForm({ url: 'https://oauth2.googleapis.com/token', body: {} })).resolves.toEqual({ status: 200, json: {} });
  });

  it('passes a timeout signal and lets a transport failure surface', async () => {
    let signalled = false;
    const http = createCalendarHttp(async (_url, init) => { signalled = init.signal instanceof AbortSignal; throw new Error('socket hang up'); });
    await expect(http.postJson({ url: 'https://www.googleapis.com/calendar/v3/freeBusy', accessToken: 'a', body: {} })).rejects.toThrow('socket hang up');
    expect(signalled).toBe(true);
  });

  it('treats an empty 204 as an empty answer rather than a parse failure', async () => {
    const http: ReturnType<typeof createCalendarHttp> = createCalendarHttp((async () => new Response(null, { status: 204 })) as CalendarFetch);
    await expect(http.postForm({ url: 'https://oauth2.googleapis.com/token', body: {} })).resolves.toEqual({ status: 204, json: {} });
  });
});
