/**
 * External calendar transport — the part that needs a provider, kept honest without one.
 *
 * `externalCalendarSync.ts` holds the rules that can be decided without a network: which
 * scopes are acceptable, what a busy interval is, when a connection may be used. This file
 * is the transport those rules govern: the authorisation redirect, the code exchange, the
 * refresh, the free/busy read, and the sealing of the tokens in between.
 *
 * Every outbound call is an injected port. Nothing here opens a socket, reads an
 * environment value it was not handed, or holds a key beyond the life of one call, which is
 * what lets the whole path be tested with no provider account and no credential.
 *
 * Three rules are enforced rather than trusted:
 *
 * **What the provider granted is checked, not what we asked for.** An authorisation screen
 * can return a different scope set than the one requested. The grant is re-checked against
 * the read-only allowlist, so a provider that hands back write access gets refused at the
 * exchange instead of becoming a write-capable connection nobody inspected.
 *
 * **A token is sealed to one connection.** The connection id is authenticated additional
 * data, so a ciphertext copied from one practitioner's row into another's does not open.
 *
 * **A failure never carries the body.** Provider responses can echo a token or a calendar
 * title back in an error. Callers get a code and a class, never the payload.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  assertReadOnlyScopes,
  calendarReadable,
  externalCalendarEnabled,
  mapBusyIntervals,
  nextStateAfterProviderError,
  type BusyInterval,
  type BusyMappingOutcome,
  type CalendarConnection,
  type CalendarConnectionState,
} from './externalCalendarSync';

/** The only provider this connector understands. A second one is a reviewed addition, not a config value. */
export const SUPPORTED_CALENDAR_PROVIDER = 'google' as const;

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const FREEBUSY_ENDPOINT = 'https://www.googleapis.com/calendar/v3/freeBusy';

/** Longest window a single free/busy read may ask about. */
export const MAX_BUSY_WINDOW_DAYS = 31;
/** Most calendars one read may name. A practitioner has a handful, not a directory. */
export const MAX_CALENDARS_PER_READ = 10;
/** Treat a token as expired this early, so a call in flight does not land after expiry. */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60;

const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;

export type CalendarConfiguration = {
  provider: typeof SUPPORTED_CALENDAR_PROVIDER;
  clientId: string;
  clientSecretArn: string;
  redirectUri: string;
  scopes: readonly string[];
};

export type ConfigurationRefusal =
  | 'not_enabled'
  | 'provider_unsupported'
  | 'client_id_absent'
  | 'client_secret_arn_invalid'
  | 'redirect_uri_invalid'
  | 'scopes_invalid';

export type Refused<T extends string> = { ok: false; refusal: T };
export type Accepted<T> = { ok: true; value: T };
export type Outcome<T, R extends string> = Accepted<T> | Refused<R>;

const refuse = <T extends string>(refusal: T): Refused<T> => ({ ok: false, refusal });
const accept = <T>(value: T): Accepted<T> => ({ ok: true, value });

/**
 * Configuration comes only from names this connector declares, and the connector stays off
 * unless it is explicitly enabled. The client secret is located by ARN and never read here.
 */
export function readCalendarConfiguration(
  environment: Record<string, string | undefined>,
): Outcome<CalendarConfiguration, ConfigurationRefusal> {
  if (!externalCalendarEnabled(environment)) return refuse('not_enabled');
  if ((environment.EXTERNAL_CALENDAR_PROVIDER ?? '').trim() !== SUPPORTED_CALENDAR_PROVIDER) return refuse('provider_unsupported');
  const clientId = (environment.EXTERNAL_CALENDAR_CLIENT_ID ?? '').trim();
  if (clientId.length === 0) return refuse('client_id_absent');
  const clientSecretArn = (environment.EXTERNAL_CALENDAR_CLIENT_SECRET_ARN ?? '').trim();
  if (!SECRET_ARN.test(clientSecretArn)) return refuse('client_secret_arn_invalid');
  const redirectUri = (environment.EXTERNAL_CALENDAR_REDIRECT_URI ?? '').trim();
  let parsedRedirect: URL;
  try { parsedRedirect = new URL(redirectUri); } catch { return refuse('redirect_uri_invalid'); }
  // A redirect target that carries its own query or fragment is how a state parameter gets
  // lost or shadowed, and plain HTTP would put the code on the wire.
  if (parsedRedirect.protocol !== 'https:' || parsedRedirect.search !== '' || parsedRedirect.hash !== '') return refuse('redirect_uri_invalid');
  const scopes = (environment.EXTERNAL_CALENDAR_SCOPES ?? '').split(/[\s,]+/).map(scope => scope.trim()).filter(scope => scope.length > 0);
  if (assertReadOnlyScopes(scopes)) return refuse('scopes_invalid');
  return accept({ provider: SUPPORTED_CALENDAR_PROVIDER, clientId, clientSecretArn, redirectUri, scopes });
}

