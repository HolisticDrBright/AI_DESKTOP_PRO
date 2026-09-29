/**
 * Same-origin validation for browser-driven route handlers, correct behind a
 * TLS-terminating reverse proxy.
 *
 * WHY THIS IS SHARED. App Runner terminates TLS and forwards to Next's internal
 * listener, so the request URL the handler sees is the internal one
 * (`http://0.0.0.0:3000/...`) while the browser sends its public authority in
 * `Origin` and `Host`. Comparing `Origin` against the request URL's own origin
 * therefore refuses every legitimate same-origin browser request in the hosted
 * deployment. That was found and fixed once, in the messaging route, and the fix
 * stayed there: seven other mutating live routes still compared against the
 * internal URL. This module exists so the comparison has one implementation.
 *
 * `Host` is the authority the browser addressed, so it is the only header that
 * may decide this. `X-Forwarded-Host` and friends are attacker-controlled and are
 * deliberately never consulted.
 */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function sameBrowserOrigin(request: Request): boolean {
  const raw = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!raw || !host) return false;
  // A browser that tells us the request is not same-origin is believed.
  if (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin') return false;
  try {
    const origin = new URL(raw);
    // An Origin carrying a path, query or credentials is not a bare origin.
    if (raw !== origin.origin || origin.host !== host) return false;
    if (origin.protocol === 'https:') return true;
    // Plain HTTP is only ever local development, and only when the listener agrees.
    return origin.protocol === 'http:' && LOOPBACK.includes(origin.hostname)
      && origin.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
