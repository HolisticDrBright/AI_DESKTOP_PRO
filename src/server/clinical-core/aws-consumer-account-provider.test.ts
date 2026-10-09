import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ send: vi.fn(), query: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class Command { constructor(public input: unknown) {} }
  return { CognitoIdentityProviderClient: class { send = mock.send; },
    AdminGetUserCommand: class extends Command {}, ConfirmForgotPasswordCommand: class extends Command {},
    ConfirmSignUpCommand: class extends Command {}, DescribeUserPoolClientCommand: class extends Command {},
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
