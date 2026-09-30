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
  buildAuthorizationStart,
  calendarStateDigest,
  callbackParameterRefusal,
  exchangeAuthorizationCode,
  newAuthorizationEntropy,
  openCalendarToken,
  sealCalendarToken,
  type CalendarConfiguration,
  type CallbackParameters,
  type CallbackRefusal,
  type ClientSecretResolver,
  type FormPost,
  type TokenRefusal,
} from './externalCalendarTransport';

export type WorkforceCalendarCall = (request: ExternalCalendarRequest) => Promise<ExternalCalendarResponse>;

export type CalendarFlowDependencies = {
  configuration: CalendarConfiguration;
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
