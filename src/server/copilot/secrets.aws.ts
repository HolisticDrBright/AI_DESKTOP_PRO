/**
 * Phase 10B.1 — production AWS Secrets Manager client.
 *
 * SERVER-ONLY. Implements `SecretsManagerClient` against the Secrets
 * Manager JSON API (`secretsmanager.GetSecretValue`) using SigV4 request
 * signing over the SAME bounded HTTPS transport the provider adapter uses.
 *
 * WHY NO AWS SDK. This repository ships five runtime dependencies and no
 * vendor SDKs — the OpenAI request is likewise hand-built against the
 * published wire contract (`provider.openai.request.ts`). Adding
 * `@aws-sdk/client-secrets-manager` would pull roughly fifty transitive
 * packages into a clinical application to make one signed POST, widening
 * the supply-chain surface far more than the call justifies. The signing
 * below is HMAC-SHA256 over a documented canonical string using Node's
 * built-in `node:crypto` — no novel cryptography, and no overlapping
 * secrets library is introduced. If a future phase adopts the SDK, it
 * implements this same `SecretsManagerClient` interface and nothing above
 * it changes.
 *
 * Discipline enforced here:
 *   - the regional Secrets Manager origin is pinned and allowlisted;
 *   - credentials are read from the server process environment only, and
 *     the ENV NEVER carries the provider secret itself — only the AWS
 *     identity used to fetch it, plus the region and the ARN;
 *   - nothing is logged: no ARN, no payload, no signature, no header;
 *   - AWS error shapes map to PHI-safe `SecretFailureCategory` values.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/secrets.aws is server-only.");
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createHttpsTransport, TransportError, type Transport } from "./http-transport";
import {
  SecretResolutionError,
  SecretResolver,
  type SecretFailureCategory,
  type SecretsManagerClient,
} from "./secrets";

const SERVICE = "secretsmanager";
const AMZ_TARGET = "secretsmanager.GetSecretValue";
const AMZ_JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
};

export type AwsSecretsManagerClientOptions = {
  region: string;
  credentials: AwsCredentials;
  /** Injected in tests. Production builds a pinned bounded HTTPS transport. */
  transport?: Transport;
  /** Injected in tests so the SigV4 date is deterministic. */
  clock?: () => Date;
  timeoutMs?: number;
};

export function secretsManagerOrigin(region: string): string {
  return `https://${SERVICE}.${region}.amazonaws.com`;
}

/**
 * Build a Secrets Manager client. Constructing this does NOT perform any
 * network call — the first call happens on `getSecret`.
 */
export function createAwsSecretsManagerClient(
  options: AwsSecretsManagerClientOptions,
): SecretsManagerClient {
  if (!REGION_PATTERN.test(options.region)) {
    throw new SecretResolutionError("secret_reference_shape_invalid");
  }
  if (!options.credentials?.accessKeyId || !options.credentials?.secretAccessKey) {
    throw new SecretResolutionError("secret_access_denied");
  }
  const origin = secretsManagerOrigin(options.region);
  const endpoint = new URL("/", origin);
  const transport =
    options.transport ??
    createHttpsTransport({
      allowedOrigins: [origin],
      timeoutMs: options.timeoutMs ?? 5_000,
      // A GetSecretValue request is a few hundred bytes and the response is
      // a single key. These ceilings are generous by an order of magnitude.
      maxRequestBytes: 8 * 1024,
      maxResponseBytes: 64 * 1024,
    });
  const clock = options.clock ?? (() => new Date());

  return {
    async getSecret({ arn }) {
      const body = JSON.stringify({ SecretId: arn });
      const headers = signRequest({
        region: options.region,
        credentials: options.credentials,
        host: endpoint.host,
        path: "/",
        body,
        now: clock(),
      });

      let res;
      try {
        res = await transport.send({ endpoint, method: "POST", headers, body });
      } catch (err) {
        throw new SecretResolutionError(mapTransportFailure(err));
      }

      if (res.status < 200 || res.status >= 300) {
        throw new SecretResolutionError(mapAwsHttpFailure(res.status, res.bodyText, res.headers));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.bodyText);
      } catch {
        throw new SecretResolutionError("secret_malformed");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SecretResolutionError("secret_malformed");
      }
      const obj = parsed as Record<string, unknown>;
      const secretString = obj.SecretString;
      if (typeof secretString !== "string") {
        // A binary-only secret is not a bearer token. Refuse rather than
        // guess an encoding.
        throw new SecretResolutionError("secret_malformed");
      }
      const versionId = typeof obj.VersionId === "string" ? obj.VersionId : "unknown";
      return { secretString, versionId };
    },
  };
}

/* ----------------------------------------------------------------- SigV4 */

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * AWS Signature Version 4 for a Secrets Manager JSON POST.
 *
 * Returns the complete header set. The payload hash is taken over the
 * exact `body` string that the transport will send — the transport passes
 * a string body through byte-for-byte, which is what keeps the signature
 * valid.
 */
