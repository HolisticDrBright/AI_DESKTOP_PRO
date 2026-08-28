if (typeof window !== "undefined") {
  throw new Error("Fullscript credentials and OAuth tokens are server-only.");
}

import { createHmac, timingSafeEqual } from "node:crypto";

export type FullscriptEnvironment = "sandbox_us" | "production_us";

export type FullscriptConfiguration = {
  environment: FullscriptEnvironment;
  apiOrigin: string;
  authorizeUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
};

export type FullscriptToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string[];
  resourceOwner: { id: string; type: "Practitioner" | "Staff" };
};

export class FullscriptUnavailableError extends Error {
  readonly code = "fullscript_unavailable";
  constructor(message = "Fullscript is not configured for this environment.") {
    super(message);
    this.name = "FullscriptUnavailableError";
  }
}

const ENVIRONMENTS: Record<FullscriptEnvironment, { apiOrigin: string; authorizeUrl: string }> = {
  sandbox_us: {
    apiOrigin: "https://api-us-snd.fullscript.io/api",
    authorizeUrl: "https://api-us-snd.fullscript.io/api/oauth/authorize",
  },
  production_us: {
    apiOrigin: "https://api-us.fullscript.io/api",
    authorizeUrl: "https://api-us.fullscript.io/api/oauth/authorize",
  },
};

const OPAQUE = /^[A-Za-z0-9._~-]{16,512}$/;
const CALLBACK_PATH = "/api/live/fullscript/oauth/callback";

export function fullscriptIntegrationReturnUrl(
  requestUrl: string,
  configuredRedirectUri = process.env.FULLSCRIPT_REDIRECT_URI,
): URL {
  const configured = configuredRedirectUri?.trim() ?? "";
  try {
    const callback = new URL(configured);
    if (callback.protocol === "https:"
      && !callback.username
      && !callback.password
      && !callback.hash
      && callback.pathname === CALLBACK_PATH) {
      return new URL("/integrations", callback.origin);
    }
  } catch {
    // A missing or malformed provider configuration falls back to the request
    // origin so local development remains usable. Deployed configuration is
    // validated separately and never reaches this fallback.
  }
  return new URL("/integrations", requestUrl);
}

export function readFullscriptConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): FullscriptConfiguration {
  const environment = env.FULLSCRIPT_ENVIRONMENT === "production_us"
    ? "production_us"
    : env.FULLSCRIPT_ENVIRONMENT === "sandbox_us"
      ? "sandbox_us"
      : null;
  if (!environment) throw new FullscriptUnavailableError();
  if (environment === "production_us"
    && (env.FULLSCRIPT_PRODUCTION_APPROVED !== "true" || env.PHI_ALLOWED !== "true")) {
    throw new FullscriptUnavailableError("Fullscript production use is not approved.");
  }
  const canonical = ENVIRONMENTS[environment];
  const clientId = env.FULLSCRIPT_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.FULLSCRIPT_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.FULLSCRIPT_REDIRECT_URI?.trim() ?? "";
  const stateSecret = env.FULLSCRIPT_OAUTH_STATE_SECRET?.trim() ?? "";
  const configuredAuthorize = env.FULLSCRIPT_OAUTH_AUTHORIZE_URL?.trim();
  if (!OPAQUE.test(clientId) || !OPAQUE.test(clientSecret) || stateSecret.length < 32) {
    throw new FullscriptUnavailableError();
  }
  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { throw new FullscriptUnavailableError(); }
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) {
    throw new FullscriptUnavailableError();
  }
  if (configuredAuthorize && configuredAuthorize !== canonical.authorizeUrl) {
    throw new FullscriptUnavailableError("The Fullscript OAuth URL is not the canonical URL for this environment.");
  }
  return { environment, ...canonical, clientId, clientSecret, redirectUri: redirect.href, stateSecret };
}

