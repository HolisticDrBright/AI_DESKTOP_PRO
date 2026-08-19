if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { AdapterError } from "./errors";
import { evaluateContractFixtureBoundary } from "@/server/runtime/contractFixture";

/**
 * Practitioner session for LIVE mode — AWS Cognito workforce sign-in, held in
 * httpOnly cookies. The browser never sees tokens; route handlers perform the
 * password, MFA, refresh, recovery, and revocation calls server-side. The
 * `accessToken` field below intentionally carries Cognito's ID token because
 * the guarded clinical API accepts only workforce ID tokens (`token_use=id`).
 *
 * Cookie model (all httpOnly, sameSite=lax, secure in production):
 *   aidp_at  — access token (JWT presented by server adapters as bearer)
 *   aidp_rt  — Cognito refresh token
 *   aidp_exp — access-token expiry (epoch ms), for cheap freshness checks
 *   aidp_em  — signed-in email, display only (no PHI)
 *
 * Refresh happens ONLY in route-handler scope (/api/auth/session), where
 * cookies may be written; server components read the session as-is.
 *
 * IMPORTANT: this module never imports next/headers (adapters are reachable
 * from the client module graph). Cookie access lives in app-router files
 * (src/server/session.ts, the auth routes, server components), which pass a
 * cookie store into readAuthSession.
 */

export const AUTH_COOKIES = {
  access: "aidp_at",
  refresh: "aidp_rt",
  expires: "aidp_exp",
  email: "aidp_em",
  /** Active organization (validated against memberships before it is set). */
  org: "aidp_org",
  /** Short-lived Cognito MFA transaction; never exposed to client JavaScript. */
  mfaSession: "aidp_mfa",
  mfaUsername: "aidp_mfu",
  mfaEmail: "aidp_mfe",
} as const;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  email: string;
}

export interface AuthSessionState {
  signedIn: boolean;
  email: string | null;
  /** True when an access token exists but is past expiry (needs refresh/sign-in). */
  expired: boolean;
  expiresAt: number | null;
  /** Active organization id (from the validated org cookie), or null. */
  orgId: string | null;
}

export interface MfaChallenge {
  challenge: "SOFTWARE_TOKEN_MFA";
  session: string;
  username: string;
  email: string;
}

function cognitoConfig(): { endpoint: string; clientId: string } {
  const fixture = evaluateContractFixtureBoundary();
  if (fixture.allowed) {
    return { endpoint: `${fixture.backendOrigin}/`, clientId: "fixtureclient" };
  }
  const region = String(process.env.CLINICAL_AWS_REGION ?? "").trim();
  const clientId = String(process.env.CLINICAL_AWS_WORKFORCE_CLIENT_ID ?? "").trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/i.test(region) || !/^[a-z0-9]{8,128}$/i.test(clientId)) {
    throw new AdapterError(
      "unavailable",
      "Live sign-in is not configured on this deployment.",
      "Cognito workforce configuration missing or invalid",
    );
  }
  return { endpoint: `https://cognito-idp.${region}.amazonaws.com/`, clientId };
}

