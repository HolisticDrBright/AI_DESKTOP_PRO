/**
 * The two halves of connecting a calendar, assembled from the transport and the stored
 * connection so a route has almost nothing left to decide.
 *
 * The verifier is sealed to the digest of the authorization state rather than to a
 * connection id, because at the moment it is created there is no row yet — and binding
 * it to the attempt is the stronger statement anyway: a verifier from one authorization
 * cannot complete another.
 *
 * Nothing in this file logs, and no refusal it returns carries a provider body, a code,
 * a token or a calendar's contents.
 */
import type { ExternalCalendarRequest, ExternalCalendarResponse } from '../../contracts/externalCalendar';
import {
  MAX_BUSY_WINDOW_DAYS,
  buildAuthorizationStart,
  calendarStateDigest,
  callbackParameterRefusal,
  exchangeAuthorizationCode,
  newAuthorizationEntropy,
  openCalendarToken,
  readBusyIntervals,
  refreshAccessToken,
  sealCalendarToken,
  type CalendarConfiguration,
  type CallbackParameters,
  type CallbackRefusal,
  type ClientSecretResolver,
  type FormPost,
  type JsonPost,
  type TokenRefusal,
} from './externalCalendarTransport';

export type WorkforceCalendarCall = (request: ExternalCalendarRequest) => Promise<ExternalCalendarResponse>;

export type CalendarFlowDependencies = {
  configuration: CalendarConfiguration;
  /** The free/busy port. Only the busy sync needs it. */
  postJson?: JsonPost;
  /** The authenticated call into the workforce API that owns the stored connection. */
  workforce: WorkforceCalendarCall;
  postForm: FormPost;
  /** The 32-byte key that seals tokens at rest. Resolved per call; never held here. */
  tokenKey: () => Promise<Buffer>;
  clientSecret: ClientSecretResolver;
  now: () => Date;
  entropy?: () => { state: string; codeVerifier: string };
};

type Refused<T extends string> = { ok: false; refusal: T };
type Accepted<T> = { ok: true; value: T };
const refuse = <T extends string>(refusal: T): Refused<T> => ({ ok: false, refusal });

export type BeginRefusal = 'seal_failed' | 'workforce_refused' | 'state_too_short' | 'code_verifier_invalid' | 'scopes_invalid';
export type BeginValue = { authorizationUrl: string; connectionId: string };

/**
 * Start an authorization. The browser is given only the provider URL: the verifier is
 * sealed before it is stored and never reaches the client.
 */
export async function beginCalendarAuthorization(
  dependencies: CalendarFlowDependencies,
): Promise<Accepted<BeginValue> | Refused<BeginRefusal>> {
  const entropy = (dependencies.entropy ?? newAuthorizationEntropy)();
  const start = buildAuthorizationStart(dependencies.configuration, entropy);
  if (!start.ok) return refuse(start.refusal);
  const stateDigest = calendarStateDigest(entropy.state);
  const sealed = sealCalendarToken(await dependencies.tokenKey(), stateDigest, entropy.codeVerifier);
  if (!sealed.ok) return refuse('seal_failed');
  let stored: ExternalCalendarResponse;
  try {
    stored = await dependencies.workforce({
      action: 'begin', stateDigest, scopes: [...dependencies.configuration.scopes],
      verifier: { ciphertext: sealed.value.ciphertext, iv: sealed.value.iv, tag: sealed.value.tag },
    });
  } catch { return refuse('workforce_refused'); }
  if (stored.action !== 'begin') return refuse('workforce_refused');
  return { ok: true, value: { authorizationUrl: start.value.url, connectionId: stored.connectionId } };
}

export type CompleteRefusal = CallbackRefusal | TokenRefusal | 'seal_failed' | 'workforce_refused' | 'verifier_unreadable';
export type CompleteValue = { connectionId: string; expiresAt: string };

/**
 * Finish an authorization from the provider's redirect. The state is never compared
 * against something this process remembers: its digest is the lookup, so an unknown or
 * expired attempt simply has no pending row to answer with.
 */
export async function completeCalendarAuthorization(
  dependencies: CalendarFlowDependencies,
  parameters: CallbackParameters,
): Promise<Accepted<CompleteValue> | Refused<CompleteRefusal>> {
  const parameterRefusal = callbackParameterRefusal(parameters);
  if (parameterRefusal) return refuse(parameterRefusal);
  const stateDigest = calendarStateDigest(String(parameters.state));
  let pending: ExternalCalendarResponse;
  try { pending = await dependencies.workforce({ action: 'pending', stateDigest }); }
  catch { return refuse('workforce_refused'); }
  if (pending.action !== 'pending') return refuse('workforce_refused');
  const key = await dependencies.tokenKey();
  const verifier = openCalendarToken(key, stateDigest, pending.verifier);
  // A verifier that does not open is not a verifier: the attempt cannot be completed,
  // and retrying it would only send a code the provider has already bound elsewhere.
  if (!verifier.ok) return refuse('verifier_unreadable');
  const grant = await exchangeAuthorizationCode(
    { postForm: dependencies.postForm, clientSecret: dependencies.clientSecret, now: dependencies.now },
    dependencies.configuration,
    { code: String(parameters.code), codeVerifier: verifier.value },
  );
  if (!grant.ok) return refuse(grant.refusal);
  let refresh: { ciphertext: string; iv: string; tag: string } | null = null;
  if (grant.value.refreshToken) {
    const sealed = sealCalendarToken(key, pending.connectionId, grant.value.refreshToken);
    if (!sealed.ok) return refuse('seal_failed');
    refresh = { ciphertext: sealed.value.ciphertext, iv: sealed.value.iv, tag: sealed.value.tag };
  }
  let completed: ExternalCalendarResponse;
  try {
    completed = await dependencies.workforce({
      action: 'complete', expectedRevision: pending.revision, scopes: [...grant.value.scopes],
      refresh, expiresAt: grant.value.expiresAt,
    });
  } catch { return refuse('workforce_refused'); }
  if (completed.action !== 'complete') return refuse('workforce_refused');
  return { ok: true, value: { connectionId: completed.connectionId, expiresAt: completed.expiresAt } };
}