export type AuthorizationStart = { url: string; state: string; codeVerifier: string };
export type AuthorizationStartRefusal = 'state_too_short' | 'code_verifier_invalid' | 'scopes_invalid';

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const base64url = (value: Buffer) => value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The S256 challenge for a verifier. Exported so a caller can prove the pair it sent. */
export function codeChallengeFor(codeVerifier: string): string {
  return base64url(createHash('sha256').update(codeVerifier).digest());
}

/**
 * The authorisation URL. `access_type=offline` with `prompt=consent` is deliberate: without
 * a refresh token an expired connection reads as an empty calendar, which reads as free.
 */
export function buildAuthorizationStart(
  configuration: CalendarConfiguration,
  entropy: { state: string; codeVerifier: string },
): Outcome<AuthorizationStart, AuthorizationStartRefusal> {
  if (assertReadOnlyScopes(configuration.scopes)) return refuse('scopes_invalid');
  if (entropy.state.trim().length < 32) return refuse('state_too_short');
  if (!CODE_VERIFIER.test(entropy.codeVerifier)) return refuse('code_verifier_invalid');
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('redirect_uri', configuration.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', configuration.scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('state', entropy.state);
  url.searchParams.set('code_challenge', codeChallengeFor(entropy.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return accept({ url: url.toString(), state: entropy.state, codeVerifier: entropy.codeVerifier });
}

/** Fresh authorisation entropy. Separated so a test can supply its own and stay deterministic. */
export function newAuthorizationEntropy(): { state: string; codeVerifier: string } {
  return { state: base64url(randomBytes(32)), codeVerifier: base64url(randomBytes(64)) };
}

export type CallbackRefusal = 'state_absent' | 'state_mismatch' | 'authorization_declined' | 'provider_error' | 'code_absent';
export type CallbackParameters = { state?: string | null; code?: string | null; error?: string | null };

/** The digest the authorization state is stored and looked up by, never the state itself. */
export function calendarStateDigest(state: string): string {
  return createHash('sha256').update(state.trim()).digest('hex');
}

/**
 * Everything about a callback that can be judged without knowing which state was
 * issued: that there is one, that the person did not decline, that a code arrived.
 */
export function callbackParameterRefusal(parameters: CallbackParameters): CallbackRefusal | null {
  if ((parameters.state ?? '').trim().length === 0) return 'state_absent';
  const error = (parameters.error ?? '').trim();
  if (error === 'access_denied') return 'authorization_declined';
  if (error.length > 0) return 'provider_error';
  if ((parameters.code ?? '').trim().length === 0) return 'code_absent';
  return null;
}

/**
 * The callback, before any token is asked for. A mismatched state is the cross-site case
 * and is compared in constant time so the comparison itself says nothing.
 */
export function assertCallback(parameters: CallbackParameters, expectedState: string): CallbackRefusal | null {
  const state = (parameters.state ?? '').trim();
  if (state.length === 0) return 'state_absent';
  const given = Buffer.from(state);
  const expected = Buffer.from(expectedState.trim());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'state_mismatch';
  return callbackParameterRefusal(parameters);
}

export type TokenGrant = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scopes: readonly string[];
};

export type ProviderError = 'invalid_grant' | 'unauthorized' | 'rate_limited' | 'unavailable';
export type TokenRefusal =
  | 'transport_failed'
  | 'response_malformed'
  | 'token_type_unsupported'
  | 'expiry_invalid'
  | 'granted_scope_refused'
  | 'granted_scope_widened'
  | ProviderError;

/** A form POST that returns a status and a parsed JSON body. The only network this module knows. */
export type FormPost = (input: {
  url: string;
  body: Record<string, string>;
}) => Promise<{ status: number; json: unknown }>;

/** A JSON POST with a bearer token, for the free/busy read. */
export type JsonPost = (input: {
  url: string;
  accessToken: string;
  body: Record<string, unknown>;
}) => Promise<{ status: number; json: unknown }>;

/** Resolves the client secret at the moment of use. The value is never returned to a caller. */
export type ClientSecretResolver = (clientSecretArn: string) => Promise<string>;

export type TransportDependencies = {
  postForm: FormPost;
  clientSecret: ClientSecretResolver;
  now: () => Date;
};

const providerErrorFor = (status: number, json: unknown): ProviderError => {
  const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? ((json as { error: string }).error).trim() : '';
  if (code === 'invalid_grant') return 'invalid_grant';
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 400 && code === 'invalid_client') return 'unauthorized';
  return 'unavailable';
};

function grantFrom(
  json: unknown,
  requested: readonly string[],
  now: Date,
  previousRefreshToken: string | null,
): Outcome<TokenGrant, TokenRefusal> {
  const body = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown } | null;
  const accessToken = typeof body?.access_token === 'string' ? body.access_token.trim() : '';
  if (accessToken.length === 0) return refuse('response_malformed');
  if (String(body?.token_type ?? '').toLowerCase() !== 'bearer') return refuse('token_type_unsupported');
  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : Number.NaN;
  if (!Number.isInteger(expiresIn) || expiresIn <= 0) return refuse('expiry_invalid');
  const granted = typeof body?.scope === 'string'
    ? body.scope.split(/\s+/).map(scope => scope.trim()).filter(scope => scope.length > 0)
    : [...requested];
  // What the provider actually granted decides, not what was asked for.
  if (assertReadOnlyScopes(granted)) return refuse('granted_scope_refused');
  if (granted.some(scope => !requested.includes(scope))) return refuse('granted_scope_widened');
  const refreshToken = typeof body?.refresh_token === 'string' && body.refresh_token.trim().length > 0
    ? body.refresh_token.trim()
    : previousRefreshToken;
  const expiresAt = new Date(now.getTime() + Math.max(expiresIn - TOKEN_EXPIRY_SKEW_SECONDS, 1) * 1000).toISOString();
  return accept({ accessToken, refreshToken, expiresAt, scopes: granted });
}

