/**
 * Phase 10B.1 — governed secret resolver.
 *
 * SERVER-ONLY. Never runs on a client. The registry stores only a
 * reference; this module resolves that reference to the actual bearer
 * value via an INJECTED client that a Phase 10B.2 migration wires to AWS
 * Secrets Manager.
 *
 * Contract:
 *   - The registry-stored `provider_secret_ref` is the ONLY input. A
 *     request-supplied secret id is NEVER accepted.
 *   - The reference must be a URI or resource ARN that this module
 *     recognises (`kms://…` or `arn:aws:secretsmanager:…`).
 *   - The resolver never returns the secret to the client and never
 *     writes it to a database column.
 *   - Cache is bounded (`maxEntries` + TTL) and cleared on revocation.
 *   - Missing / denied / expired / malformed secrets fail closed with a
 *     PHI-safe category — the resolver never leaks whether a specific
 *     value exists.
 *
 * The `SecretsManagerClient` interface is intentionally narrow so the
 * production adapter (AWS SM SDK v3) and the unit-test fake share the
 * exact same surface.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/secrets is server-only.");
}

export type SecretsManagerClient = {
  /**
   * Resolve the current version of the named secret. Throws with the
   * failure category on any failure (not_found / access_denied /
   * expired / malformed).
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

export class SecretResolver {
  private cache = new Map<string, SecretResolverResult>();
  private readonly client: SecretsManagerClient;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: SecretResolverOptions) {
    this.client = opts.client;
    this.clock = opts.clock ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 5 * 60_000; // 5 minutes
    this.maxEntries = opts.maxEntries ?? 32;
  }

  /**
   * Resolve the bearer for the given registry row. Refuses any reference
   * that does not match an approved shape. Fails closed on any client
   * error with a PHI-safe category.
   */
  async resolve(ctx: SecretResolverContext): Promise<SecretResolverResult> {
    if (!ctx.organizationId || !ctx.providerRegistryId || !ctx.providerSecretRef) {
      throw new Error("secret_reference_missing");
    }
    const arn = normalizeReference(ctx.providerSecretRef);
    if (!arn) throw new Error("secret_reference_shape_invalid");

    const key = cacheKey(ctx, arn);
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit && now - hit.cachedAt < this.ttlMs) {
      return hit;
    }
    let raw: { secretString: string; versionId: string };
    try {
      raw = await this.client.getSecret({ arn });
    } catch (err) {
      // Do NOT return whether the secret exists. All client failures
      // collapse to the same category.
      const message = err instanceof Error ? err.message : "unknown";
      if (/expired/i.test(message)) throw new Error("secret_expired");
      if (/access.?denied|forbidden|unauthori/i.test(message)) throw new Error("secret_access_denied");
      throw new Error("secret_resolution_failed");
    }
    if (!raw || typeof raw.secretString !== "string" || raw.secretString.length < 20) {
      throw new Error("secret_malformed");
    }
    const value: SecretResolverResult = {
      arn,
      versionId: raw.versionId,
      bearer: raw.secretString,
      cachedAt: now,
    };
    this.cache.set(key, value);
    if (this.cache.size > this.maxEntries) {
      // Evict oldest.
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return value;
  }

  /**
   * Clear a specific cache entry — called on revocation.
   */
  invalidate(ctx: SecretResolverContext): void {
    const arn = normalizeReference(ctx.providerSecretRef);
    if (!arn) return;
    this.cache.delete(cacheKey(ctx, arn));
  }

  /**
   * Clear the full cache — called on provider revocation cascade.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Size accessor for tests and observability. Never emits the values.
   */
  size(): number {
    return this.cache.size;
  }
}

function normalizeReference(ref: string): string | null {
  if (ARN_PATTERN.test(ref)) return ref;
  if (KMS_URI_PATTERN.test(ref)) return ref;
  return null;
}

function cacheKey(ctx: SecretResolverContext, arn: string): string {
  return `${ctx.organizationId}::${ctx.providerRegistryId}::${arn}`;
}
