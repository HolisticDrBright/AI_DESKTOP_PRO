import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ send: vi.fn(), query: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class Command { constructor(public input: unknown) {} }
  return { CognitoIdentityProviderClient: class { send = mock.send; },
    AdminGetUserCommand: class extends Command {}, ConfirmForgotPasswordCommand: class extends Command {},
    ConfirmSignUpCommand: class extends Command {}, DescribeUserPoolClientCommand: class extends Command {},
    DescribeUserPoolCommand: class extends Command {},
    ForgotPasswordCommand: class extends Command {}, ResendConfirmationCodeCommand: class extends Command {}, SignUpCommand: class extends Command {},
  };
});
vi.mock("./rds-data-database", () => ({ createRdsDataClinicalCoreDatabase: () => ({ transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: mock.query }) }) }));
beforeEach(() => {
  vi.resetModules(); mock.send.mockReset(); mock.query.mockReset();
  for (const [key, value] of Object.entries({ AWS_REGION: "us-east-2", CONSUMER_USER_POOL_ID: "us-east-2_Test",
    CONSUMER_USER_POOL_CLIENT_ID: "a".repeat(26), CONSUMER_ACCOUNT_BOUNDARY: "synthetic",
    CLINICAL_DATABASE_CLUSTER_ARN: "test", CLINICAL_DATABASE_SECRET_ARN: "test", CLINICAL_DATABASE_NAME: "test",
    CONSUMER_TERMS_VERSION: "terms-1", CONSUMER_PRIVACY_VERSION: "privacy-1" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
describe("Cognito confirmation evidence", () => {
  const registration = { routeKey: "POST /clinical-core/public/consumer/register", body: JSON.stringify({
    email: "synthetic@example.invalid", password: "SyntheticOnly!27", dateOfBirth: "2000-01-01",
    attestsAdult: true, registrationPolicy: "adult-self-service/1", acceptsTerms: true,
    acceptsPrivacy: true, attestsSyntheticOnly: true, termsVersion: "terms-1", privacyVersion: "privacy-1",
  }) };

  test("refuses registration before SignUp when the pool cannot auto-verify email", async () => {
    let observedPool = { Id: "us-east-2_Test", AutoVerifiedAttributes: [] as string[] };
    mock.send.mockImplementation(async command => {
      if (command.constructor.name === "DescribeUserPoolCommand") return {
        UserPool: observedPool,
      };
      if (command.constructor.name === "DescribeUserPoolClientCommand") return {
        UserPoolClient: { ClientSecret: "test-only-placeholder" },
      };
      return {};
    });
    const { handler } = await import("./aws-consumer-account-lambda");
    for (const pool of [
      { Id: "us-east-2_Test", AutoVerifiedAttributes: [] },
      { Id: "us-east-2_Other", AutoVerifiedAttributes: ["email"] },
    ]) {
      observedPool = pool;
      const result = await handler(registration);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toBe("provider_unavailable");
    }
    expect(mock.send.mock.calls.some(([command]) => command.constructor.name === "SignUpCommand")).toBe(false);
  });

  test("requires an email code-delivery receipt before reporting registration success", async () => {
    let signupResponse: Record<string, unknown> = { UserConfirmed: false };
    mock.send.mockImplementation(async command => {
      if (command.constructor.name === "DescribeUserPoolCommand") return {
        UserPool: { Id: "us-east-2_Test", AutoVerifiedAttributes: ["email"] },
      };
      if (command.constructor.name === "DescribeUserPoolClientCommand") return {
        UserPoolClient: { ClientSecret: "test-only-placeholder" },
      };
      if (command.constructor.name === "SignUpCommand") return signupResponse;
      return {};
    });
    const { handler } = await import("./aws-consumer-account-lambda");
    for (const response of [
      { UserConfirmed: false },
      { UserConfirmed: false, CodeDeliveryDetails: { AttributeName: "email", DeliveryMedium: "SMS" } },
      { UserConfirmed: false, CodeDeliveryDetails: { AttributeName: "phone_number", DeliveryMedium: "EMAIL" } },
      { UserConfirmed: true, CodeDeliveryDetails: { AttributeName: "email", DeliveryMedium: "EMAIL" } },
    ]) {
      signupResponse = response;
      const result = await handler(registration);
      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body).error).toBe("provider_unavailable");
    }
  });

  test("admits only a matching pool and an actual email confirmation-code response", async () => {
    mock.send.mockImplementation(async command => {
      if (command.constructor.name === "DescribeUserPoolCommand") return {
        UserPool: { Id: "us-east-2_Test", AutoVerifiedAttributes: ["email"] },
      };
      if (command.constructor.name === "DescribeUserPoolClientCommand") return {
        UserPoolClient: { ClientSecret: "test-only-placeholder" },
      };
      if (command.constructor.name === "SignUpCommand") return {
        UserConfirmed: false, CodeDeliveryDetails: { AttributeName: "email", DeliveryMedium: "EMAIL" },
      };
      return {};
    });
    const { handler } = await import("./aws-consumer-account-lambda");
    const result = await handler(registration);
    expect(result.statusCode).toBe(202);
    expect(JSON.parse(result.body).state).toBe("confirmation_required");
    expect(mock.send.mock.calls.some(([command]) => command.constructor.name === "SignUpCommand")).toBe(true);
  });

  test("does not treat NotAuthorized as successful email confirmation", async () => {
    mock.send.mockImplementation(async command => {
      if (command.constructor.name === "DescribeUserPoolClientCommand") return { UserPoolClient: { ClientSecret: "test-only-placeholder" } };
      throw Object.assign(new Error("private provider detail"), { name: "NotAuthorizedException" });
    });
    const { handler } = await import("./aws-consumer-account-lambda");
    const result = await handler({ routeKey: "POST /clinical-core/public/consumer/registration/confirm", body: JSON.stringify({ email: "synthetic@example.invalid", code: "123456" }) });
    expect(result.statusCode).toBe(400); expect(mock.query).not.toHaveBeenCalled();
    expect(mock.send.mock.calls.some(([command]) => command.constructor.name === "AdminGetUserCommand")).toBe(false);
    expect(result.body).not.toContain("private");
  });
  test("requires enabled, confirmed and verified current Cognito user after confirmation", async () => {
    mock.send.mockImplementation(async command => {
      if (command.constructor.name === "DescribeUserPoolClientCommand") return { UserPoolClient: { ClientSecret: "test-only-placeholder" } };
      if (command.constructor.name === "AdminGetUserCommand") return { UserStatus: "UNCONFIRMED", Enabled: true, UserAttributes: [] };
      return {};
    });
    const { handler } = await import("./aws-consumer-account-lambda");
    const result = await handler({ routeKey: "POST /clinical-core/public/consumer/registration/confirm", body: JSON.stringify({ email: "synthetic@example.invalid", code: "123456" }) });
    expect(result.statusCode).toBe(400); expect(mock.query).not.toHaveBeenCalled();
  });
});
