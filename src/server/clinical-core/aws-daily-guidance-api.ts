if (typeof window !== "undefined") throw new Error("aws-daily-guidance-api is server-only");

import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";
import { DailyGuidanceError, validateDailyGuidanceInput, type DailyGuidanceInput, type DailyGuidanceResult } from "./aws-daily-guidance";
import { generateDailyGuidanceWithOpenAI } from "./aws-daily-guidance-openai";

const ROUTE = "POST /clinical-core/consumer/daily-guidance";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const MAX_BODY_BYTES = 32_768;

export type DailyGuidanceApiConfiguration = {
  consumerIssuer: string;
  consumerAudience: string;
  runtimeMode: "synthetic" | "production";
  phiAllowed: boolean;
  model: string;
  openAiSecretArn: string;
};

export type DailyGuidanceProvider = (request: DailyGuidanceInput) => Promise<DailyGuidanceResult>;

export function createAwsDailyGuidanceApiHandler(input: { configuration: DailyGuidanceApiConfiguration; provider?: DailyGuidanceProvider }) {
  validateConfiguration(input.configuration);
  const provider = input.provider ?? ((request) => generateDailyGuidanceWithOpenAI({
    request, model: input.configuration.model, secretArn: input.configuration.openAiSecretArn,
  }));
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (event.routeKey !== ROUTE) return response(404, { error: "route_not_found" });
    if (input.configuration.runtimeMode === "production" && !input.configuration.phiAllowed) {
      return response(503, { error: "production_not_activated", phiAllowed: false });
    }
    try {
      assertIdentity(event, input.configuration);
      const request = validateDailyGuidanceInput(parseBody(event));
      return response(200, { data: await provider(request) });
    } catch (error) {
      if (error instanceof DailyGuidanceError) {
        const status = error.category === "insufficient_measured_data" ? 422
          : error.category === "reproductive_consent_required" ? 409
            : error.category === "provider_unavailable" ? 503
              : error.category === "unsafe_output_refused" ? 502 : 400;
        return response(status, { error: error.category });
      }
      if (error instanceof DailyGuidanceApiError) return response(403, { error: "identity_refused" });
      return response(503, { error: "service_unavailable" });
    }
  };
}

function assertIdentity(event: ApiGatewayV2Event, config: DailyGuidanceApiConfiguration) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const claim = (name: string) => typeof claims?.[name] === "string" ? claims[name] as string : "";
  const synthetic = config.runtimeMode === "synthetic";
  if (claim("iss") !== config.consumerIssuer || claim("aud") !== config.consumerAudience || claim("token_use") !== "id"
    || !UUID.test(claim("custom:person_id")) || !UUID.test(claim("custom:organization_id")) || !SUBJECT.test(claim("sub"))
    || (synthetic ? claim("custom:synthetic_attested") !== "true" || claim("custom:production_bound") === "true"
      : claim("custom:production_bound") !== "true" || claim("custom:synthetic_attested") === "true")) throw new DailyGuidanceApiError();
}

function parseBody(event: ApiGatewayV2Event): unknown {
  const contentType = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  if (!contentType?.toLowerCase().startsWith("application/json") || typeof event.body !== "string") throw new DailyGuidanceError("request_invalid");
  const bytes = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_BODY_BYTES) throw new DailyGuidanceError("request_invalid");
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new DailyGuidanceError("request_invalid"); }
}

function validateConfiguration(config: DailyGuidanceApiConfiguration) {
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(config.consumerIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(config.consumerAudience) || !["synthetic", "production"].includes(config.runtimeMode)
    || (config.runtimeMode === "synthetic" && config.phiAllowed) || config.model.length < 3 || config.model.length > 100
    || !/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(config.openAiSecretArn)) {
    throw new Error("daily_guidance_configuration_invalid");
  }
}

class DailyGuidanceApiError extends Error {}

function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) };
}