export function createFullscriptAuthorization(input: {
  configuration: FullscriptConfiguration;
  actorKey: string;
  organizationId: string;
  nonce: string;
  now?: number;
}): { url: string; state: string } {
  if (!/^[a-f0-9]{64}$/.test(input.actorKey)
    || !/^[0-9a-f-]{36}$/i.test(input.organizationId)
    || !/^[A-Za-z0-9_-]{24,128}$/.test(input.nonce)) throw new FullscriptUnavailableError();
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    actor: input.actorKey,
    org: input.organizationId,
    nonce: input.nonce,
    exp: Math.floor((input.now ?? Date.now()) / 1000) + 600,
  })).toString("base64url");
  const signature = createHmac("sha256", input.configuration.stateSecret).update(payload).digest("base64url");
  const state = `${payload}.${signature}`;
  const url = new URL(input.configuration.authorizeUrl);
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("redirect_uri", input.configuration.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return { url: url.href, state };
}

export function verifyFullscriptState(
  state: string,
  secret: string,
  now = Date.now(),
): { actorKey: string; organizationId: string; nonce: string } {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) throw new FullscriptUnavailableError("OAuth state was refused.");
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { throw new FullscriptUnavailableError("OAuth state was refused."); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new FullscriptUnavailableError("OAuth state was refused.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch {
    throw new FullscriptUnavailableError("OAuth state was refused.");
  }
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || typeof value.actor !== "string" || !/^[a-f0-9]{64}$/.test(value.actor)
    || typeof value.org !== "string" || !/^[0-9a-f-]{36}$/i.test(value.org)
    || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{24,128}$/.test(value.nonce)
    || typeof value.exp !== "number" || value.exp < Math.floor(now / 1000)) {
    throw new FullscriptUnavailableError("OAuth state expired or was malformed.");
  }
  return { actorKey: value.actor, organizationId: value.org, nonce: value.nonce };
}

export async function exchangeFullscriptAuthorizationCode(input: {
  configuration: FullscriptConfiguration;
  code: string;
  fetcher?: typeof fetch;
}): Promise<FullscriptToken> {
  if (!OPAQUE.test(input.code)) throw new FullscriptUnavailableError("OAuth code was refused.");
  return tokenRequest(input.configuration, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.configuration.redirectUri,
  }, input.fetcher);
}

export async function refreshFullscriptToken(input: {
  configuration: FullscriptConfiguration;
  refreshToken: string;
  fetcher?: typeof fetch;
}): Promise<FullscriptToken> {
  if (!OPAQUE.test(input.refreshToken)) throw new FullscriptUnavailableError();
  return tokenRequest(input.configuration, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  }, input.fetcher);
}

export async function revokeFullscriptToken(input: {
  configuration: FullscriptConfiguration;
  token: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (!OPAQUE.test(input.token)) throw new FullscriptUnavailableError();
  const response = await (input.fetcher ?? fetch)(`${input.configuration.apiOrigin}/oauth/revoke`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: input.configuration.clientId,
      client_secret: input.configuration.clientSecret,
      token: input.token,
    }),
  }).catch(() => null);
  if (!response?.ok) throw new FullscriptUnavailableError("Fullscript disconnect failed.");
}

async function tokenRequest(
  configuration: FullscriptConfiguration,
  grant: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<FullscriptToken> {
  const response = await fetcher(`${configuration.apiOrigin}/oauth/token`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      ...grant,
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
    }),
  }).catch(() => null);
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new FullscriptUnavailableError("Fullscript token exchange failed.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 64_000) throw new FullscriptUnavailableError();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new FullscriptUnavailableError(); }
  return parseToken(parsed);
}

