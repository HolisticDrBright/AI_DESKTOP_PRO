import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createAwsSecretsManagerClient,
  createProductionSecretResolver,
  type AwsSdkLoader,
  type AwsSecretsSdkModule,
  type AwsSecretsSend,
} from "./secrets.aws";
import { SecretResolutionError } from "./secrets";

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-hipaa-live";
const BEARER = "TEST_FAKE_BEARER_abcdefghijklmnop1234";

/**
 * A fake standing in for the SDK client. Every test injects one — either
 * this or a fake SDK module — so no credential is ever resolved and no AWS
 * endpoint is ever contacted. See the explicit zero-traffic assertions at
 * the bottom of this file.
 */
function fakeSend(
  impl: (input: { SecretId: string }) => Promise<unknown> | unknown,
): AwsSecretsSend & { calls: Array<{ SecretId: string }> } {
  const calls: Array<{ SecretId: string }> = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      return (await impl(input)) as { SecretString?: string; VersionId?: string };
    },
  };
}

const ok = () => fakeSend(() => ({ SecretString: BEARER, VersionId: "ver-1" }));

/** Shape an SDK-style error: the SDK tags errors by `name` + `$metadata`. */
function awsError(name: string, httpStatusCode = 400): Error {
  const err = new Error("an AWS message that must never be read");
  err.name = name;
  (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  return err;
}

describe("createAwsSecretsManagerClient", () => {
  test("issues a GetSecretValue request for the registry ARN", async () => {
    const send = ok();
    const client = createAwsSecretsManagerClient({ region: "us-east-1", client: send });
    const res = await client.getSecret({ arn: ARN });

    expect(send.calls).toHaveLength(1);
    expect(send.calls[0]!.SecretId).toBe(ARN);
    expect(res.secretString).toBe(BEARER);
    expect(res.versionId).toBe("ver-1");
  });

  test("defaults an absent VersionId rather than inventing one", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: fakeSend(() => ({ SecretString: BEARER })),
    });
    expect((await client.getSecret({ arn: ARN })).versionId).toBe("unknown");
  });

  test("refuses a malformed region without constructing anything", () => {
    expect(() => createAwsSecretsManagerClient({ region: "not a region" })).toThrow(
      SecretResolutionError,
    );
    expect(() => createAwsSecretsManagerClient({ region: "" })).toThrow(/shape_invalid/);
  });

  test("accepts real AWS region shapes, including GovCloud", () => {
    for (const region of ["us-east-1", "eu-west-2", "ap-southeast-1", "us-gov-west-1"]) {
      expect(() => createAwsSecretsManagerClient({ region, client: ok() })).not.toThrow();
    }
  });

  test("refuses a binary-only secret rather than guessing an encoding", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: fakeSend(() => ({ SecretBinary: new Uint8Array([1, 2, 3]), VersionId: "v1" })),
    });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_malformed/);
  });

  test("refuses an empty response", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: fakeSend(() => ({})),
    });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_malformed/);
  });
});

/* ------------------------------------------------------------------ */
/* The lazy edge                                                       */
/* ------------------------------------------------------------------ */

type SdkSpy = {
  loader: AwsSdkLoader;
  loads: number;
  configs: Array<Record<string, unknown>>;
  commands: Array<{ SecretId: string }>;
};

/**
 * A stand-in for `@aws-sdk/client-secrets-manager`.
 *
 * This exercises the REAL production construction path — the one that
 * builds a client and wraps it in a `GetSecretValueCommand` — without the
 * real SDK ever entering this test's module graph.
 */
function fakeSdk(
  impl: (input: { SecretId: string }) => Promise<unknown> | unknown = () => ({
    SecretString: BEARER,
    VersionId: "ver-1",
  }),
): SdkSpy {
  const spy: SdkSpy = { loads: 0, configs: [], commands: [], loader: null as never };

  class GetSecretValueCommand {
    constructor(readonly input: { SecretId: string }) {}
  }
  class SecretsManagerClient {
    constructor(config: Record<string, unknown>) {
      spy.configs.push(config);
    }
    async send(command: unknown) {
      const input = (command as GetSecretValueCommand).input;
      spy.commands.push(input);
      return (await impl(input)) as { SecretString?: string; VersionId?: string };
    }
  }

  spy.loader = async () => {
    spy.loads += 1;
    return { SecretsManagerClient, GetSecretValueCommand } as unknown as AwsSecretsSdkModule;
  };
  return spy;
}

