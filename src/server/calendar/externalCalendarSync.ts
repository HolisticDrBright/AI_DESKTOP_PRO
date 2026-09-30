/**
 * External calendar busy-time sync — credential-free core.
 *
 * An internal calendar is not an external sync, and this repository had only the
 * internal one. This is the part that can exist and be tested without a provider
 * account: the connection state machine, the scope rule, the busy-time mapping and the
 * booking conflict rule. The provider call itself is injected, so nothing here holds a
 * credential or reaches a network.
 *
 * Two properties are the point, and both are enforced rather than documented.
 *
 * **Read-only, always.** A write scope is refused outright. This product reads when a
 * practitioner is busy in order to avoid double-booking them; it has no reason to create,
 * move or delete anything in someone's personal calendar, and a connector that could
 * would be one configuration mistake away from doing it.
 *
 * **Busy time only, never content.** The mapping keeps an interval and drops everything
 * else the provider sends. A calendar event's title is often the most sensitive line in a
 * person's day — "oncology follow-up" — and this feature does not need it, so it never
 * stores it.
 */
export type CalendarConnectionState = 'disconnected' | 'pending_authorization' | 'connected' | 'revoked' | 'expired';

/** Read-only scopes this connector will accept. A scope outside this set is refused. */
export const ALLOWED_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;

export type CalendarScopeRefusal = 'no_scope_requested' | 'write_scope_requested' | 'unknown_scope_requested';

export function assertReadOnlyScopes(scopes: readonly string[]): CalendarScopeRefusal | null {
  const requested = scopes.map(scope => scope.trim()).filter(scope => scope.length > 0);
  if (requested.length === 0) return 'no_scope_requested';
  for (const scope of requested) {
    if (!(ALLOWED_CALENDAR_SCOPES as readonly string[]).includes(scope)) {
      // Anything not on the allowlist is refused, and a scope that merely looks read-only
      // is not trusted: `calendar.events` grants writes despite reading like a read.
      return /\.readonly$|\.freebusy$/.test(scope) ? 'unknown_scope_requested' : 'write_scope_requested';
    }
  }
  return null;
}

export type BusyInterval = { start: string; end: string };

export type BusyMappingOutcome = {
  busy: BusyInterval[];
  /** Intervals the provider sent that could not be used, counted rather than guessed at. */
  discarded: number;
};

const iso = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Provider busy periods into internal busy blocks: bounded intervals only, clamped to the
 * window that was asked about, overlaps merged, everything else dropped.
 */
export function mapBusyIntervals(raw: readonly unknown[], window: BusyInterval): BusyMappingOutcome {
  const from = iso(window.start);
  const to = iso(window.end);
  if (from === null || to === null || from >= to) return { busy: [], discarded: raw.length };
  const usable: Array<[number, number]> = [];
  let discarded = 0;
  for (const entry of raw) {
    const record = entry as { start?: unknown; end?: unknown } | null;
    const start = iso(record?.start);
    const end = iso(record?.end);
    // An open-ended or reversed period is not a block of time anyone can schedule around.
    if (start === null || end === null || start >= end || end <= from || start >= to) { discarded += 1; continue; }
    usable.push([Math.max(start, from), Math.min(end, to)]);
  }
  usable.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of usable) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { busy: merged.map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })), discarded };
}

export type CalendarConnection = {
  state: CalendarConnectionState;
  scopes: readonly string[];
  /** Server time the access token stops being usable. */
  expiresAt: string | null;
  hasRefreshToken: boolean;
};

export type CalendarUseRefusal = 'not_connected' | 'revoked' | 'expired_without_refresh' | 'scope_invalid';

/** Whether this connection may be used to read busy time right now. */
export function calendarReadable(connection: CalendarConnection, asOf: string): CalendarUseRefusal | null {
  if (assertReadOnlyScopes(connection.scopes)) return 'scope_invalid';
  if (connection.state === 'revoked') return 'revoked';
  if (connection.state !== 'connected' && connection.state !== 'expired') return 'not_connected';
  const now = iso(asOf);
  const expiry = iso(connection.expiresAt);
  const stale = connection.state === 'expired' || (now !== null && expiry !== null && expiry <= now);
  // An expired token is recoverable only if a refresh token exists; otherwise the owner
  // has to re-authorise, and pretending otherwise produces a silent empty calendar.
  if (stale && !connection.hasRefreshToken) return 'expired_without_refresh';
  return null;
}

/** A provider rejection, mapped to the next connection state. */
export function nextStateAfterProviderError(connection: CalendarConnection, error: 'invalid_grant' | 'unauthorized' | 'rate_limited' | 'unavailable'): CalendarConnectionState {
  // `invalid_grant` is the provider saying the authorisation is gone. Retrying it is how a
  // connector ends up hammering an account that revoked it.
  if (error === 'invalid_grant') return 'revoked';
  if (error === 'unauthorized') return 'expired';
  return connection.state;
}

export type BookingRequest = { requestId: string; start: string; end: string };
export type BookingRefusal = 'window_invalid' | 'conflicts_with_busy' | 'already_booked';

/**
 * Booking is checked against busy time **at commit**, not against what a screen was
 * showing. A calendar that changed while someone chose a slot is the normal case.
 */
export function bookingRefusal(
  request: BookingRequest,
  busy: readonly BusyInterval[],
  alreadyBookedRequestIds: readonly string[],
): BookingRefusal | null {
  if (alreadyBookedRequestIds.includes(request.requestId)) return 'already_booked';
  const start = iso(request.start);
  const end = iso(request.end);
  if (start === null || end === null || start >= end) return 'window_invalid';
  for (const interval of busy) {
    const busyStart = iso(interval.start);
    const busyEnd = iso(interval.end);
    if (busyStart === null || busyEnd === null) continue;
    if (start < busyEnd && busyStart < end) return 'conflicts_with_busy';
  }
  return null;
}

/** Configuration this connector needs. Names only — never a value, here or anywhere. */
export const REQUIRED_CALENDAR_CONFIGURATION = [
  'EXTERNAL_CALENDAR_ENABLED',
  'EXTERNAL_CALENDAR_PROVIDER',
  'EXTERNAL_CALENDAR_CLIENT_ID',
  'EXTERNAL_CALENDAR_CLIENT_SECRET_ARN',
  'EXTERNAL_CALENDAR_REDIRECT_URI',
  'EXTERNAL_CALENDAR_SCOPES',
] as const;

/** Disabled unless explicitly enabled. There is no default-on path. */
export function externalCalendarEnabled(environment: Record<string, string | undefined>): boolean {
  return String(environment.EXTERNAL_CALENDAR_ENABLED ?? '').trim() === '1';
}
