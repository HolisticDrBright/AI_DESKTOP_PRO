if (typeof window !== "undefined") throw new Error("aws-ask-alp-api is server-only");

import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";
import { AskAlpError, validateAskAlpRequest, type AskAlpGenerationRequest, type AskAlpGenerationResult } from "./aws-ask-alp";
import { generateAskAlpWithOpenAI } from "./aws-ask-alp-openai";

const ROUTE = "POST /clinical-core/consumer/ask-alp/generate";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const MAX_BODY_BYTES = 98_304;

export type AskAlpApiConfiguration = {
  consumerIssuer: string; consumerAudience: string; runtimeMode: "synthetic" | "production"; phiAllowed: boolean;
  model: string; openAiSecretArn: string; approvedPromptSha256: string;
};

export type AskAlpProvider = (request: AskAlpGenerationRequest) => Promise<AskAlpGenerationResult>;

export function createAwsAskAlpApiHandler(input: { configuration: AskAlpApiConfiguration; provider?: AskAlpProvider }) {
  validateConfiguration(input.configuration);
  const provider = input.provider ?? ((request) => generateAskAlpWithOpenAI({ request, model: input.configuration.model, secretArn: input.configuration.openAiSecretArn }));
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (event.routeKey !== ROUTE) return response(404, { error: "route_not_found" });
    if (input.configuration.runtimeMode === "production" && !input.configuration.phiAllowed) return response(503, { error: "production_not_activated", phiAllowed: false });
    try {
      assertIdentity(event, input.configuration);
      const request = validateAskAlpRequest(parseBody(event), input.configuration.approvedPromptSha256);
      return response(200, { data: await provider(request) });
    } catch (error) {
      if (error instanceof AskAlpError) {
        const status = error.category === "prompt_not_approved" ? 409 : error.category === "provider_unavailable" ? 503 : error.category === "unsafe_output_refused" ? 502 : 400;
        return response(status, { error: error.category });
      }
      if (error instanceof AskAlpApiIdentityError) return response(403, { error: "identity_refused" });
      return response(503, { error: "service_unavailable" });
    }
  };
}

function assertIdentity(event: ApiGatewayV2Event, config: AskAlpApiConfiguration) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const claim = (name: string) => typeof claims?.[name] === "string" ? claims[name] as string : "";
  const synthetic = config.runtimeMode === "synthetic";
  if (claim("iss") !== config.consumerIssuer || claim("aud") !== config.consumerAudience || claim("token_use") !== "id"
    || !UUID.test(claim("custom:person_id")) || !UUID.test(claim("custom:organization_id")) || !SUBJECT.test(claim("sub"))
    || (synthetic ? claim("custom:synthetic_attested") !== "true" || claim("custom:production_bound") === "true"
      : claim("custom:production_bound") !== "true" || claim("custom:synthetic_attested") === "true")) throw new AskAlpApiIdentityError();
}

function parseBody(event: ApiGatewayV2Event): unknown {
  const contentType = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  if (!contentType?.toLowerCase().startsWith("application/json") || typeof event.body !== "string") throw new AskAlpError("request_invalid");
  const bytes = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_BODY_BYTES) throw new AskAlpError("request_invalid");
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new AskAlpError("request_invalid"); }
}

function validateConfiguration(config: AskAlpApiConfiguration) {
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(config.consumerIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(config.consumerAudience) || !["synthetic", "production"].includes(config.runtimeMode)
    || (config.runtimeMode === "synthetic" && config.phiAllowed) || config.model.length < 3 || config.model.length > 100
    || !/^[0-9a-f]{64}$/.test(config.approvedPromptSha256)
    || !/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(config.openAiSecretArn)) throw new Error("ask_alp_configuration_invalid");
}

class AskAlpApiIdentityError extends Error {}

function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) };
}
