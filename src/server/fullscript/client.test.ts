import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  createFullscriptAuthorization,
  exchangeFullscriptAuthorizationCode,
  FullscriptApiClient,
  readFullscriptConfiguration,
  revokeFullscriptToken,
  verifyFullscriptState,
  verifyFullscriptWebhook,
} from "./client";

const configuration = readFullscriptConfiguration({
  NODE_ENV: "test",
  FULLSCRIPT_ENVIRONMENT: "sandbox_us",
  FULLSCRIPT_CLIENT_ID: "sandbox-client-id-1234567890",
  FULLSCRIPT_CLIENT_SECRET: "sandbox-secret-1234567890",
  FULLSCRIPT_OAUTH_AUTHORIZE_URL: "https://api-us-snd.fullscript.io/api/oauth/authorize",
  FULLSCRIPT_REDIRECT_URI: "https://desktop.example.test/api/live/fullscript/oauth/callback",
  FULLSCRIPT_OAUTH_STATE_SECRET: "state-secret-longer-than-thirty-two-characters",
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Fullscript server boundary", () => {
  test("accepts only the canonical sandbox OAuth host and refuses premature production", () => {
    expect(configuration.apiOrigin).toBe("https://api-us-snd.fullscript.io/api");
    expect(() => readFullscriptConfiguration({
      ...configurationEnv(),
      FULLSCRIPT_OAUTH_AUTHORIZE_URL: "https://attacker.example/oauth",
    })).toThrow(/canonical/);
    expect(() => readFullscriptConfiguration({
      ...configurationEnv(),
      FULLSCRIPT_ENVIRONMENT: "production_us",
    })).toThrow(/production use is not approved/);
  });

  test("signs, validates, expires, and tamper-refuses OAuth state", () => {
    const started = createFullscriptAuthorization({
      configuration,
      actorKey: "a".repeat(64),
      organizationId: "11111111-1111-4111-8111-111111111111",
      nonce: "n".repeat(32),
      now: 1_000_000,
    });
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(configuration.authorizeUrl);
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(verifyFullscriptState(started.state, configuration.stateSecret, 1_100_000)).toMatchObject({
      actorKey: "a".repeat(64),
      organizationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(() => verifyFullscriptState(`${started.state}x`, configuration.stateSecret, 1_100_000)).toThrow();
    expect(() => verifyFullscriptState(started.state, configuration.stateSecret, 2_000_000)).toThrow(/expired/);
  });

  test("exchanges an authorization code without exposing the secret in the result", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sent.client_secret).toBe(configuration.clientSecret);
      return json({ oauth: {
        access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
        refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
        expires_in: 7200,
        created_at: "2026-08-28T12:00:00.000Z",
        scope: "catalog:read patients:read",
        resource_owner: { id: "11111111-1111-4111-8111-111111111111", type: "Practitioner" },
      } });
    });
    const token = await exchangeFullscriptAuthorizationCode({
      configuration,
      code: "authorization-code-abcdefghijklmnopqrstuvwxyz",
      fetcher: fetcher as typeof fetch,
    });
    expect(token.scope).toEqual(["catalog:read", "patients:read"]);
    expect(JSON.stringify(token)).not.toContain(configuration.clientSecret);
  });

  test("uses catalog, lab, and fresh practitioner dynamic-link endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return json({ redirect_url: "https://us.fullscript.com/treatment-plan/example" });
    });
    const client = new FullscriptApiClient(
      configuration,
      "access-token-abcdefghijklmnopqrstuvwxyz",
      fetcher as typeof fetch,
    );
    await client.searchProducts("magnesium");
    await client.searchLabs("thyroid");
    await client.retrieveLabOrder("11111111-1111-4111-8111-111111111111");
    await client.retrieveNewTreatmentPlanLink();
    await client.createLabTreatmentPlan({
      fullscriptPatientId: "33333333-3333-4333-8333-333333333333",
      practitionerId: "22222222-2222-4222-8222-222222222222",
      labTestId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "synthetic-lab-action-00000001",
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/catalog/search/products",
      "/api/labs/search/tests",
      "/api/clinic/labs/orders/11111111-1111-4111-8111-111111111111",
      "/api/clinic/dynamic_links/treatment_plans",
      "/api/clinic/patients/33333333-3333-4333-8333-333333333333/treatment_plans",
    ]);
    expect(calls.at(-1)?.init?.headers).toMatchObject({ "idempotency-key": "synthetic-lab-action-00000001" });
    expect(calls.at(-1)?.init?.body).toContain('"send_to_patient":true');
    expect(JSON.stringify(calls)).not.toContain(configuration.clientSecret);
  });

  test("revokes server-side tokens with application credentials", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        token: "access-token-abcdefghijklmnopqrstuvwxyz",
      });
      return new Response(null, { status: 200 });
    });
    await revokeFullscriptToken({
      configuration,
      token: "access-token-abcdefghijklmnopqrstuvwxyz",
      fetcher: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("verifies fresh webhook HMAC and refuses replays or body changes", () => {
    const body = JSON.stringify({ event_payload: { event: { id: "evt-1", type: "lab_order.updated" } } });
    const secret = "webhook-secret-long-enough-for-hmac";
    const timestamp = 1_700_000_000;
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const header = `t=${timestamp},v1=${signature}`;
    expect(verifyFullscriptWebhook({ body, signatureHeader: header, webhookSecret: secret, now: timestamp * 1000 })).toBe(true);
    expect(verifyFullscriptWebhook({ body: `${body} `, signatureHeader: header, webhookSecret: secret, now: timestamp * 1000 })).toBe(false);
    expect(verifyFullscriptWebhook({ body, signatureHeader: header, webhookSecret: secret, now: (timestamp + 301) * 1000 })).toBe(false);
  });
});

function configurationEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    FULLSCRIPT_ENVIRONMENT: "sandbox_us",
    FULLSCRIPT_CLIENT_ID: "sandbox-client-id-1234567890",
    FULLSCRIPT_CLIENT_SECRET: "sandbox-secret-1234567890",
    FULLSCRIPT_REDIRECT_URI: "https://desktop.example.test/api/live/fullscript/oauth/callback",
    FULLSCRIPT_OAUTH_STATE_SECRET: "state-secret-longer-than-thirty-two-characters",
  };
}