/** Only these three are outcomes a provider can put a connection into. */
const recordable = (state: string): state is 'connected' | 'expired' | 'revoked' =>
  state === 'connected' || state === 'expired' || state === 'revoked';

export type BusySyncRefusal =
  | 'not_connected' | 'no_calendars_chosen' | 'window_invalid' | 'reauthorization_required'
  | 'workforce_refused' | 'seal_failed' | TokenRefusal;
export type BusySyncValue = { stored: number; unavailableCalendars: number; complete: boolean };

/**
 * Read the practitioner's busy time and store it, so booking can refuse against it.
 *
 * The order matters. An access token is obtained first, refreshing when the stored one has
 * expired; a refresh that fails with `invalid_grant` records the revocation before giving
 * up, because a connection nobody marked revoked keeps being retried. Only then is the
 * provider read, and only a successful, complete read is stored — a window the provider
 * could not fully answer for is stored as incomplete, which booking treats as no answer.
 */
export async function syncCalendarBusyTime(
  dependencies: CalendarFlowDependencies,
  window: { from: string; to: string },
): Promise<Accepted<BusySyncValue> | Refused<BusySyncRefusal>> {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return refuse('window_invalid');
  if (to - from > MAX_BUSY_WINDOW_DAYS * 86_400_000) return refuse('window_invalid');
  if (!dependencies.postJson) return refuse('workforce_refused');

  let current: ExternalCalendarResponse;
  try { current = await dependencies.workforce({ action: 'read' }); }
  catch { return refuse('workforce_refused'); }
  if (current.action !== 'read' || !current.connected || !current.connectionId || !current.revision) {
    return refuse('not_connected');
  }
  // Reading every calendar a practitioner owns is not this feature's business; it reads the
  // ones they chose. None chosen is a state to report, not a silent no-op.
  const calendarIds = current.calendarIds ?? [];
  if (calendarIds.length === 0) return refuse('no_calendars_chosen');

  let material: ExternalCalendarResponse;
  try { material = await dependencies.workforce({ action: 'material' }); }
  catch { return refuse('reauthorization_required'); }
  if (material.action !== 'material') return refuse('workforce_refused');

  const key = await dependencies.tokenKey();
  const refreshToken = openCalendarToken(key, material.connectionId, material.refresh);
  if (!refreshToken.ok) return refuse('reauthorization_required');

  const connection = {
    state: material.state, scopes: current.scopes ?? [],
    expiresAt: material.expiresAt, hasRefreshToken: true,
  };
  const grant = await refreshAccessToken(
    { postForm: dependencies.postForm, clientSecret: dependencies.clientSecret, now: dependencies.now },
    dependencies.configuration, connection, refreshToken.value,
  );
  if (!grant.ok) {
    // Record what the provider said before giving up, or the connection is retried forever.
    if (grant.nextState !== connection.state && recordable(grant.nextState)) {
      try {
        await dependencies.workforce({
          action: 'record_state', expectedRevision: material.revision, state: grant.nextState,
        });
      } catch { /* the refusal below is the answer either way */ }
    }
    return refuse(grant.refusal);
  }

  let sealed: { ciphertext: string; iv: string; tag: string } | null = null;
  if (grant.value.refreshToken && grant.value.refreshToken !== refreshToken.value) {
    const next = sealCalendarToken(key, material.connectionId, grant.value.refreshToken);
    if (!next.ok) return refuse('seal_failed');
    sealed = { ciphertext: next.value.ciphertext, iv: next.value.iv, tag: next.value.tag };
  }
  let afterRefresh = material.revision;
  try {
    const recorded = await dependencies.workforce({
      action: 'record_state', expectedRevision: material.revision, state: 'connected',
      ...(sealed ? { refresh: sealed } : {}), expiresAt: grant.value.expiresAt,
    });
    if (recorded.action === 'record_state') afterRefresh = recorded.revision;
  } catch { return refuse('workforce_refused'); }

  const read = await readBusyIntervals(
    { postJson: dependencies.postJson, now: dependencies.now },
    { ...connection, state: 'connected', expiresAt: grant.value.expiresAt },
    { accessToken: grant.value.accessToken, window: { start: window.from, end: window.to }, calendarIds },
  );
  if (!read.ok) {
    if (read.nextState !== 'connected' && recordable(read.nextState)) {
      try {
        await dependencies.workforce({ action: 'record_state', expectedRevision: afterRefresh, state: read.nextState });
      } catch { /* the refusal below is the answer either way */ }
    }
    return refuse(read.refusal as BusySyncRefusal);
  }

  let stored: ExternalCalendarResponse;
  try {
    stored = await dependencies.workforce({
      action: 'busy_sync', windowFrom: window.from, windowTo: window.to,
      busy: read.value.busy, unavailableCalendars: Math.min(read.value.unavailableCalendars, 10),
    });
  } catch { return refuse('workforce_refused'); }
  if (stored.action !== 'busy_sync') return refuse('workforce_refused');
  return { ok: true, value: { stored: stored.stored, unavailableCalendars: stored.unavailableCalendars, complete: stored.complete } };
}
