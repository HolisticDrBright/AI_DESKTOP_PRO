import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";

const MAX_JWKS_BYTES = 64 * 1024;
const JWKS_CACHE_MS = 5 * 60 * 1000;

type AuthorizerEvent = {
  identitySource?: unknown;
  headers?: Record<string, unknown>;
};

type AuthorizerDependencies = {
  fetch: typeof fetch;
  now: () => number;
};

type CachedJwks = {
  expiresAt: number;
  keys: JsonWebKey[];
};

let cachedJwks: CachedJwks | null = null;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("synthetic_authorizer_configuration_missing");
  return value;
}

function decodeSegment(value: string): Record<string, unknown> {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("jwt_invalid");
  return parsed as Record<string, unknown>;
}

function bearerToken(event: AuthorizerEvent): string {
  const first = Array.isArray(event.identitySource) ? event.identitySource[0] : undefined;
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const raw = typeof first === "string" ? first : typeof header === "string" ? header : "";
  const match = raw.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  if (!match) throw new Error("jwt_missing");
  return match[1];
}

async function fetchJwks(issuer: string, dependencies: AuthorizerDependencies): Promise<JsonWebKey[]> {
  const now = dependencies.now();
  if (cachedJwks && cachedJwks.expiresAt > now) return cachedJwks.keys;

  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== "https:" || issuerUrl.search || issuerUrl.hash) throw new Error("issuer_invalid");
  const jwksUrl = new URL(`${issuerUrl.pathname.replace(/\/$/, "")}/.well-known/jwks.json`, issuerUrl.origin);
  const response = await dependencies.fetch(jwksUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  const raw = await response.text();
  if (!response.ok
    || !response.headers.get("content-type")?.toLowerCase().includes("application/json")
    || Buffer.byteLength(raw) > MAX_JWKS_BYTES) throw new Error("jwks_unavailable");
  const parsed = JSON.parse(raw) as { keys?: unknown };
  if (!Array.isArray(parsed.keys)) throw new Error("jwks_invalid");
  const keys = parsed.keys.filter((candidate): candidate is JsonWebKey => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const key = candidate as JsonWebKey;
    return key.kty === "EC" && key.crv === "P-256" && key.use === "sig" && key.alg === "ES256"
      && typeof key.kid === "string" && key.kid.length >= 8;
  });
  if (keys.length < 1 || keys.length > 4) throw new Error("jwks_invalid");
  cachedJwks = { keys, expiresAt: now + JWKS_CACHE_MS };
  return keys;
}

function includesAudience(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

export function resetSyntheticAuthorizerCacheForTests(): void {
  cachedJwks = null;
}

export function createSyntheticSupabaseAuthorizerHandler(
  dependencies: AuthorizerDependencies = { fetch: globalThis.fetch, now: Date.now },
) {
  return async (event: AuthorizerEvent) => {
    try {
      const issuer = required("SYNTHETIC_SUPABASE_ISSUER");
      const audience = required("SYNTHETIC_SUPABASE_AUDIENCE");
      const emailDomain = required("SYNTHETIC_EMAIL_DOMAIN").toLowerCase();
      const organizationId = required("SYNTHETIC_ORGANIZATION_ID");
      const allowedSubjects = new Set(required("SYNTHETIC_ALLOWED_SUBJECTS").split(",").map((value) => value.trim().toLowerCase()));
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/auth\/v1$/.test(issuer)
        || audience !== "authenticated"
        || !/^@[a-z0-9.-]+$/.test(emailDomain)
        || !/^[0-9a-f-]{36}$/i.test(organizationId)
        || allowedSubjects.size < 1 || allowedSubjects.size > 10
        || [...allowedSubjects].some((subject) => !/^[0-9a-f-]{36}$/.test(subject))) throw new Error("synthetic_authorizer_configuration_invalid");

      const token = bearerToken(event);
      const segments = token.split(".");
      const header = decodeSegment(segments[0]);
      const payload = decodeSegment(segments[1]);
      if (header.alg !== "ES256" || header.typ !== "JWT" || typeof header.kid !== "string") throw new Error("jwt_invalid");

      const key = (await fetchJwks(issuer, dependencies)).find((candidate) => candidate.kid === header.kid);
      if (!key) throw new Error("jwt_invalid");
      const verified = verifySignature(
        "sha256",
        Buffer.from(`${segments[0]}.${segments[1]}`),
        { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(segments[2], "base64url"),
      );
      const nowSeconds = Math.floor(dependencies.now() / 1000);
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
      if (!verified
        || payload.iss !== issuer
        || !includesAudience(payload.aud, audience)
        || typeof payload.exp !== "number" || payload.exp <= nowSeconds
        || typeof payload.iat !== "number" || payload.iat > nowSeconds + 60
        || typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub)
        || !allowedSubjects.has(payload.sub.toLowerCase())
        || typeof payload.session_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.session_id)
        || payload.role !== "authenticated"
        || payload.is_anonymous === true
        || !email.endsWith(emailDomain)) throw new Error("synthetic_identity_refused");

      return {
        isAuthorized: true,
        context: {
          sub: payload.sub,
          person_id: payload.sub,
          organization_id: organizationId,
          synthetic_attested: "true",
          identity_source: "supabase_synthetic_testflight",
        },
      };
    } catch {
      return { isAuthorized: false };
    }
  };
}

export const syntheticSupabaseAuthorizer = createSyntheticSupabaseAuthorizerHandler();
