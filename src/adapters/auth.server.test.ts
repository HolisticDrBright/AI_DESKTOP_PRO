import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTH_COOKIES,
  completeMfaSignIn,
  passwordSignIn,
  readAuthSession,
  refreshSession,
  registerPractitioner,
  confirmPractitionerEmail,
  resendPractitionerCode,
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
  test("self-sign-up sends only email, with no clinic or production-bound claims", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ UserConfirmed: false }));
    vi.stubGlobal("fetch", fetchMock);
    await registerPractitioner("new@example.test", "NotARealPassword!123");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers?.["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.SignUp");
    expect(JSON.parse(init?.body)).toEqual({
      ClientId: "clientexample123",
      Username: "new@example.test",
      Password: "NotARealPassword!123",
      UserAttributes: [{ Name: "email", Value: "new@example.test" }],
    });
  });

  test("existing email is indistinguishable from accepted registration to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ __type: "UsernameExistsException" }, 400)));
    await expect(registerPractitioner("existing@example.test", "NotARealPassword!123")).resolves.toBeUndefined();
  });

  test("confirmation and resend use the workforce client without issuing a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchMock);
    await confirmPractitionerEmail("new@example.test", "123456");
    await resendPractitionerCode("new@example.test");
    expect(fetchMock.mock.calls.map((call) => call[1]?.headers?.["x-amz-target"])).toEqual([
      "AWSCognitoIdentityProviderService.ConfirmSignUp",
      "AWSCognitoIdentityProviderService.ResendConfirmationCode",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({
      ClientId: "clientexample123", Username: "new@example.test", ConfirmationCode: "123456",
    });
  });

  test("resend gives no account-state clue for missing or already confirmed accounts", async () => {
    for (const code of ["UserNotFoundException", "InvalidParameterException"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ __type: code }, 400)));
      await expect(resendPractitionerCode("unavailable@example.test")).resolves.toBeUndefined();
    }
  });

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
