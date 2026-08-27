/**
 * PHI-safe runtime posture diagnostic.
 *
 * Reports only a bounded AWS API Gateway identifier/host, edition, live-mode
 * flag, and transport class. It never returns tokens, cookies, request data,
 * keys, patient identifiers, or catalog payloads.
 */
if (typeof window !== "undefined") {
  throw new Error("server/runtime/posture is server-only.");
}

import { evaluateContractFixtureBoundary } from "./contractFixture";

export type RuntimePosture = {
  clinical_api_id: string | null;
  clinical_api_host: string | null;
  app_edition: string | null;
  live_mode: boolean;
  node_env: string | null;
  transport: "aws_api_gateway" | "fixture" | "unknown";
};

function inspectAwsOrigin(raw: string | undefined): { host: string | null; apiId: string | null } {
  if (!raw) return { host: null, apiId: null };
  try {
    const url = new URL(raw);
    const match = url.hostname.match(/^([a-z0-9]{10})\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/);
    if (url.protocol !== "https:" || url.pathname !== "/" || !match) {
      return { host: null, apiId: null };
    }
    return { host: url.hostname, apiId: match[1] };
  } catch {
    return { host: null, apiId: null };
  }
}

export function describeRuntimePosture(): RuntimePosture {
  const fixture = evaluateContractFixtureBoundary();
  const aws = inspectAwsOrigin(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN);
  const transport: RuntimePosture["transport"] = fixture.allowed
    ? "fixture"
    : aws.host ? "aws_api_gateway" : "unknown";

  return {
    clinical_api_id: transport === "aws_api_gateway" ? aws.apiId : null,
    clinical_api_host: transport === "aws_api_gateway" ? aws.host : null,
    app_edition: process.env.APP_EDITION ?? null,
    live_mode: process.env.NEXT_PUBLIC_USE_LIVE_API === "true",
    node_env: process.env.NODE_ENV ?? null,
    transport,
  };
}
