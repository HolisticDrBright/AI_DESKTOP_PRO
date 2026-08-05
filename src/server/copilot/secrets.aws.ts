/**
 * Phase 10B.1 — production AWS Secrets Manager client.
 *
 * SERVER-ONLY. Implements `SecretsVaultClient` against the official
 * modular AWS SDK (`@aws-sdk/client-secrets-manager`) using the standard
 * AWS credential provider chain.
 *
 * WHY THE SDK RATHER THAN HAND-ROLLED SIGV4. An earlier revision signed
 * requests by hand with `node:crypto` to avoid the SDK's transitive
 * dependency footprint. That trade was rejected, correctly: request
 * signing is security-critical code with a long tail of details —
 * credential refresh, session tokens, SSO and IMDS sourcing, clock skew,
 * regional endpoint resolution, retry classification — and none of it is
 * this repository's job to maintain. The SDK is the audited path.
 *
 * WHY THE SDK IS LOADED WITH A DYNAMIC `import()`. There is no static
 * `@aws-sdk` import anywhere in this file, and that is load-bearing three
 * times over:
 *
 *   1. Disabled mode must not merely skip *constructing* an AWS client —
 *      it must not pull the SDK into the process at all. `import()` inside
 *      the send path is what makes that true; `provider.runtime.ts` returns
 *      on the disabled branch long before anything here is called.
 *   2. Nothing under `@aws-sdk` can be reached from a client bundle, since
 *      the only reference is behind a server-only module guard and a lazy
 *      edge. `scripts/check-clinical-bundle.mjs` asserts the outcome.
 *   3. A static import put the SDK's whole module graph in front of every
 *      Vitest worker that transitively imports this file, which is a real
 *      cost paid on every test run for a dependency almost none of them
 *      touch.
 *
 * Credentials come from the DEFAULT PROVIDER CHAIN. This module never
 * reads a credential out of the environment itself, and the environment
 * never carries the provider secret — only the AWS region, and the secret
 * ARN on the governed registry row.
 *
 * Discipline enforced here:
 *   - bounded: explicit connection/request timeouts and a hard attempt cap;
 *   - nothing is logged: no ARN, no payload, no credential, no header;
 *   - AWS error shapes map to PHI-safe `SecretFailureCategory` values, read
 *     from the error's TYPE only — the AWS message is never read;
 *   - the client is constructed lazily and never in disabled mode (see
 *     `provider.runtime.ts`, which returns before calling this module).
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/secrets.aws is server-only.");
}

import {
  SecretResolutionError,
  SecretResolver,
  type SecretFailureCategory,
  type SecretsVaultClient,
} from "./secrets";

const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** Bounded by construction. A vault lookup is small and must be quick. */
const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 2;

/** The shape of a `GetSecretValue` response this module reads. */
export type AwsSecretValueResponse = {
  SecretString?: string;
  SecretBinary?: unknown;
  VersionId?: string;
};

/**
 * The narrow send seam.
 *
 * It takes the REQUEST SHAPE rather than an SDK `Command` instance on
 * purpose: a seam typed against an SDK class would drag the SDK back into
 * this module's static type graph, and every test fake would have to
 * construct one. Production wraps the real client so the command object is
 * built on the far side of the lazy edge.
 */
export type AwsSecretsSend = {
  send(input: { SecretId: string }): Promise<AwsSecretValueResponse>;
};

/**
 * The slice of `@aws-sdk/client-secrets-manager` used here. Structural, so
 * the real module satisfies it and a test double can too.
 */
export type AwsSecretsSdkModule = {
  SecretsManagerClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<AwsSecretValueResponse>;
  };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
};

export type AwsSdkLoader = () => Promise<AwsSecretsSdkModule>;

/**
 * The lazy edge. This is the ONLY reference to the SDK in the repository's
 * first-party source, and it is evaluated on the first successful send —
 * never at import time, never in disabled mode.
 */
const defaultSdkLoader: AwsSdkLoader = () =>
  import("@aws-sdk/client-secrets-manager") as unknown as Promise<AwsSecretsSdkModule>;

export type AwsSecretsManagerOptions = {
  region: string;
  /** Injected in tests. Omitted in production so the SDK is constructed here. */
  client?: AwsSecretsSend;
  /** Injected in tests to exercise the real construction path without the SDK. */
  sdkLoader?: AwsSdkLoader;
};

export function secretsManagerEndpointRegion(region: string): string {
  return region;
}

/**
 * Build the vault client. Constructing this loads NO module, performs NO
 * network call, and resolves NO credential — the SDK import, the client
 * construction, and the provider chain all run on the first `getSecret`.
 */
