if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-consumer-account is server-only.");
}

import { randomUUID } from "node:crypto";
import { clinicalUuid, type ClinicalCoreDatabase } from "./database";
import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";

export type ConsumerAccountBoundary = "synthetic" | "production";

export type ConsumerAccountConfiguration = {
  boundary: ConsumerAccountBoundary;
  termsVersion: string;
  privacyVersion: string;
};

export type RegistrationClaims = {
  subject: string;
  personId: string;
  organizationId: string;
};

export interface ConsumerAccountProvider {
  register(input: {
    email: string;
    password: string;
    personId: string;
    organizationId: string;
    boundary: ConsumerAccountBoundary;
  }): Promise<void>;
  confirm(input: { email: string; code: string }): Promise<RegistrationClaims>;
  resendConfirmation(input: { email: string }): Promise<void>;
  requestPasswordReset(input: { email: string }): Promise<void>;
  confirmPasswordReset(input: { email: string; code: string; password: string }): Promise<void>;
}

export class ConsumerAccountProviderError extends Error {
  constructor(readonly category:
    | "already_exists"
    | "confirmation_invalid"
    | "password_invalid"
    | "provider_unavailable") {
    super(category);
    this.name = "ConsumerAccountProviderError";
  }
}

class ConsumerAccountRequestError extends Error {
  constructor(readonly category: "request_invalid" | "registration_refused" | "confirmation_invalid" | "provider_unavailable") {
    super(category);
    this.name = "ConsumerAccountRequestError";
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CODE = /^[0-9]{6}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createConsumerAccountApiHandler(input: {
  configuration: ConsumerAccountConfiguration;
  provider: ConsumerAccountProvider;
  database: ClinicalCoreDatabase;
}) {
  assertConfiguration(input.configuration);
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    try {
      const body = parseBody(event.body);
      switch (event.routeKey) {
        case "POST /clinical-core/public/consumer/register": {
          const email = normalizedEmail(body.email);
          const password = validPassword(body.password);
          if (body.acceptsTerms !== true || body.acceptsPrivacy !== true
            || body.termsVersion !== input.configuration.termsVersion
            || body.privacyVersion !== input.configuration.privacyVersion
            || (input.configuration.boundary === "synthetic" && body.attestsSyntheticOnly !== true)) {
            throw new ConsumerAccountRequestError("registration_refused");
          }
          try {
            await input.provider.register({
              email,
              password,
              personId: randomUUID(),
              organizationId: randomUUID(),
              boundary: input.configuration.boundary,
            });
          } catch (error) {
            if (!(error instanceof ConsumerAccountProviderError) || error.category !== "already_exists") throw error;
          }
          return response(202, { state: "confirmation_required" });
        }
        case "POST /clinical-core/public/consumer/registration/confirm": {
          const claims = await input.provider.confirm({ email: normalizedEmail(body.email), code: validCode(body.code) });
          await bootstrap(input.database, claims);
          return response(200, { state: "confirmed" });
        }
        case "POST /clinical-core/public/consumer/registration/resend":
          await suppressEnumeration(() => input.provider.resendConfirmation({ email: normalizedEmail(body.email) }));
          return response(202, { state: "confirmation_if_eligible" });
        case "POST /clinical-core/public/consumer/recovery/request":
          await suppressEnumeration(() => input.provider.requestPasswordReset({ email: normalizedEmail(body.email) }));
          return response(202, { state: "recovery_if_eligible" });
        case "POST /clinical-core/public/consumer/recovery/confirm":
          await input.provider.confirmPasswordReset({
            email: normalizedEmail(body.email),
            code: validCode(body.code),
            password: validPassword(body.password),
          });
          return response(200, { state: "password_updated" });
        default:
          return response(404, { error: "not_found" });
      }
    } catch (error) {
      const category = boundedCategory(error);
      const status = category === "provider_unavailable" ? 503 : 400;
      return response(status, { error: category });
    }
  };
}

async function bootstrap(database: ClinicalCoreDatabase, claims: RegistrationClaims): Promise<void> {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(claims.subject)) throw new ConsumerAccountRequestError("confirmation_invalid");
  try {
    await database.transaction(async (tx) => {
      await tx.query(
        "select * from clinical_private.bootstrap_self_service_consumer($1,$2,$3)",
        [clinicalUuid(claims.personId), clinicalUuid(claims.organizationId), claims.subject],
      );
    });
  } catch {
    throw new ConsumerAccountRequestError("provider_unavailable");
  }
}

async function suppressEnumeration(work: () => Promise<void>): Promise<void> {
  try { await work(); } catch (error) {
    if (error instanceof ConsumerAccountProviderError && error.category !== "provider_unavailable") return;
    throw error;
  }
}

function parseBody(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || raw.length > 8_192) throw new ConsumerAccountRequestError("request_invalid");
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ConsumerAccountRequestError("request_invalid");
  }
}

function normalizedEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) throw new ConsumerAccountRequestError("request_invalid");
  return email;
}

function validCode(value: unknown): string {
  if (typeof value !== "string" || !CODE.test(value)) throw new ConsumerAccountRequestError("request_invalid");
  return value;
}

function validPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128
    || !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)
    || /\s/.test(value)) throw new ConsumerAccountRequestError("request_invalid");
  return value;
}

function assertConfiguration(value: ConsumerAccountConfiguration): void {
  if (!VERSION.test(value.termsVersion) || !VERSION.test(value.privacyVersion)) throw new Error("consumer_account_configuration_invalid");
}

function boundedCategory(error: unknown): ConsumerAccountRequestError["category"] {
  if (error instanceof ConsumerAccountRequestError) return error.category;
  if (error instanceof ConsumerAccountProviderError) {
    if (error.category === "confirmation_invalid" || error.category === "password_invalid") return "confirmation_invalid";
    if (error.category === "provider_unavailable") return "provider_unavailable";
  }
  return "provider_unavailable";
}

function response(statusCode: number, body: Record<string, unknown>): ApiGatewayV2Response {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}