function parseToken(value: unknown): FullscriptToken {
  const oauth = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).oauth
    : null;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) throw new FullscriptUnavailableError();
  const row = oauth as Record<string, unknown>;
  const owner = row.resource_owner as Record<string, unknown> | undefined;
  if (typeof row.access_token !== "string" || !OPAQUE.test(row.access_token)
    || typeof row.refresh_token !== "string" || !OPAQUE.test(row.refresh_token)
    || typeof row.expires_in !== "number" || row.expires_in < 60 || row.expires_in > 86_400
    || typeof row.created_at !== "string" || !owner
    || typeof owner.id !== "string" || !/^[A-Za-z0-9-]{16,128}$/.test(owner.id)
    || (owner.type !== "Practitioner" && owner.type !== "Staff")) throw new FullscriptUnavailableError();
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt)) throw new FullscriptUnavailableError();
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: new Date(createdAt + row.expires_in * 1000).toISOString(),
    scope: typeof row.scope === "string" ? row.scope.split(/\s+/).filter(Boolean) : [],
    resourceOwner: { id: owner.id, type: owner.type },
  };
}

export class FullscriptApiClient {
  constructor(
    private readonly configuration: FullscriptConfiguration,
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!OPAQUE.test(accessToken)) throw new FullscriptUnavailableError();
  }

  searchProducts(query: string) {
    if (!query.trim() || query.length > 120) throw new FullscriptUnavailableError();
    return this.request("GET", "/catalog/search/products", undefined, { query: query.trim() });
  }

  retrieveProduct(id: string) {
    return this.request("GET", `/catalog/products/${safeId(id)}`);
  }

  searchLabs(query: string) {
    if (!query.trim() || query.length > 120) throw new FullscriptUnavailableError();
    return this.request("GET", "/labs/search/tests", undefined, { query: query.trim(), "page[size]": "25" });
  }

  retrieveLabTest(id: string) {
    return this.request("GET", `/labs/${safeId(id)}`);
  }

  listLabOrders(patientId?: string) {
    return this.request("GET", "/clinic/labs/orders", undefined, patientId ? { patient_id: safeId(patientId) } : undefined);
  }

  retrieveLabOrder(id: string) {
    return this.request("GET", `/clinic/labs/orders/${safeId(id)}`);
  }

  retrieveNewTreatmentPlanLink() {
    return this.request("GET", "/clinic/dynamic_links/treatment_plans");
  }

  createLabTreatmentPlan(input: {
    fullscriptPatientId: string;
    practitionerId: string;
    labTestId: string;
    idempotencyKey: string;
  }) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) throw new FullscriptUnavailableError();
    return this.request("POST", `/clinic/patients/${safeId(input.fullscriptPatientId)}/treatment_plans`, {
      practitioner_id: safeId(input.practitionerId),
      state: "active",
      send_to_patient: true,
      skip_email_notification: false,
      metadata: { id: input.idempotencyKey },
      labs: [{ lab_test_id: safeId(input.labTestId), quantity: "1", sample_collection: "patient_chooses" }],
    }, undefined, { "idempotency-key": input.idempotencyKey });
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.configuration.apiOrigin}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await this.fetcher(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => null);
    if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new FullscriptUnavailableError("Fullscript request failed.");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2_000_000) throw new FullscriptUnavailableError();
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
      return value as Record<string, unknown>;
    } catch {
      throw new FullscriptUnavailableError();
    }
  }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(value)) throw new FullscriptUnavailableError();
  return encodeURIComponent(value);
}

export function verifyFullscriptWebhook(input: {
  body: string;
  signatureHeader: string;
  webhookSecret: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  const match = /^t=(\d{10}),v1=([a-f0-9]{64})$/i.exec(input.signatureHeader.trim());
  if (!match || input.webhookSecret.length < 24 || Buffer.byteLength(input.body) > 1_000_000) return false;
  const timestamp = Number(match[1]);
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(Math.floor((input.now ?? Date.now()) / 1000) - timestamp) > tolerance) return false;
  const expected = createHmac("sha256", input.webhookSecret)
    .update(`${timestamp}.${input.body}`)
    .digest();
  const actual = Buffer.from(match[2], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
