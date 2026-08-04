/**
 * Phase 10B.1 — governed secret resolver.
 *
 * SERVER-ONLY. Never runs on a client. The registry stores only a
 * reference; this module resolves that reference to the actual bearer
 * value via an INJECTED client. The production client is
 * `secrets.aws.ts::createAwsSecretsManagerClient`, which talks to AWS
 * Secrets Manager over the same bounded HTTPS transport the provider uses.
 *
 * Contract:
 *   - The registry-stored `provider_secret_ref` is the ONLY input. A
 *     request-supplied secret id is NEVER accepted.
 *   - The reference must be a URI or resource ARN that this module
 *     recognises (`kms://…` or `arn:aws:secretsmanager:…`).
 *   - The resolver never returns the secret to the client, never writes it
 *     to a database column, and never persists it anywhere. The only copy
 *     is the bounded in-memory cache below, which has an explicit TTL.
 *   - Missing / denied / malformed / unavailable / expired secrets fail
 *     closed with distinct PHI-safe categories. The categories describe the
 *     *resolution attempt*, never the secret or the patient.
 *   - Nothing here prints. No `console.*` call exists in this file, and the
 *     error messages ARE the category strings — there is no interpolation
 *     that could carry a payload, a header, or a partial secret.
 *
 * Resolving a secret is NOT evidence of approval. A resolved bearer proves
 * that an operator put a value in a vault; it says nothing about a BAA, an
 * organizational opt-in, or a clinical sign-off. Those live on governed
 * records and are checked separately in `provider.openai.ts`.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/secrets is server-only.");
}

/**
 * PHI-safe secret failure categories. `missing` and `denied` are kept
 * distinct for operators but are deliberately NOT distinguishable to a
 * caller that only sees the run envelope — see `publicSecretCategory`.
 */
export type SecretFailureCategory =
  | "secret_reference_missing"
  | "secret_reference_shape_invalid"
  | "secret_missing"
  | "secret_access_denied"
  | "secret_malformed"
  | "secret_unavailable"
  | "secret_expired";

export class SecretResolutionError extends Error {
  readonly category: SecretFailureCategory;
  constructor(category: SecretFailureCategory) {
    // The message IS the category. No detail is interpolated, because every
    // detail available here is secret-adjacent.
    super(category);
    this.name = "SecretResolutionError";
    this.category = category;
  }
}

/**
 * What a run envelope is allowed to say. Whether a specific secret exists
 * is an information leak, so `missing` and `denied` collapse here even
 * though the server-side category kept them apart.
 */
export function publicSecretCategory(category: SecretFailureCategory): string {
  switch (category) {
    case "secret_expired":
      return "provider_credential_expired";
    case "secret_unavailable":
      return "provider_credential_unavailable";
    default:
      return "provider_credential_unavailable_or_denied";
  }
}

export type SecretsManagerClient = {
  /**
   * Resolve the current version of the named secret. Throws
   * `SecretResolutionError` (or any Error, which is mapped below) on
   * failure.
   */
  getSecret(input: { arn: string }): Promise<{ secretString: string; versionId: string }>;
};

export type SecretResolverContext = {
  organizationId: string;
  providerRegistryId: string;
  providerSecretRef: string;
};

export type SecretResolverResult = {
  arn: string;
  versionId: string;
  bearer: string;
  /** Optional routing headers carried in a JSON secret payload. */
  organizationHeader: string | null;
  projectHeader: string | null;
  cachedAt: number;
};

export type SecretResolverOptions = {
  client: SecretsManagerClient;
  clock?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

const ARN_PATTERN = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_-]+$/;
const KMS_URI_PATTERN = /^kms:\/\/[A-Za-z0-9/._-]{1,256}$/;

/** Minimum plausible bearer length. Shorter is a placeholder, not a key. */
const MIN_BEARER_LENGTH = 20;
/** A vault payload larger than this is not a key; refuse before parsing. */
const MAX_SECRET_PAYLOAD_BYTES = 8 * 1024;

/** The only fields a JSON secret payload may carry. */
const ALLOWED_PAYLOAD_KEYS = new Set(["apiKey", "organization", "project"]);