export function createAwsSecretsManagerClient(
  options: AwsSecretsManagerOptions,
): SecretsVaultClient {
  if (!REGION_PATTERN.test(options.region)) {
    throw new SecretResolutionError("secret_reference_shape_invalid");
  }

  // Memoised across calls, so the SDK is imported and the client built at
  // most once per vault client. A failed load is NOT memoised — a transient
  // module-resolution failure should not permanently poison the resolver.
  let pending: Promise<AwsSecretsSend> | null = null;
  const getSend = (): Promise<AwsSecretsSend> => {
    if (options.client) return Promise.resolve(options.client);
    if (!pending) {
      pending = buildSdkSend(options).catch((err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };

  return {
    async getSecret({ arn }) {
      let out: AwsSecretValueResponse;
      try {
        out = await (await getSend()).send({ SecretId: arn });
      } catch (err) {
        throw new SecretResolutionError(mapAwsFailure(err));
      }
      if (typeof out?.SecretString !== "string") {
        // A binary-only secret is not a bearer token. Refuse rather than
        // guess an encoding.
        throw new SecretResolutionError("secret_malformed");
      }
      return {
        secretString: out.SecretString,
        versionId: typeof out.VersionId === "string" ? out.VersionId : "unknown",
      };
    },
  };
}

/**
 * Cross the lazy edge: import the SDK, construct a bounded client, and
 * return it wrapped in the narrow send seam.
 *
 * `credentials` is intentionally absent from the config. Passing anything
 * there would replace the default provider chain, which is what supplies
 * SSO, IMDS, ECS task-role, and web-identity credentials in a real
 * deployment.
 */
async function buildSdkSend(options: AwsSecretsManagerOptions): Promise<AwsSecretsSend> {
  const load = options.sdkLoader ?? defaultSdkLoader;
  const { SecretsManagerClient, GetSecretValueCommand } = await load();
  const client = new SecretsManagerClient({
    region: options.region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
  });
  return {
    send: (input) => client.send(new GetSecretValueCommand(input)),
  };
}

/**
 * Map an SDK error to a PHI-safe category.
 *
 * Only the error TYPE and the HTTP status are read. Both are AWS
 * control-plane identifiers; the error MESSAGE is deliberately never read,
 * because a misconfigured secret name can appear in it.
 */
function mapAwsFailure(err: unknown): SecretFailureCategory {
  if (err instanceof SecretResolutionError) return err.category;

  const name = String((err as { name?: unknown })?.name ?? "");
  const status = Number(
    (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0,
  );

  if (/^ResourceNotFoundException$/.test(name)) return "secret_missing";
  if (/AccessDenied|UnrecognizedClientException|InvalidSignatureException|CredentialsProviderError|NotAuthorized/i.test(name)) {
    return "secret_access_denied";
  }
  if (/^InvalidRequestException$/.test(name)) {
    // Returned for a secret scheduled for deletion or otherwise no longer
    // retrievable.
    return "secret_expired";
  }
  if (/DecryptionFailure|InvalidParameterException|SerializationException/i.test(name)) {
    return "secret_malformed";
  }
  if (/ThrottlingException|InternalServiceError|ServiceUnavailable|TimeoutError|NetworkingError|AbortError/i.test(name)) {
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
};

/**
 * Build the production resolver from the server environment.
 *
 * Returns `null` when no AWS region is configured. A null resolver makes
 * the adapter refuse; it never degrades to reading a provider key out of
 * the environment, because an environment variable holding a provider
 * secret is exactly the posture this module exists to remove.
 *
 * Credentials are NOT checked here — the standard provider chain resolves
 * them on first use, and a chain that cannot produce one surfaces as
 * `secret_access_denied`. Checking for `AWS_ACCESS_KEY_ID` would have
 * quietly excluded every credential source that is not a static env key
 * (SSO, IMDS, ECS task role, web identity), which are the sources a real
 * deployment should prefer.
 *
 * IMPORTANT: the caller must have already established that the copilot is
 * NOT disabled. This function is never reached on the disabled path, which
 * is what makes "no AWS module is even loaded in disabled mode" true rather
 * than merely intended. See `provider.runtime.ts`.
 */
export function createProductionSecretResolver(
  env: ProductionResolverEnv = process.env as ProductionResolverEnv,
  overrides: { client?: AwsSecretsSend; sdkLoader?: AwsSdkLoader; ttlMs?: number } = {},
): SecretResolver | null {
  const region = env.CLINICAL_COPILOT_AWS_REGION ?? env.AWS_REGION ?? "";
  if (!REGION_PATTERN.test(region)) return null;

  const client = createAwsSecretsManagerClient({
    region,
    client: overrides.client,
    sdkLoader: overrides.sdkLoader,
  });
  return new SecretResolver({ client, ttlMs: overrides.ttlMs });
}
