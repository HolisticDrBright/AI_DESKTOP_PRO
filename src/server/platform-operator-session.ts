import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

/**
 * The platform operator's own browser session, kept apart from the practitioner's.
 *
 * - The operator's ID token lives in `aidp_op`, an httpOnly, SameSite=strict cookie scoped to `/api/operator`, so no
 *   practitioner page or route ever receives it, and it lasts 15 minutes: the operator API refuses an older sign-in.
 * - The MFA step's Cognito session lives in `aidp_op_mfa` / `aidp_op_mfu` for 5 minutes, on the same path.
 * - Nothing here reads or writes a practitioner cookie (`aidp_at` and the rest): a practitioner token is never an
 *   operator's, and an operator route never falls back to one.
 */
export const OPERATOR_COOKIES = { token: 'aidp_op', challenge: 'aidp_op_mfa', username: 'aidp_op_mfu' } as const;
export const OPERATOR_COOKIE_PATH = '/api/operator';
export const OPERATOR_SESSION_SECONDS = 15 * 60;
const CHALLENGE_SECONDS = 5 * 60;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const options = (maxAge: number) => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const,
  path: OPERATOR_COOKIE_PATH, maxAge });

/** The operator token for this request, or null. Exactly one well-formed `aidp_op`; anything else is no session. */
export async function readOperatorToken(): Promise<string | null> {
  try {
    const store = await cookies();
    const values = (store.getAll?.(OPERATOR_COOKIES.token) ?? []).map(cookie => cookie.value);
    if (values.length !== 1 || values[0]!.length > 16384 || !JWT.test(values[0]!)) return null;
    return values[0]!;
  } catch { return null; }
}
export async function readOperatorChallenge(): Promise<{ session: string; username: string } | null> {
  try {
    const store = await cookies();
    const session = store.get(OPERATOR_COOKIES.challenge)?.value ?? '', username = store.get(OPERATOR_COOKIES.username)?.value ?? '';
    if (!session || session.length > 4096 || !username || username.length > 256) return null;
    return { session, username };
  } catch { return null; }
}
export function writeOperatorChallenge(response: NextResponse, challenge: { session: string; username: string }) {
  response.cookies.set(OPERATOR_COOKIES.challenge, challenge.session, options(CHALLENGE_SECONDS));
  response.cookies.set(OPERATOR_COOKIES.username, challenge.username, options(CHALLENGE_SECONDS));
}
export function writeOperatorSession(response: NextResponse, idToken: string) {
  response.cookies.set(OPERATOR_COOKIES.token, idToken, options(OPERATOR_SESSION_SECONDS));
  for (const name of [OPERATOR_COOKIES.challenge, OPERATOR_COOKIES.username]) response.cookies.set(name, '', options(0));
}
export function clearOperatorSession(response: NextResponse) {
  for (const name of Object.values(OPERATOR_COOKIES)) response.cookies.set(name, '', options(0));
}