interface CognitoAuthenticationResult {
  IdToken?: string;
  AccessToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

interface CognitoAuthResponse {
  AuthenticationResult?: CognitoAuthenticationResult;
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

async function cognitoRequest<T>(operation: string, body: Record<string, unknown>): Promise<T> {
  const { endpoint } = cognitoConfig();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    throw new AdapterError("unavailable", undefined, `Cognito ${operation}: ${e instanceof Error ? e.message : "network"}`);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { __type?: string; code?: string };
    const code = String(data.__type ?? data.code ?? "").split("#").pop() ?? "";
    if (["NotAuthorizedException", "UserNotFoundException", "CodeMismatchException", "ExpiredCodeException"].includes(code)) {
      throw new AdapterError("unauthenticated", "Sign-in or verification failed. Check your details and try again.");
    }
    if (["TooManyRequestsException", "LimitExceededException"].includes(code)) {
      throw new AdapterError("unavailable", "Too many attempts. Wait a moment and try again.");
    }
    if (code === "InvalidPasswordException") {
      throw new AdapterError("invalid", "The new password does not meet the workforce password policy.");
    }
    throw new AdapterError("unavailable", undefined, `Cognito ${operation} status ${res.status} ${code}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

function tokensFrom(result: CognitoAuthenticationResult | undefined, refreshToken: string, email: string): AuthTokens {
  if (!result?.IdToken) {
    throw new AdapterError("unauthenticated", "Sign-in failed — check your email and password.");
  }
  return {
    accessToken: result.IdToken,
    refreshToken: result.RefreshToken ?? refreshToken,
    expiresAt: Date.now() + (result.ExpiresIn ?? 900) * 1000,
    email,
  };
}

export async function passwordSignIn(email: string, password: string): Promise<AuthTokens | MfaChallenge> {
  const { clientId } = cognitoConfig();
  const data = await cognitoRequest<CognitoAuthResponse>("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  if (data.ChallengeName === "SOFTWARE_TOKEN_MFA" && data.Session) {
    return {
      challenge: "SOFTWARE_TOKEN_MFA",
      session: data.Session,
      username: data.ChallengeParameters?.USER_ID_FOR_SRP ?? email,
      email,
    };
  }
  if (data.ChallengeName) {
    throw new AdapterError("unauthenticated", "This workforce sign-in requires an unsupported account challenge. Contact an administrator.");
  }
  return tokensFrom(data.AuthenticationResult, "", email);
}

export async function completeMfaSignIn(input: {
  session: string;
  username: string;
  email: string;
  code: string;
}): Promise<AuthTokens> {
  const { clientId } = cognitoConfig();
  if (!/^\d{6}$/.test(input.code)) throw new AdapterError("invalid", "Enter the six-digit authenticator code.");
  const data = await cognitoRequest<CognitoAuthResponse>("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "SOFTWARE_TOKEN_MFA",
    Session: input.session,
    ChallengeResponses: { USERNAME: input.username, SOFTWARE_TOKEN_MFA_CODE: input.code },
  });
  return tokensFrom(data.AuthenticationResult, "", input.email);
}

/**
 * Request a password-reset email. Enumeration-safe by design: any non-network
 * outcome resolves — callers always show the same "if an account exists…"
 * message. Only a network/config failure throws (honest unavailable state).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const { clientId } = cognitoConfig();
  try {
    await cognitoRequest("ForgotPassword", { ClientId: clientId, Username: email });
  } catch (e) {
    if (e instanceof AdapterError && e.code === "unauthenticated") return;
    throw new AdapterError(
      "unavailable",
      "The reset service is unreachable right now. Please try again.",
      e instanceof Error ? e.message : undefined,
    );
  }
}

/**
 * Complete a reset using the one-time Cognito confirmation code delivered to
 * the workforce email address. The code is used once and is never stored.
 */
export async function completePasswordReset(
  email: string,
  confirmationCode: string,
  newPassword: string,
): Promise<void> {
  const { clientId } = cognitoConfig();
  await cognitoRequest("ConfirmForgotPassword", {
    ClientId: clientId,
    Username: email,
    ConfirmationCode: confirmationCode,
    Password: newPassword,
  });
}

export async function refreshSession(refreshToken: string): Promise<AuthTokens> {
  const { clientId } = cognitoConfig();
  const data = await cognitoRequest<CognitoAuthResponse>("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  return tokensFrom(data.AuthenticationResult, refreshToken, "");
}

/**
 * Revoke only the current Cognito session. Cookie clearing remains mandatory
 * even when the provider is unavailable, so callers treat this as best effort.
 */
export async function signOutSession(refreshToken: string): Promise<void> {
  const { clientId } = cognitoConfig();
  try {
    await cognitoRequest("RevokeToken", { ClientId: clientId, Token: refreshToken });
  } catch (e) {
    if (e instanceof AdapterError && e.code === "unauthenticated") return;
    throw new AdapterError(
      "unavailable",
      undefined,
      `auth sign-out: ${e instanceof Error ? e.message : "network"}`,
    );
  }

}

/** Minimal cookie-store shape (matches next/headers' ReadonlyRequestCookies). */
export interface CookieStoreLike {
  get(name: string): { value: string } | undefined;
}

/** Read the session from a request cookie store passed in by an app-router file. */
export function readAuthSession(
  store: CookieStoreLike,
): AuthSessionState & { accessToken: string | null; refreshToken: string | null } {
  const accessToken = store.get(AUTH_COOKIES.access)?.value ?? null;
  const refreshToken = store.get(AUTH_COOKIES.refresh)?.value ?? null;
  const email = store.get(AUTH_COOKIES.email)?.value ?? null;
  const expiresAt = Number(store.get(AUTH_COOKIES.expires)?.value ?? 0) || null;
  const expired = Boolean(accessToken && expiresAt && Date.now() > expiresAt - 30_000);
  const orgId = store.get(AUTH_COOKIES.org)?.value || null;
  return {
    signedIn: Boolean(accessToken && !expired),
    email,
    expired,
    expiresAt,
    orgId,
    accessToken,
    refreshToken,
  };
}

/** Cookie attributes shared by the auth route handlers. */
export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
