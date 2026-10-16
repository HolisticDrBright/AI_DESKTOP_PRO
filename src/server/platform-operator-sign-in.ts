/**
 * The platform operator's sign-in against the SEPARATE operator user pool's own app client
 * (`PLATFORM_OPERATOR_COGNITO_CLIENT_ID`, us-east-2). Source only: no operator pool or client exists, and the console
 * route that calls this is blocked (src/server/platform-operator-release.ts).
 *
 * - A client id equal to the workforce or consumer client is refused as not configured: the operator login is never
 *   the practitioner login under another name.
 * - Only a password step answered by Cognito's TOTP challenge (`SOFTWARE_TOKEN_MFA`) can continue. A password that
 *   signs in without MFA, an SMS or e-mail factor, or an MFA-setup challenge is refused and nothing is stored: an
 *   operator's authenticator is enrolled by the reviewed owner-run change, never from this page.
 * - The answer is the ID token alone; no refresh token is kept, so operator authority ends with the 15-minute session.
 * Whether the subject is a registered, active operator is decided by the operator API and the SQL registry, not here.
 */
const ENDPOINT = 'https://cognito-idp.us-east-2.amazonaws.com/';
const CLIENT = /^[a-z0-9]{26}$/;

export class OperatorSignInFailure extends Error {
  constructor(readonly code: 'not_configured' | 'refused' | 'unavailable' | 'invalid') { super(code); }
}

export function operatorClientId(): string | null {
  const clientId = String(process.env.PLATFORM_OPERATOR_COGNITO_CLIENT_ID ?? '').trim();
  if (!CLIENT.test(clientId)) return null;
  const others = [process.env.CLINICAL_AWS_WORKFORCE_CLIENT_ID, process.env.CONSUMER_AUTH_CLIENT_ID].map(value => String(value ?? '').trim()).filter(Boolean);
  return others.includes(clientId) ? null : clientId;
}

async function cognito(operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, { method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${operation}` },
      body: JSON.stringify(body) });
  } catch { throw new OperatorSignInFailure('unavailable'); }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = String(data?.__type ?? '').split('#').pop() ?? '';
    if (['TooManyRequestsException', 'LimitExceededException', 'InternalErrorException', 'ServiceUnavailable'].includes(code) || response.status >= 500) {
      throw new OperatorSignInFailure('unavailable');
    }
    throw new OperatorSignInFailure('refused');
  }
  if (!data || typeof data !== 'object') throw new OperatorSignInFailure('unavailable');
  return data;
}

export async function startOperatorSignIn(email: string, password: string): Promise<{ session: string; username: string }> {
  const clientId = operatorClientId();
  if (!clientId) throw new OperatorSignInFailure('not_configured');
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) || !password || password.length > 256) throw new OperatorSignInFailure('invalid');
  const data = await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: email, PASSWORD: password } });
  const parameters = (data.ChallengeParameters ?? {}) as Record<string, unknown>;
  if (data.ChallengeName !== 'SOFTWARE_TOKEN_MFA' || typeof data.Session !== 'string' || !data.Session || data.AuthenticationResult) {
    throw new OperatorSignInFailure('refused');
  }
  return { session: data.Session, username: typeof parameters.USER_ID_FOR_SRP === 'string' ? parameters.USER_ID_FOR_SRP : email };
}

export async function finishOperatorSignIn(input: { session: string; username: string; code: string }): Promise<string> {
  const clientId = operatorClientId();
  if (!clientId) throw new OperatorSignInFailure('not_configured');
  if (!/^\d{6}$/.test(input.code)) throw new OperatorSignInFailure('invalid');
  const data = await cognito('RespondToAuthChallenge', { ClientId: clientId, ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: input.session,
    ChallengeResponses: { USERNAME: input.username, SOFTWARE_TOKEN_MFA_CODE: input.code } });
  const result = (data.AuthenticationResult ?? {}) as Record<string, unknown>;
  if (data.ChallengeName || typeof result.IdToken !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.IdToken)) {
    throw new OperatorSignInFailure('refused');
  }
  return result.IdToken;
}