export class SecretResolver {
  private cache = new Map<string, SecretResolverResult>();
  private readonly client: SecretsManagerClient;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: SecretResolverOptions) {
    this.client = opts.client;
    this.clock = opts.clock ?? (() => Date.now());
    // Deliberately short. A revoked key must stop working in minutes, not
    // at the next deploy.
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxEntries = opts.maxEntries ?? 32;
  }

  /**
   * Resolve the bearer for the given registry row. Refuses any reference
   * that does not match an approved shape. Fails closed on any client
   * error with a PHI-safe category.
   */
  async resolve(ctx: SecretResolverContext): Promise<SecretResolverResult> {
    if (!ctx.organizationId || !ctx.providerRegistryId || !ctx.providerSecretRef) {
      throw new SecretResolutionError("secret_reference_missing");
    }
    const arn = normalizeReference(ctx.providerSecretRef);
    if (!arn) throw new SecretResolutionError("secret_reference_shape_invalid");

    const key = cacheKey(ctx, arn);
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit && now - hit.cachedAt < this.ttlMs) {
      return hit;
    }
    // A stale entry is dropped before the refetch, so a failed refresh can
    // never fall back to an expired bearer.
    if (hit) this.cache.delete(key);

    let raw: { secretString: string; versionId: string };
    try {
      raw = await this.client.getSecret({ arn });
    } catch (err) {
      throw new SecretResolutionError(mapClientFailure(err));
    }
    if (!raw || typeof raw.secretString !== "string") {
      throw new SecretResolutionError("secret_malformed");
    }
    if (Buffer.byteLength(raw.secretString, "utf8") > MAX_SECRET_PAYLOAD_BYTES) {
      throw new SecretResolutionError("secret_malformed");
    }
    const payload = parseSecretPayload(raw.secretString);
    const value: SecretResolverResult = {
      arn,
      versionId: typeof raw.versionId === "string" ? raw.versionId : "unknown",
      bearer: payload.apiKey,
      organizationHeader: payload.organization,
      projectHeader: payload.project,
      cachedAt: now,
    };
    this.cache.set(key, value);
    if (this.cache.size > this.maxEntries) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return value;
  }

  /** Clear a specific cache entry — called on revocation. */
  invalidate(ctx: SecretResolverContext): void {
    const arn = normalizeReference(ctx.providerSecretRef);
    if (!arn) return;
    this.cache.delete(cacheKey(ctx, arn));
  }

  /** Clear the full cache — called on provider revocation cascade. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Size accessor for tests and observability. Never emits the values. */
  size(): number {
    return this.cache.size;
  }
}

/**
 * Accept either an opaque bearer string or a strict JSON envelope.
 *
 * If the payload looks like JSON it MUST be well-formed and carry only
 * `apiKey` / `organization` / `project`. An unexpected field is refused
 * rather than ignored: a payload that grew a field nobody here understands
 * is a payload this code is no longer the right reader for.
 */
function parseSecretPayload(secretString: string): {
  apiKey: string;
  organization: string | null;
  project: string | null;
} {
  const trimmed = secretString.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new SecretResolutionError("secret_malformed");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SecretResolutionError("secret_malformed");
    }
    const obj = parsed as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!ALLOWED_PAYLOAD_KEYS.has(k)) throw new SecretResolutionError("secret_malformed");
    }
    const apiKey = obj.apiKey;
    if (typeof apiKey !== "string" || apiKey.length < MIN_BEARER_LENGTH) {
      throw new SecretResolutionError("secret_malformed");
    }
    const organization = obj.organization;
    const project = obj.project;
    if (organization !== undefined && typeof organization !== "string") {
      throw new SecretResolutionError("secret_malformed");
    }
    if (project !== undefined && typeof project !== "string") {
      throw new SecretResolutionError("secret_malformed");
    }
    return {
      apiKey,
      organization: typeof organization === "string" ? organization : null,
      project: typeof project === "string" ? project : null,
    };
  }
  if (trimmed.length < MIN_BEARER_LENGTH) {
    throw new SecretResolutionError("secret_malformed");
  }
  return { apiKey: trimmed, organization: null, project: null };
}

/**
 * Map a client-layer failure to a PHI-safe category.
 *
 * The client is expected to throw `SecretResolutionError` already; the
 * string matching below is the fallback for a client that does not (the
 * unit-test fakes, and any future SDK-backed client whose errors are
 * name-tagged rather than typed).
 */
function mapClientFailure(err: unknown): SecretFailureCategory {
  if (err instanceof SecretResolutionError) return err.category;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
  if (/expired|MarkedForDeletion|ScheduledForDeletion/i.test(message)) return "secret_expired";
  if (/access.?denied|forbidden|unauthori|UnrecognizedClient|InvalidSignature/i.test(message)) {
    return "secret_access_denied";
  }
  if (/ResourceNotFound|NotFound/i.test(message)) return "secret_missing";
  if (/Decryption|InvalidParameter|Malformed|SerializationException/i.test(message)) {
    return "secret_malformed";
  }
  if (/Throttl|InternalService|ServiceUnavailable|timeout|network|transport_/i.test(message)) {
    return "secret_unavailable";
  }
  return "secret_unavailable";
}

function normalizeReference(ref: string): string | null {
  if (ARN_PATTERN.test(ref)) return ref;
  if (KMS_URI_PATTERN.test(ref)) return ref;
  return null;
}

function cacheKey(ctx: SecretResolverContext, arn: string): string {
  return `${ctx.organizationId}::${ctx.providerRegistryId}::${arn}`;
}
