import { describe, expect, test, vi } from "vitest";
import { createConsumerAccountApiHandler, ConsumerAccountProviderError, type ConsumerAccountProvider } from "./aws-consumer-account";
import type { ClinicalCoreDatabase } from "./database";

const PERSON = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

function setup(overrides: Partial<ConsumerAccountProvider> = {}) {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const database: ClinicalCoreDatabase = { transaction: async (work) => work({ query }) };
  const provider: ConsumerAccountProvider = {
    register: vi.fn(async () => undefined),
    confirm: vi.fn(async () => ({ subject: "consumer-subject-123", personId: PERSON, organizationId: ORG })),
    resendConfirmation: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async () => undefined),
    confirmPasswordReset: vi.fn(async () => undefined),
    ...overrides,
  };
  const run = createConsumerAccountApiHandler({
    database,
    provider,
    configuration: { boundary: "synthetic", termsVersion: "terms-2026-08", privacyVersion: "privacy-2026-08" },
  });
  return { run, provider, query };
}

function event(routeKey: string, body: Record<string, unknown>) {
  return { routeKey, rawPath: routeKey.split(" ")[1], headers: {}, body: JSON.stringify(body) };
}

describe("consumer account API", () => {
  test("creates only server-bound synthetic registration requests", async () => {
    const { run, provider } = setup();
    const result = await run(event("POST /clinical-core/public/consumer/register", {
      email: "Person@Example.com", password: "StrongPassword!27",
      acceptsTerms: true, acceptsPrivacy: true, attestsSyntheticOnly: true,
      termsVersion: "terms-2026-08", privacyVersion: "privacy-2026-08",
    }));
    expect(result.statusCode).toBe(202);
    expect(provider.register).toHaveBeenCalledWith(expect.objectContaining({
      email: "person@example.com", boundary: "synthetic",
      personId: expect.stringMatching(/^[0-9a-f-]{36}$/), organizationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    expect(result.body).not.toContain("email");
  });

  test("requires exact terms, privacy, synthetic attestation, and strong password", async () => {
    const { run, provider } = setup();
    const result = await run(event("POST /clinical-core/public/consumer/register", {
      email: "person@example.com", password: "short", acceptsTerms: true, acceptsPrivacy: true,
      attestsSyntheticOnly: false, termsVersion: "wrong", privacyVersion: "privacy-2026-08",
    }));
    expect(result.statusCode).toBe(400);
    expect(provider.register).not.toHaveBeenCalled();
  });

  test("confirms and idempotently bootstraps the opaque identity without storing email", async () => {
    const { run, query } = setup();
    const result = await run(event("POST /clinical-core/public/consumer/registration/confirm", {
      email: "person@example.com", code: "123456",
    }));
    expect(result.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(
      "select * from clinical_private.bootstrap_self_service_consumer($1,$2,$3)",
      [expect.objectContaining({ value: PERSON }), expect.objectContaining({ value: ORG }), "consumer-subject-123"],
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain("person@example.com");
  });

  test("suppresses account enumeration for register, resend, and recovery request", async () => {
    const error = async () => { throw new ConsumerAccountProviderError("confirmation_invalid"); };
    const exists = async () => { throw new ConsumerAccountProviderError("already_exists"); };
    const { run } = setup({ register: exists, resendConfirmation: error, requestPasswordReset: error });
    const registration = await run(event("POST /clinical-core/public/consumer/register", {
      email: "person@example.com", password: "StrongPassword!27", acceptsTerms: true, acceptsPrivacy: true,
      attestsSyntheticOnly: true, termsVersion: "terms-2026-08", privacyVersion: "privacy-2026-08",
    }));
    const resend = await run(event("POST /clinical-core/public/consumer/registration/resend", { email: "person@example.com" }));
    const recovery = await run(event("POST /clinical-core/public/consumer/recovery/request", { email: "person@example.com" }));
    expect([registration.statusCode, resend.statusCode, recovery.statusCode]).toEqual([202, 202, 202]);
  });

  test("completes recovery and returns bounded confirmation failures", async () => {
    const confirmPasswordReset = vi.fn(async () => undefined);
    const { run } = setup({ confirmPasswordReset });
    const result = await run(event("POST /clinical-core/public/consumer/recovery/confirm", {
      email: "person@example.com", code: "654321", password: "Replacement!Password27",
    }));
    expect(result.statusCode).toBe(200);
    expect(confirmPasswordReset).toHaveBeenCalledOnce();
  });
});
