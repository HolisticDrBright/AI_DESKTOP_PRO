import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTH_COOKIES,
  completeMfaSignIn,
  passwordSignIn,
  readAuthSession,
  refreshSession,
  signOutSession,
} from "./auth.server";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CLINICAL_AWS_REGION = "us-east-2";
  process.env.CLINICAL_AWS_WORKFORCE_CLIENT_ID = "clientexample123";
  vi.restoreAllMocks();
});

describe("Desktop-owned practitioner auth", () => {
  test("password sign-in uses the Cognito workforce flow without returning tokens to the browser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      AuthenticationResult: {
        IdToken: "id-token",
        AccessToken: "provider-access-token",
        RefreshToken: "refresh-token",
        ExpiresIn: 900,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await passwordSignIn("practitioner@example.test", "not-logged");

    expect(tokens).toMatchObject({
      accessToken: "id-token",
      refreshToken: "refresh-token",
      email: "practitioner@example.test",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cognito-idp.us-east-2.amazonaws.com/");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    });
  });

  test("refresh preserves Cognito's existing refresh token and returns a fresh ID token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      AuthenticationResult: { IdToken: "replacement-id", AccessToken: "replacement-access", ExpiresIn: 900 },
    })));

    await expect(refreshSession("old-refresh")).resolves.toMatchObject({
      accessToken: "replacement-id",
      refreshToken: "old-refresh",
    });
  });

  test("provider sign-out revokes the current Cognito refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchMock);

    await signOutSession("access-token");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cognito-idp.us-east-2.amazonaws.com/");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-amz-target": "AWSCognitoIdentityProviderService.RevokeToken",
    });
  });

  test("an already revoked provider token is still a successful sign-out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ __type: "NotAuthorizedException" }, 400)));
    await expect(signOutSession("expired-token")).resolves.toBeUndefined();
  });

  test("mandatory software-token MFA is completed server-side", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        ChallengeParameters: { USER_ID_FOR_SRP: "opaque-user" },
        Session: "short-lived-session",
      }))
      .mockResolvedValueOnce(response({
        AuthenticationResult: { IdToken: "mfa-id", RefreshToken: "mfa-refresh", ExpiresIn: 900 },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const challenge = await passwordSignIn("practitioner@example.test", "not-logged");
    expect(challenge).toMatchObject({ challenge: "SOFTWARE_TOKEN_MFA", username: "opaque-user" });
    if (!("challenge" in challenge)) throw new Error("expected MFA challenge");
    await expect(completeMfaSignIn({ ...challenge, code: "123456" })).resolves.toMatchObject({
      accessToken: "mfa-id",
      refreshToken: "mfa-refresh",
    });
  });

  test("a new workforce account can enroll mandatory software-token MFA", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        ChallengeName: "MFA_SETUP",
        ChallengeParameters: { USER_ID_FOR_SRP: "opaque-user" },
        Session: "password-session",
      }))
      .mockResolvedValueOnce(response({ SecretCode: "SYNTHETICSETUPKEY", Session: "associate-session" }))
      .mockResolvedValueOnce(response({ Status: "SUCCESS", Session: "verified-session" }))
      .mockResolvedValueOnce(response({
        AuthenticationResult: { IdToken: "setup-id", RefreshToken: "setup-refresh", ExpiresIn: 900 },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const challenge = await passwordSignIn("practitioner@example.test", "not-logged");
    expect(challenge).toMatchObject({
      challenge: "MFA_SETUP",
      username: "opaque-user",
      secretCode: "SYNTHETICSETUPKEY",
    });
    if (!("challenge" in challenge) || challenge.challenge !== "MFA_SETUP") {
      throw new Error("expected MFA setup challenge");
    }
    await expect(completeMfaSignIn({ ...challenge, code: "123456" })).resolves.toMatchObject({
      accessToken: "setup-id",
      refreshToken: "setup-refresh",
    });
    expect(fetchMock.mock.calls.map((call) => call[1]?.headers?.["x-amz-target"])).toEqual([
      "AWSCognitoIdentityProviderService.InitiateAuth",
      "AWSCognitoIdentityProviderService.AssociateSoftwareToken",
      "AWSCognitoIdentityProviderService.VerifySoftwareToken",
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    ]);
  });

  test("cookie session preserves the selected organization and detects expiry", () => {
    const values = new Map<string, string>([
      [AUTH_COOKIES.access, "access-token"],
      [AUTH_COOKIES.refresh, "refresh-token"],
      [AUTH_COOKIES.email, "practitioner@example.test"],
      [AUTH_COOKIES.expires, String(Date.now() + 60_000)],
      [AUTH_COOKIES.org, "organization-1"],
    ]);
    const session = readAuthSession({
      get: (name) => values.has(name) ? { value: values.get(name)! } : undefined,
    });

    expect(session).toMatchObject({
      signedIn: true,
      expired: false,
      orgId: "organization-1",
    });
  });
});