/** Authorisation code for tokens. The verifier proves this is the same client that started it. */
export async function exchangeAuthorizationCode(
  dependencies: TransportDependencies,
  configuration: CalendarConfiguration,
  input: { code: string; codeVerifier: string },
): Promise<Outcome<TokenGrant, TokenRefusal>> {
  if (!CODE_VERIFIER.test(input.codeVerifier)) return refuse('response_malformed');
  let response: { status: number; json: unknown };
  try {
    response = await dependencies.postForm({
      url: TOKEN_ENDPOINT,
      body: {
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        client_id: configuration.clientId,
        client_secret: await dependencies.clientSecret(configuration.clientSecretArn),
        redirect_uri: configuration.redirectUri,
      },
    });
  } catch { return refuse('transport_failed'); }
  if (response.status !== 200) return refuse(providerErrorFor(response.status, response.json));
  return grantFrom(response.json, configuration.scopes, dependencies.now(), null);
}

export type RefreshOutcome =
  | { ok: true; value: TokenGrant }
  | { ok: false; refusal: TokenRefusal; nextState: CalendarConnectionState };

/**
 * A refresh that fails is also a statement about the connection: `invalid_grant` means the
 * authorisation is gone and must not be retried, while a rate limit changes nothing.
 */
export async function refreshAccessToken(
  dependencies: TransportDependencies,
  configuration: CalendarConfiguration,
  connection: CalendarConnection,
  refreshToken: string,
): Promise<RefreshOutcome> {
  const unchanged = connection.state;
  if (refreshToken.trim().length === 0) return { ok: false, refusal: 'invalid_grant', nextState: 'revoked' };
  let response: { status: number; json: unknown };
  try {
    response = await dependencies.postForm({
      url: TOKEN_ENDPOINT,
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: configuration.clientId,
        client_secret: await dependencies.clientSecret(configuration.clientSecretArn),
      },
    });
  } catch { return { ok: false, refusal: 'transport_failed', nextState: unchanged }; }
  if (response.status !== 200) {
    const error = providerErrorFor(response.status, response.json);
    return { ok: false, refusal: error, nextState: nextStateAfterProviderError(connection, error) };
  }
  const grant = grantFrom(response.json, connection.scopes, dependencies.now(), refreshToken);
  if (!grant.ok) return { ok: false, refusal: grant.refusal, nextState: unchanged };
  return grant;
}

export type BusyReadRefusal =
  | 'not_enabled'
  | 'window_invalid'
  | 'window_too_long'
  | 'calendars_absent'
  | 'too_many_calendars'
  | 'calendar_id_invalid'
  | 'transport_failed'
  | 'response_malformed'
  | 'not_readable'
  | ProviderError;

export type BusyRead = BusyMappingOutcome & {
  /** Calendars the provider reported an error for, counted and never guessed at as free. */
  unavailableCalendars: number;
};

export type BusyReadOutcome =
  | { ok: true; value: BusyRead }
  | { ok: false; refusal: BusyReadRefusal; nextState: CalendarConnectionState };

/**
 * The free/busy read. A calendar the provider could not answer for is counted, never
 * treated as free — an unreadable calendar is an unknown, and unknown is not empty.
 */
