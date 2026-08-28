if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-consumer-account-lambda is server-only.");
}

import { createHmac } from "node:crypto";
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  DescribeUserPoolClientCommand,
  ForgotPasswordCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ConsumerAccountProviderError,
  createConsumerAccountApiHandler,
  type ConsumerAccountProvider,
  type RegistrationClaims,
} from "./aws-consumer-account";
import { createRdsDataClinicalCoreDatabase } from "./rds-data-database";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("consumer_account_runtime_configuration_missing");
  return value;
}

const poolId = required("CONSUMER_USER_POOL_ID");
const clientId = required("CONSUMER_USER_POOL_CLIENT_ID");
const boundary = required("CONSUMER_ACCOUNT_BOUNDARY") as "synthetic" | "production";
if (!/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(poolId) || !/^[A-Za-z0-9]{20,128}$/.test(clientId)
  || !["synthetic", "production"].includes(boundary)) throw new Error("consumer_account_runtime_configuration_invalid");

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
let clientSecretPromise: Promise<string> | undefined;

async function secretHash(username: string): Promise<string> {
  clientSecretPromise ??= cognito.send(new DescribeUserPoolClientCommand({
    UserPoolId: poolId,
    ClientId: clientId,
  })).then((response) => {
    const secret = response.UserPoolClient?.ClientSecret;
    if (!secret) throw new Error("consumer_account_registration_client_secret_missing");
    return secret;
  });
  const secret = await clientSecretPromise;
  return createHmac("sha256", secret).update(`${username}${clientId}`).digest("base64");
}

const provider: ConsumerAccountProvider = {
  async register(input) {
    try {
      await cognito.send(new SignUpCommand({
        ClientId: clientId,
        Username: input.email,
        SecretHash: await secretHash(input.email),
        Password: input.password,
        UserAttributes: [
          { Name: "email", Value: input.email },
          { Name: "custom:person_id", Value: input.personId },
          { Name: "custom:organization_id", Value: input.organizationId },
          input.boundary === "synthetic"
            ? { Name: "custom:synthetic_attested", Value: "true" }
            : { Name: "custom:production_bound", Value: "true" },
        ],
        ClientMetadata: { registration_contract: "consumer-account-registration/1" },
      }));
    } catch (error) {
      throw providerError(error);
    }
  },
  async confirm(input) {
    try {
      try {
        await cognito.send(new ConfirmSignUpCommand({
          ClientId: clientId,
          Username: input.email,
          SecretHash: await secretHash(input.email),
          ConfirmationCode: input.code,
        }));
      } catch (error) {
        if (errorName(error) !== "NotAuthorizedException") throw error;
      }
      const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: input.email }));
      return claims(user.UserAttributes ?? []);
    } catch (error) {
      throw providerError(error);
    }
  },
  async resendConfirmation(input) {
    try { await cognito.send(new ResendConfirmationCodeCommand({ ClientId: clientId, Username: input.email, SecretHash: await secretHash(input.email) })); }
    catch (error) { throw providerError(error); }
  },
  async requestPasswordReset(input) {
    try { await cognito.send(new ForgotPasswordCommand({ ClientId: clientId, Username: input.email, SecretHash: await secretHash(input.email) })); }
    catch (error) { throw providerError(error); }
  },
  async confirmPasswordReset(input) {
    try {
      await cognito.send(new ConfirmForgotPasswordCommand({
        ClientId: clientId,
        Username: input.email,
        SecretHash: await secretHash(input.email),
        ConfirmationCode: input.code,
        Password: input.password,
      }));
    } catch (error) { throw providerError(error); }
  },
};

function claims(attributes: Array<{ Name?: string; Value?: string }>): RegistrationClaims {
  const values = Object.fromEntries(attributes.map((attribute) => [attribute.Name ?? "", attribute.Value ?? ""]));
  const subject = values.sub ?? "";
  const personId = values["custom:person_id"] ?? "";
  const organizationId = values["custom:organization_id"] ?? "";
  const correctBoundary = boundary === "synthetic"
    ? values["custom:synthetic_attested"] === "true" && values["custom:production_bound"] !== "true"
    : values["custom:production_bound"] === "true" && values["custom:synthetic_attested"] !== "true";
  if (!correctBoundary) throw new ConsumerAccountProviderError("confirmation_invalid");
  return { subject, personId, organizationId };
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? String((error as { name: string }).name) : "";
}

function providerError(error: unknown): ConsumerAccountProviderError {
  const name = errorName(error);
  if (name === "UsernameExistsException") return new ConsumerAccountProviderError("already_exists");
  if (["CodeMismatchException", "ExpiredCodeException", "UserNotFoundException", "NotAuthorizedException"].includes(name)) {
    return new ConsumerAccountProviderError("confirmation_invalid");
  }
  if (name === "InvalidPasswordException") return new ConsumerAccountProviderError("password_invalid");
  return new ConsumerAccountProviderError("provider_unavailable");
}

const database = createRdsDataClinicalCoreDatabase({
  clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
  secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
  databaseName: required("CLINICAL_DATABASE_NAME"),
  region: process.env.AWS_REGION,
});

export const handler = createConsumerAccountApiHandler({
  database,
  provider,
  configuration: {
    boundary,
    termsVersion: required("CONSUMER_TERMS_VERSION"),
    privacyVersion: required("CONSUMER_PRIVACY_VERSION"),
  },
});