export function signRequest(input: {
  region: string;
  credentials: AwsCredentials;
  host: string;
  path: string;
  body: string;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const baseHeaders: Record<string, string> = {
    "content-type": AMZ_JSON_CONTENT_TYPE,
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-target": AMZ_TARGET,
  };
  if (input.credentials.sessionToken) {
    baseHeaders["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${baseHeaders[name]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "POST",
    input.path,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...toHeaderCase(baseHeaders),
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * `host` is set by the fetch layer itself and must not be sent explicitly;
 * it is part of the signature but not of the outgoing header list.
 */
function toHeaderCase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === "host") continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------- failure mapping */

function mapTransportFailure(err: unknown): SecretFailureCategory {
  if (err instanceof SecretResolutionError) return err.category;
  if (err instanceof TransportError) {
    switch (err.category) {
      case "transport_timeout":
      case "transport_network":
      case "transport_cancelled":
        return "secret_unavailable";
      case "transport_content_type_invalid":
      case "transport_response_too_large":
      case "transport_request_too_large":
        return "secret_malformed";
      case "transport_origin_refused":
      case "transport_scheme_refused":
      case "transport_redirect_refused":
        return "secret_access_denied";
      default:
        return "secret_unavailable";
    }
  }
  return "secret_unavailable";
}

/**
 * Map an AWS error response to a PHI-safe category.
 *
 * The error TYPE is read from `x-amzn-errortype` or the `__type` field —
 * both are AWS control-plane identifiers, never secret material and never
 * patient data. The error *message* is deliberately never read.
 */
function mapAwsHttpFailure(
  status: number,
  bodyText: string,
  headers: Record<string, string>,
): SecretFailureCategory {
  let errorType = headers["x-amzn-errortype"] ?? "";
  if (!errorType) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const t = parsed.__type ?? parsed.code;
      if (typeof t === "string") errorType = t;
    } catch {
      /* a non-JSON error body tells us nothing; fall through to status */
    }
  }
  // Strip the `com.amazonaws...#` prefix AWS sometimes prepends.
  const shortType = errorType.split("#").pop() ?? "";

  if (/ResourceNotFoundException/i.test(shortType)) return "secret_missing";
  if (/AccessDenied|UnrecognizedClientException|InvalidSignatureException|MissingAuthentication/i.test(shortType)) {
    return "secret_access_denied";
  }
  if (/InvalidRequestException/i.test(shortType)) {
    // Secrets Manager returns InvalidRequestException for a secret that is
    // scheduled for deletion or otherwise no longer retrievable.
    return "secret_expired";
  }
  if (/DecryptionFailure|InvalidParameterException|SerializationException/i.test(shortType)) {
    return "secret_malformed";
  }
  if (/ThrottlingException|InternalServiceError|ServiceUnavailable/i.test(shortType)) {
    return "secret_unavailable";
  }
  if (status === 401 || status === 403) return "secret_access_denied";
  if (status === 404) return "secret_missing";
  if (status === 400) return "secret_malformed";
  return "secret_unavailable";
}

/* ------------------------------------------------- production entry point */

export type ProductionResolverEnv = {
  CLINICAL_COPILOT_AWS_REGION?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
};

/**
 * Build the production resolver from the server environment.
 *
 * Returns `null` when the environment cannot supply an AWS identity. A
 * null resolver makes the adapter refuse — it never degrades to reading a
 * key out of the environment, because an environment variable holding a
 * provider secret is exactly the posture this module exists to remove.
 *
 * IMPORTANT: the caller must have already established that the copilot is
 * NOT in disabled mode. `createProductionSecretResolver` is never reached
 * on the disabled path, which is what makes "no AWS client is constructed
 * in disabled mode" true rather than merely intended. See
 * `provider.openai.ts::resolveProviderRuntime`.
 */
export function createProductionSecretResolver(
  env: ProductionResolverEnv = process.env as ProductionResolverEnv,
  overrides: { transport?: Transport; clock?: () => Date; ttlMs?: number } = {},
): SecretResolver | null {
  const region = env.CLINICAL_COPILOT_AWS_REGION ?? env.AWS_REGION ?? "";
  if (!REGION_PATTERN.test(region)) return null;
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? "";
  if (!accessKeyId || !secretAccessKey) return null;

  const client = createAwsSecretsManagerClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: env.AWS_SESSION_TOKEN ?? null,
    },
    transport: overrides.transport,
    clock: overrides.clock,
  });
  return new SecretResolver({ client, ttlMs: overrides.ttlMs });
}

/**
 * Constant-time comparison helper for any future callers that need to
 * compare secret-adjacent values. Exported so nobody reaches for `===`.
 */
export function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