describe("the AWS SDK is loaded lazily, never at import time", () => {
  test("this module has no static @aws-sdk import", () => {
    // A structural assertion, because the property is about the module
    // GRAPH, not about any observable value: a static import would pull the
    // SDK into every process that touches the copilot, including one where
    // the copilot is disabled.
    const source = readFileSync(join(import.meta.dirname, "secrets.aws.ts"), "utf8");
    const staticImports = source.match(/^\s*import\s[^(]*?from\s+["'][^"']+["']/gm) ?? [];
    expect(staticImports.some((line) => line.includes("@aws-sdk"))).toBe(false);
    // …and exactly one dynamic edge exists.
    expect(source.match(/import\(\s*["']@aws-sdk\/client-secrets-manager["']\s*\)/g)).toHaveLength(
      1,
    );
  });

  test("building the vault client loads no SDK module", () => {
    const sdk = fakeSdk();
    createAwsSecretsManagerClient({ region: "us-east-1", sdkLoader: sdk.loader });
    expect(sdk.loads).toBe(0);
    expect(sdk.configs).toHaveLength(0);
  });

  test("building the production resolver loads no SDK module", () => {
    const sdk = fakeSdk();
    const r = createProductionSecretResolver({ AWS_REGION: "us-east-1" }, { sdkLoader: sdk.loader });
    expect(r).not.toBeNull();
    expect(sdk.loads).toBe(0);
  });

  test("the first lookup loads the SDK once and reuses it", async () => {
    const sdk = fakeSdk();
    const client = createAwsSecretsManagerClient({ region: "eu-west-2", sdkLoader: sdk.loader });
    await client.getSecret({ arn: ARN });
    await client.getSecret({ arn: ARN });
    expect(sdk.loads).toBe(1);
    expect(sdk.configs).toHaveLength(1);
    expect(sdk.commands.map((c) => c.SecretId)).toEqual([ARN, ARN]);
  });

  test("the constructed client is bounded and uses the default credential chain", async () => {
    const sdk = fakeSdk();
    const client = createAwsSecretsManagerClient({ region: "us-gov-west-1", sdkLoader: sdk.loader });
    await client.getSecret({ arn: ARN });

    const config = sdk.configs[0]!;
    expect(config.region).toBe("us-gov-west-1");
    expect(config.maxAttempts).toBe(2);
    expect(config.requestHandler).toEqual({ connectionTimeout: 3000, requestTimeout: 5000 });
    // Passing `credentials` would REPLACE the provider chain, excluding
    // SSO, IMDS, ECS task roles, and web identity.
    expect(config).not.toHaveProperty("credentials");
    expect(config).not.toHaveProperty("credentialDefaultProvider");
  });

  test("a failed SDK load fails closed and is not memoised", async () => {
    let attempts = 0;
    const loader: AwsSdkLoader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("module resolution failed");
      return fakeSdk().loader();
    };
    const client = createAwsSecretsManagerClient({ region: "us-east-1", sdkLoader: loader });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_unavailable/);
    // The second call retries the load rather than staying poisoned.
    await expect(client.getSecret({ arn: ARN })).resolves.toMatchObject({ secretString: BEARER });
    expect(attempts).toBe(2);
  });

  test("an injected send seam bypasses the SDK entirely", async () => {
    const sdk = fakeSdk();
    const send = ok();
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: send,
      sdkLoader: sdk.loader,
    });
    await client.getSecret({ arn: ARN });
    expect(sdk.loads).toBe(0);
    expect(send.calls).toHaveLength(1);
  });
});

