if (typeof window !== "undefined") throw new Error("aws-ask-alp-private-caller is server-only");

import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { ApiGatewayV2Event } from "./aws-identity-api";

export const ASK_ALP_PRIVATE_ROUTE = "POST /clinical-core/internal/ask-alp/generate";
const TOKEN = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{40,6144}\.[A-Za-z0-9_-]{8,2048}$/;
type Claims = Record<string, string | number | boolean | undefined>;

export type PrivateAskAlpCallerConfiguration = {
  apiId: string;
  accountId: string;
  backendRoleArn: string;
  consumerIssuer: string;
  consumerAudience: string;
};

export class PrivateAskAlpCallerError extends Error {}

function configured(config: PrivateAskAlpCallerConfiguration): { roleName: string; poolId: string } {
  const role = /^arn:aws:iam::(\d{12}):role\/(?:[A-Za-z0-9+=,.@_-]+\/)*([A-Za-z0-9+=,.@_-]+)$/.exec(config.backendRoleArn);
  const issuer = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-]+_[A-Za-z0-9]+)$/.exec(config.consumerIssuer);
  if (!/^[a-z0-9]{10}$/.test(config.apiId) || !/^\d{12}$/.test(config.accountId)
    || !role || role[1] !== config.accountId || !issuer || !/^[A-Za-z0-9]{20,128}$/.test(config.consumerAudience))
    throw new Error("ask_alp_private_caller_configuration_invalid");
  return { roleName: role[2]!, poolId: issuer[2]! };
}

function header(event: ApiGatewayV2Event, name: string): string {
  const matches = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  return matches.length === 1 && typeof matches[0]![1] === "string" ? matches[0]![1]!.trim() : "";
}

/** API Gateway must first enforce AWS_IAM on this exact route. This check
 * independently pins the admitted ECS role; a header is never caller proof. */
export async function verifyPrivateAskAlpCaller(
  event: ApiGatewayV2Event,
  config: PrivateAskAlpCallerConfiguration,
  verifyConsumerToken: (token: string) => Promise<Claims>,
): Promise<{ claims: Claims; consumerAuthorization: string }> {
  const { roleName } = configured(config);
  const iam = event.requestContext?.authorizer?.iam;
  const principal = iam?.userArn ?? "";
  const prefix = `arn:aws:sts::${config.accountId}:assumed-role/${roleName}/`;
  const session = principal.startsWith(prefix) ? principal.slice(prefix.length) : "";
  const token = header(event, "x-alp-consumer-id-token");
  if (event.routeKey !== ASK_ALP_PRIVATE_ROUTE || event.requestContext?.apiId !== config.apiId
    || event.requestContext?.accountId !== config.accountId
    || !/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(session)
    || iam?.accountId !== config.accountId || !TOKEN.test(token)
    || !/^AWS4-HMAC-SHA256\s/.test(header(event, "authorization"))) throw new PrivateAskAlpCallerError();
  let claims: Claims;
  try { claims = await verifyConsumerToken(token); } catch { throw new PrivateAskAlpCallerError(); }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new PrivateAskAlpCallerError();
  return { claims, consumerAuthorization: `Bearer ${token}` };
}

/** Runtime path: verify the Cognito signature and issuer, ID-token use and
 * app client independently of API Gateway's IAM verification. */
export function createProductionAskAlpCallerVerifier(config: PrivateAskAlpCallerConfiguration) {
  const { poolId } = configured(config);
  const verifier = CognitoJwtVerifier.create({ userPoolId: poolId, tokenUse: "id", clientId: config.consumerAudience });
  return (event: ApiGatewayV2Event) => verifyPrivateAskAlpCaller(event, config, async token => {
    const payload = await verifier.verify(token);
    const claims: Claims = {};
    for (const key of ["iss", "aud", "token_use", "sub", "email_verified", "exp", "iat",
      "custom:person_id", "custom:organization_id", "custom:production_bound", "custom:synthetic_attested"] as const) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") claims[key] = value;
    }
    return claims;
  });
}
