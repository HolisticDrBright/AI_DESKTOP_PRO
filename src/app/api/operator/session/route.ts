import { NextResponse } from 'next/server';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE } from '@/server/platform-operator-release';
import { clearOperatorSession, readOperatorChallenge, readOperatorToken, writeOperatorChallenge, writeOperatorSession } from '@/server/platform-operator-session';
import { finishOperatorSignIn, OperatorSignInFailure, startOperatorSignIn } from '@/server/platform-operator-sign-in';

/**
 * The platform operator's own sign-in on this Desktop: a password, then a TOTP code, against the separate operator pool
 * (src/server/platform-operator-sign-in.ts). BLOCKED by `DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE` before anything is
 * read. It never reads or writes a practitioner cookie; it writes only the operator cookies, scoped to /api/operator.
 * Every refusal reads the same, so the page never says whether an address belongs to an operator.
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const notReleased = () => json(503, { error: 'platform_operator_not_released' });
const ATTEMPTS_PER_MINUTE = 10;
const windows = new Map<string, { count: number; resetAt: number }>();
const limited = (request: Request) => {
  const key = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 128) || 'local';
  const now = Date.now(), current = windows.get(key);
  if (!current || now >= current.resetAt) { windows.set(key, { count: 1, resetAt: now + 60_000 }); return false; }
  current.count += 1;
  return current.count > ATTEMPTS_PER_MINUTE;
};
const failure = (error: unknown) => {
  const code = error instanceof OperatorSignInFailure ? error.code : 'unavailable';
  if (code === 'not_configured') return json(503, { error: 'operator_service_not_configured' });
  if (code === 'invalid') return json(400, { error: 'request_invalid' });
  if (code === 'refused') return json(401, { error: 'platform_operator_refused' });
  return json(503, { error: 'platform_operator_unavailable' });
};

export async function GET() {
  if (DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE !== 'qualification') return notReleased();
  return json(200, { data: { signedIn: Boolean(await readOperatorToken()), mfaPending: Boolean(await readOperatorChallenge()) } });
}

export async function POST(request: Request) {
  if (DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE !== 'qualification') return notReleased();
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  if (limited(request)) return json(429, { error: 'platform_operator_rate_limited' });
  let body: Record<string, unknown>;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) throw new Error('invalid');
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedRequestBody(request, 1024, 5000))) as Record<string, unknown>;
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join() : '';
    if (keys !== 'email,password' && keys !== 'code') throw new Error('invalid');
    if (Object.values(body).some(value => typeof value !== 'string')) throw new Error('invalid');
  } catch { return json(400, { error: 'request_invalid' }); }
  try {
    if ('code' in body) {
      const challenge = await readOperatorChallenge();
      if (!challenge) return json(401, { error: 'operator_sign_in_required' });
      const idToken = await finishOperatorSignIn({ ...challenge, code: String(body.code) });
      const response = json(200, { data: { signedIn: true } });
      writeOperatorSession(response, idToken);
      return response;
    }
    const challenge = await startOperatorSignIn(String(body.email).trim(), String(body.password));
    const response = json(202, { data: { mfaRequired: true } });
    writeOperatorChallenge(response, challenge);
    return response;
  } catch (error) {
    const response = failure(error);
    clearOperatorSession(response);
    return response;
  }
}

export async function DELETE(request: Request) {
  if (DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE !== 'qualification') return notReleased();
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const response = json(200, { data: { signedIn: false } });
  clearOperatorSession(response);
  return response;
}