describe("AWS failure mapping", () => {
  const cases: Array<[string, number, string]> = [
    ["ResourceNotFoundException", 400, "secret_missing"],
    ["AccessDeniedException", 400, "secret_access_denied"],
    ["UnrecognizedClientException", 400, "secret_access_denied"],
    ["InvalidSignatureException", 403, "secret_access_denied"],
    ["CredentialsProviderError", 400, "secret_access_denied"],
    ["InvalidRequestException", 400, "secret_expired"],
    ["DecryptionFailure", 400, "secret_malformed"],
    ["InvalidParameterException", 400, "secret_malformed"],
    ["ThrottlingException", 400, "secret_unavailable"],
    ["InternalServiceError", 500, "secret_unavailable"],
    ["TimeoutError", 0, "secret_unavailable"],
  ];

  test.each(cases)("%s → %s", async (name, status, expected) => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: fakeSend(() => {
        throw awsError(name, status);
      }),
    });
    const err = (await client.getSecret({ arn: ARN }).catch((e) => e)) as SecretResolutionError;
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.category).toBe(expected);
  });

  test("failures raised through the real SDK path map identically", async () => {
    // The mapping must not depend on which seam produced the error.
    const sdk = fakeSdk(() => {
      throw awsError("ResourceNotFoundException", 400);
    });
    const client = createAwsSecretsManagerClient({ region: "us-east-1", sdkLoader: sdk.loader });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_missing/);
  });

  test("the AWS error message is never read into the category or the error", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: fakeSend(() => {
        const err = new Error(`secret ${ARN} for patient MRN-12345 not found`);
        err.name = "ResourceNotFoundException";
        throw err;
      }),
    });
    const err = (await client.getSecret({ arn: ARN }).catch((e) => e)) as SecretResolutionError;
    const serialized = `${err.message}|${err.stack ?? ""}`;
    expect(err.message).toBe("secret_missing");
    expect(serialized).not.toContain("MRN-12345");
    expect(serialized).not.toContain(ARN);
  });

  test("an unrecognised error still fails closed", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      client: fakeSend(() => {
        throw new Error("something nobody anticipated");
      }),
    });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_unavailable/);
  });

  test("HTTP status is the fallback when the error has no recognised name", async () => {
    for (const [status, expected] of [
      [403, "secret_access_denied"],
      [404, "secret_missing"],
      [400, "secret_malformed"],
      [503, "secret_unavailable"],
    ] as Array<[number, string]>) {
      const client = createAwsSecretsManagerClient({
        region: "us-east-1",
        client: fakeSend(() => {
          throw awsError("SomeUnmappedError", status);
        }),
      });
      await expect(client.getSecret({ arn: ARN })).rejects.toThrow(new RegExp(expected));
    }
  });
});

describe("createProductionSecretResolver", () => {
  test("returns null — never a key from the environment — with no region", () => {
    expect(createProductionSecretResolver({})).toBeNull();
    expect(createProductionSecretResolver({ CLINICAL_COPILOT_AWS_REGION: "" })).toBeNull();
  });

  test("returns null for a malformed region rather than throwing", () => {
    expect(createProductionSecretResolver({ CLINICAL_COPILOT_AWS_REGION: "nonsense" })).toBeNull();
  });

  test("prefers the copilot-specific region over the ambient AWS_REGION", async () => {
    const send = ok();
    const r = createProductionSecretResolver(
      { CLINICAL_COPILOT_AWS_REGION: "eu-west-2", AWS_REGION: "us-east-1" },
      { client: send },
    );
    expect(r).not.toBeNull();
    await r!.resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN });
    expect(send.calls).toHaveLength(1);
  });

  test("the region reaches the SDK client config", async () => {
    const sdk = fakeSdk();
    const r = createProductionSecretResolver(
      { CLINICAL_COPILOT_AWS_REGION: "eu-west-2", AWS_REGION: "us-east-1" },
      { sdkLoader: sdk.loader },
    )!;
    await r.resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN });
    expect(sdk.configs[0]!.region).toBe("eu-west-2");
  });

  test("does NOT require static AWS keys — the provider chain supplies them", () => {
    // Requiring AWS_ACCESS_KEY_ID would silently exclude SSO, IMDS, ECS
    // task roles, and web identity — the sources a real deployment should
    // prefer over a static env key.
    const r = createProductionSecretResolver(
      { AWS_REGION: "us-east-1" },
      { client: ok() },
    );
    expect(r).not.toBeNull();
  });

  test("the environment supplies region only, never the provider secret", async () => {
    const send = ok();
    const r = createProductionSecretResolver({ AWS_REGION: "us-east-1" }, { client: send })!;
    const resolved = await r.resolve({
      organizationId: "org-1",
      providerRegistryId: "prov-1",
      providerSecretRef: ARN,
    });
    expect(resolved.bearer).toBe(BEARER);
    expect(send.calls).toHaveLength(1);
  });
});

describe("no AWS traffic and no client construction", () => {
  test("building a resolver performs no send", () => {
    const send = ok();
    createProductionSecretResolver({ AWS_REGION: "us-east-1" }, { client: send });
    expect(send.calls).toHaveLength(0);
  });

  test("building a vault client performs no send", () => {
    const send = ok();
    createAwsSecretsManagerClient({ region: "us-east-1", client: send });
    expect(send.calls).toHaveLength(0);
  });

  test("no test in this file reaches the network", async () => {
    // The only path to a socket is the SDK client's `send`, and every test
    // injects either a fake seam or a fake SDK module. A global fetch spy
    // stays untouched throughout.
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const send = ok();
      const client = createAwsSecretsManagerClient({ region: "us-east-1", client: send });
      await client.getSecret({ arn: ARN });
      const sdk = fakeSdk();
      const viaSdk = createAwsSecretsManagerClient({ region: "us-east-1", sdkLoader: sdk.loader });
      await viaSdk.getSecret({ arn: ARN });
      expect(send.calls).toHaveLength(1);
      expect(sdk.commands).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