export async function readBusyIntervals(
  dependencies: { postJson: JsonPost; now: () => Date },
  connection: CalendarConnection,
  input: { accessToken: string; window: BusyInterval; calendarIds: readonly string[] },
): Promise<BusyReadOutcome> {
  const unchanged = connection.state;
  const notReadable = calendarReadable(connection, dependencies.now().toISOString());
  if (notReadable) return { ok: false, refusal: 'not_readable', nextState: unchanged };
  const from = Date.parse(input.window.start);
  const to = Date.parse(input.window.end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { ok: false, refusal: 'window_invalid', nextState: unchanged };
  if (to - from > MAX_BUSY_WINDOW_DAYS * 86_400_000) return { ok: false, refusal: 'window_too_long', nextState: unchanged };
  if (input.calendarIds.length === 0) return { ok: false, refusal: 'calendars_absent', nextState: unchanged };
  if (input.calendarIds.length > MAX_CALENDARS_PER_READ) return { ok: false, refusal: 'too_many_calendars', nextState: unchanged };
  if (input.calendarIds.some(id => typeof id !== 'string' || id.trim().length === 0 || id.length > 320)) {
    return { ok: false, refusal: 'calendar_id_invalid', nextState: unchanged };
  }
  let response: { status: number; json: unknown };
  try {
    response = await dependencies.postJson({
      url: FREEBUSY_ENDPOINT,
      accessToken: input.accessToken,
      body: {
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        items: input.calendarIds.map(id => ({ id })),
      },
    });
  } catch { return { ok: false, refusal: 'transport_failed', nextState: unchanged }; }
  if (response.status !== 200) {
    const error = providerErrorFor(response.status, response.json);
    return { ok: false, refusal: error, nextState: nextStateAfterProviderError(connection, error) };
  }
  const calendars = (response.json as { calendars?: unknown } | null)?.calendars;
  if (!calendars || typeof calendars !== 'object' || Array.isArray(calendars)) {
    return { ok: false, refusal: 'response_malformed', nextState: unchanged };
  }
  const raw: unknown[] = [];
  let unavailableCalendars = 0;
  for (const id of input.calendarIds) {
    const entry = (calendars as Record<string, unknown>)[id] as { busy?: unknown; errors?: unknown } | undefined;
    if (!entry || (Array.isArray(entry.errors) && entry.errors.length > 0)) { unavailableCalendars += 1; continue; }
    if (!Array.isArray(entry.busy)) { unavailableCalendars += 1; continue; }
    raw.push(...entry.busy);
  }
  const mapped = mapBusyIntervals(raw, input.window);
  return { ok: true, value: { ...mapped, unavailableCalendars } };
}

/**
 * A sealed token, bound to the thing it belongs to.
 *
 * The binding is authenticated additional data, so a ciphertext lifted from one row
 * cannot be opened against another. A refresh token is bound to its connection id; a
 * PKCE verifier is bound to the digest of the authorization state it was issued with,
 * which ties it to one attempt rather than to a row that does not exist yet.
 */
export type SealedToken = { ciphertext: string; iv: string; tag: string; binding: string };
export type SealedEnvelope = Pick<SealedToken, 'ciphertext' | 'iv' | 'tag'>;
export type SealRefusal = 'key_invalid' | 'binding_absent' | 'token_absent';
export type OpenRefusal = 'key_invalid' | 'binding_absent' | 'envelope_malformed' | 'not_authentic';

const KEY_BYTES = 32;

export function sealCalendarToken(
  dataKey: Buffer,
  binding: string,
  token: string,
): Outcome<SealedToken, SealRefusal> {
  if (dataKey.length !== KEY_BYTES) return refuse('key_invalid');
  if (binding.trim().length === 0) return refuse('binding_absent');
  if (token.length === 0) return refuse('token_absent');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return accept({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    binding,
  });
}

export function openCalendarToken(
  dataKey: Buffer,
  binding: string,
  sealed: SealedEnvelope,
): Outcome<string, OpenRefusal> {
  if (dataKey.length !== KEY_BYTES) return refuse('key_invalid');
  if (binding.trim().length === 0) return refuse('binding_absent');
  let iv: Buffer; let tag: Buffer; let ciphertext: Buffer;
  try {
    iv = Buffer.from(sealed.iv, 'base64');
    tag = Buffer.from(sealed.tag, 'base64');
    ciphertext = Buffer.from(sealed.ciphertext, 'base64');
  } catch { return refuse('envelope_malformed'); }
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return refuse('envelope_malformed');
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(tag);
    return accept(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { return refuse('not_authentic'); }
}

/**
 * What a caller may log or show. Provider errors can echo a token or an event title back;
 * nothing but the code and a coarse class leaves this module.
 */
export function describeTransportFailure(refusal: string): { code: string; retryable: boolean; reauthorize: boolean } {
  const reauthorize = refusal === 'invalid_grant' || refusal === 'unauthorized' || refusal === 'authorization_declined';
  const retryable = refusal === 'rate_limited' || refusal === 'unavailable' || refusal === 'transport_failed';
  return { code: refusal, retryable, reauthorize };
}
