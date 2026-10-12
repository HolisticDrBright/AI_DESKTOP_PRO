if (typeof window !== 'undefined') throw new Error('learner/consumer-signin is server-only.');
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CognitoIdentityProviderClient, GlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BoundedBodyError, readBoundedRequestBody } from '../bounded-request-body';
import { CONSUMER_ACCESS_COOKIE, CONSUMER_ID_COOKIE, CONSUMER_SIGNIN_COOKIE, cookieValue, sessionTokensFrom, type ReviewedLearnerRuntime } from './reviewed-learner-host';

/**
 * The Desktop's consumer sign-in for My courses: the user pool's hosted sign-in with the
 * authorization-code flow and PKCE, a public app client (no client secret on this server), and the
 * resulting ID and access tokens held ONLY in HttpOnly, Secure, SameSite=Strict, host-only cookies.
 * No refresh token is kept: when the access token ends, the learner signs in again.
 *
 *   start     a fresh state and code verifier, bound to this browser by a short-lived HttpOnly cookie,
 *             and a redirect to the pool's hosted sign-in with the S256 challenge;
 *   callback  the state must match the cookie (constant time) and is single use; the code is
 *             exchanged at the pool's token endpoint under one deadline and a byte bound; the tokens
 *             are then VERIFIED (signature, claims, revocation, owner) before any cookie is set. A
 *             token the verifier refuses is never stored;
 *   sign out  Cognito GlobalSignOut on the access token (every session of the user, every device),
 *             then the cookies are cleared. The cookies are cleared even if Cognito cannot be reached,
 *             and the reply says whether the revocation was confirmed.
 * Nothing here accepts a token, subject, person or clinic from a request body or query.
 */
export const CALLBACK_PATH = '/api/my-courses/session/callback';
const SCOPES = 'openid email profile aws.cognito.signin.user.admin';
const EXCHANGE_DEADLINE_MS = 10_000;
const MAX_TOKEN_REPLY_BYTES = 32_768;
const SESSION_MAX_AGE_SECONDS = 3600;
const SIGNIN_MAX_AGE_SECONDS = 600;
const b64url = (bytes: Buffer) => bytes.toString('base64url');
const NOINDEX = { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } as const;

const cookie = (name: string, value: string, maxAge: number, sameSite: 'Strict' | 'Lax') => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
const cleared = (name: string) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const redirect = (location: string, cookies: string[]) => {
  const headers = new Headers({ ...NOINDEX, Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
};
const refuse = (status: number, code: string, cookies: string[] = []) => {
  const headers = new Headers({ ...NOINDEX, 'Content-Type': 'application/json' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify({ error: { code, message: code } }), { status, headers });
};

export function signInStart(learner: ReviewedLearnerRuntime | null): Response {
  if (!learner) return refuse(503, 'learner_host_unavailable');
  const state = b64url(randomBytes(32)), verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const authorize = new URL('/oauth2/authorize', learner.consumer.signInOrigin);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: learner.consumer.clientId, redirect_uri: learner.consumer.desktopOrigin + CALLBACK_PATH,
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return redirect(authorize.toString(), [cookie(CONSUMER_SIGNIN_COOKIE, `${state}.${verifier}`, SIGNIN_MAX_AGE_SECONDS, 'Lax')]);
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function exchange(learner: ReviewedLearnerRuntime, code: string, verifier: string, fetchImpl: Fetch): Promise<{ idToken: string; accessToken: string } | null> {
  const signal = AbortSignal.timeout(EXCHANGE_DEADLINE_MS);
  try {
    const response = await fetchImpl(new URL('/oauth2/token', learner.consumer.signInOrigin).toString(), {
      method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: learner.consumer.clientId, code, redirect_uri: learner.consumer.desktopOrigin + CALLBACK_PATH, code_verifier: verifier }).toString(),
    });
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); return null; }
    const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal }, MAX_TOKEN_REPLY_BYTES, EXCHANGE_DEADLINE_MS);
    const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (typeof json.id_token !== 'string' || typeof json.access_token !== 'string' || json.token_type !== 'Bearer') return null;
    return { idToken: json.id_token, accessToken: json.access_token };
  } catch (error) {
    if (error instanceof BoundedBodyError) return null;
    return null;
  }
}

export async function signInCallback(request: Request, learner: ReviewedLearnerRuntime | null, fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<Response> {
  // The sign-in cookie is single use: every answer below clears it.
  const used = cleared(CONSUMER_SIGNIN_COOKIE);
  if (!learner) return refuse(503, 'learner_host_unavailable', [used]);
  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? '', state = url.searchParams.get('state') ?? '';
  const bound = cookieValue(request, CONSUMER_SIGNIN_COOKIE) ?? '';
  const [boundState = '', verifier = ''] = bound.split('.');
  const back = (outcome: string, cookies: string[]) => redirect(`${learner.consumer.desktopOrigin}/courses${outcome ? `?signin=${outcome}` : ''}`, [used, ...cookies]);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(boundState) || !/^[A-Za-z0-9_-]{64}$/.test(verifier)
    || !timingSafeEqual(Buffer.from(state), Buffer.from(boundState)) || !/^[A-Za-z0-9-]{1,128}$/.test(code)) return back('refused', []);
  const tokens = await exchange(learner, code, verifier, fetchImpl);
  if (!tokens) return back('unavailable', []);
  const verified = await learner.verify(tokens);
  if (verified.state === 'unavailable') return back('unavailable', []);
  if (verified.state !== 'verified') return back('refused', []);
  return back('', [
    cookie(CONSUMER_ID_COOKIE, tokens.idToken, SESSION_MAX_AGE_SECONDS, 'Strict'),
    cookie(CONSUMER_ACCESS_COOKIE, tokens.accessToken, SESSION_MAX_AGE_SECONDS, 'Strict'),
  ]);
}

export type GlobalSignOut = (accessToken: string) => Promise<void>;
export const cognitoGlobalSignOut: GlobalSignOut = async accessToken => {
  const client = new CognitoIdentityProviderClient({ region: 'us-east-2', endpoint: 'https://cognito-idp.us-east-2.amazonaws.com', maxAttempts: 1 });
  await client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
};

export async function signOut(request: Request, signOutEverywhere: GlobalSignOut = cognitoGlobalSignOut): Promise<Response> {
  const tokens = sessionTokensFrom(request);
  let revoked = false;
  if (tokens) { try { await signOutEverywhere(tokens.accessToken); revoked = true; } catch { revoked = false; } }
  const headers = new Headers({ ...NOINDEX, 'Content-Type': 'application/json' });
  for (const name of [CONSUMER_ID_COOKIE, CONSUMER_ACCESS_COOKIE, CONSUMER_SIGNIN_COOKIE]) headers.append('Set-Cookie', cleared(name));
  return new Response(JSON.stringify({ data: { signedOut: true, revocationConfirmed: revoked } }), { status: 200, headers });
}
