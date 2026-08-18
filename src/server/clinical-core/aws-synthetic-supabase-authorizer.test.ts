import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createSyntheticSupabaseAuthorizerHandler,
  resetSyntheticAuthorizerCacheForTests,
} from "./aws-synthetic-supabase-authorizer";

const issuer = "https://urcjiehlxoehievobezf.supabase.co/auth/v1";
const subject = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const kid = "synthetic-test-key";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" };

function token(overrides: Record<string, unknown> = {}): string {
  const now = 2_000_000_000;
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer,
    aud: "authenticated",
    exp: now + 3_600,
    iat: now - 10,
    sub: subject,
    session_id: sessionId,
    role: "authenticated",
    email: "p1.staging@brightlongevity.test",
    is_anonymous: false,
    ...overrides,
  })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function handler() {
  return createSyntheticSupabaseAuthorizerHandler({
    now: () => 2_000_000_000_000,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}

describe("synthetic Supabase session authorizer", () => {
  beforeEach(() => {
    resetSyntheticAuthorizerCacheForTests();
    process.env.SYNTHETIC_SUPABASE_ISSUER = issuer;
    process.env.SYNTHETIC_SUPABASE_AUDIENCE = "authenticated";
    process.env.SYNTHETIC_EMAIL_DOMAIN = "@brightlongevity.test";
    process.env.SYNTHETIC_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
    process.env.SYNTHETIC_ALLOWED_SUBJECTS = subject;
  });

  test("authorizes the existing signed-in synthetic app session", async () => {
    await expect(handler()({ identitySource: [`Bearer ${token()}`] })).resolves.toEqual({
      isAuthorized: true,
      context: {
        sub: subject,
        person_id: subject,
        organization_id: "11111111-1111-4111-8111-111111111111",
        synthetic_attested: "true",
        identity_source: "supabase_synthetic_testflight",
      },
    });
  });

  test.each([
    ["wrong domain", { email: "person@example.com" }],
    ["expired", { exp: 1_999_999_999 }],
    ["anonymous", { is_anonymous: true }],
    ["wrong audience", { aud: "anon" }],
    ["missing session", { session_id: undefined }],
    ["unapproved subject", { sub: "99999999-9999-4999-8999-999999999999" }],
  ])("refuses %s tokens", async (_label, overrides) => {
    await expect(handler()({ identitySource: [`Bearer ${token(overrides)}`] })).resolves.toEqual({ isAuthorized: false });
  });

  test("refuses a modified token and never accepts a password or AWS credential", async () => {
    const signed = token();
    const [header, payload, signature] = signed.split(".");
    const modifiedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), email: "p2.staging@brightlongevity.test" })).toString("base64url");
    await expect(handler()({ identitySource: [`Bearer ${header}.${modifiedPayload}.${signature}`] })).resolves.toEqual({ isAuthorized: false });
    await expect(handler()({ headers: { authorization: "BrightLabs!2026Test" } })).resolves.toEqual({ isAuthorized: false });
  });
});
