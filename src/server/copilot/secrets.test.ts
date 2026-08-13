import { describe, expect, test } from "vitest";
import {
  publicSecretCategory,
  SecretResolutionError,
  SecretResolver,
  type SecretFailureCategory,
  type SecretsVaultClient,
} from "./secrets";

function makeClient(map: Record<string, { secretString: string; versionId: string }>): SecretsVaultClient {
  return {
    async getSecret({ arn }) {
      const hit = map[arn];
      if (!hit) throw new Error("ResourceNotFoundException");
      return hit;
    },
  };
}

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-hipaa-live";

describe("SecretResolver", () => {
  test("resolves an ARN reference", async () => {
    const client = makeClient({ [ARN]: { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" } });
    const r = new SecretResolver({ client, clock: () => 1_000_000 });
    const res = await r.resolve({
      organizationId: "org-1",
      providerRegistryId: "prov-1",
      providerSecretRef: ARN,
    });
    expect(res.bearer).toMatch(/TEST_FAKE_BEARER_/);
    expect(res.versionId).toBe("v1");
  });

  test("refuses request-supplied secret shapes", async () => {
    const client = makeClient({});
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
      }),
    ).rejects.toThrow(/shape_invalid/);
  });

  test("refuses malformed reference", async () => {
    const client = makeClient({});
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: "not-an-arn-or-uri",
      }),
    ).rejects.toThrow(/shape_invalid/);
  });

  test("accepts kms:// URI shape", async () => {
    const kmsRef = "kms://openai/hipaa/prod-1";
    const client = makeClient({ [kmsRef]: { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" } });
    const r = new SecretResolver({ client });
    const res = await r.resolve({
      organizationId: "org-1",
      providerRegistryId: "prov-1",
      providerSecretRef: kmsRef,
    });
    expect(res.bearer).toMatch(/TEST_FAKE_BEARER_/);
  });

  test("fails closed on access denied without leaking existence", async () => {
    const client: SecretsVaultClient = {
      async getSecret() {
        throw new Error("AccessDeniedException: user is not authorized");
      },
    };
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: ARN,
      }),
    ).rejects.toThrow(/secret_access_denied/);
  });

  test("fails closed on expired secret", async () => {
    const client: SecretsVaultClient = {
      async getSecret() {
        throw new Error("SecretExpired");
      },
    };
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: ARN,
      }),
    ).rejects.toThrow(/secret_expired/);
  });

  test("maps a transient backend failure to secret_unavailable", async () => {
    const client: SecretsVaultClient = {
      async getSecret() {
        throw new Error("InternalServiceError");
      },
    };
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: ARN,
      }),
    ).rejects.toThrow(/secret_unavailable/);
  });

  test("maps a not-found secret to secret_missing", async () => {
    const client = makeClient({});
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: ARN,
      }),
    ).rejects.toThrow(/secret_missing/);
  });

  test("the five failure categories are distinct server-side", async () => {
    const cases: Array<[string, SecretFailureCategory]> = [
      ["ResourceNotFoundException", "secret_missing"],
      ["AccessDeniedException", "secret_access_denied"],
      ["DecryptionFailure", "secret_malformed"],
      ["ThrottlingException", "secret_unavailable"],
      ["SecretMarkedForDeletion expired", "secret_expired"],
    ];
    const seen = new Set<SecretFailureCategory>();
    for (const [thrown, expected] of cases) {
      const client: SecretsVaultClient = {
        async getSecret() {
          throw new Error(thrown);
        },
      };
      const r = new SecretResolver({ client });
      const err = await r
        .resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN })
        .catch((e) => e);
      expect(err).toBeInstanceOf(SecretResolutionError);
      expect((err as SecretResolutionError).category).toBe(expected);
      seen.add((err as SecretResolutionError).category);
    }
    expect(seen.size).toBe(5);
  });

  test("existence is not leaked to the caller-visible category", () => {
    // Missing and denied MUST collapse in anything a caller can observe:
    // distinguishing them tells an attacker which ARNs are real.
    expect(publicSecretCategory("secret_missing")).toBe(
      publicSecretCategory("secret_access_denied"),
    );
    // Expired is safe to distinguish — it is about the operator's own key.
    expect(publicSecretCategory("secret_expired")).not.toBe(
      publicSecretCategory("secret_missing"),
    );
  });

  test("accepts a strict JSON payload and carries routing headers", async () => {
    const client = makeClient({
      [ARN]: {
        secretString: JSON.stringify({
          apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
          organization: "org_TEST",
          project: "proj_TEST",
        }),
        versionId: "v9",
      },
    });
    const r = new SecretResolver({ client });
    const res = await r.resolve({
      organizationId: "org-1",
      providerRegistryId: "prov-1",
      providerSecretRef: ARN,
    });
    expect(res.bearer).toBe("TEST_FAKE_BEARER_abcdefghijklmnop1234");
    expect(res.organizationHeader).toBe("org_TEST");
    expect(res.projectHeader).toBe("proj_TEST");
  });

  test("refuses malformed secret JSON", async () => {
    const client = makeClient({ [ARN]: { secretString: '{"apiKey": "TEST_FAKE', versionId: "v1" } });
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN }),
    ).rejects.toThrow(/secret_malformed/);
  });

  test("refuses unexpected fields in a JSON secret payload", async () => {
    // A payload that grew a field this reader does not understand is a
    // payload this reader is no longer the right consumer for.
    const client = makeClient({
      [ARN]: {
        secretString: JSON.stringify({
          apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
          exfiltrate_to: "https://evil.example",
        }),
        versionId: "v1",
      },
    });
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN }),
    ).rejects.toThrow(/secret_malformed/);
  });

  test("refuses an oversized secret payload before parsing it", async () => {
    const client = makeClient({
      [ARN]: { secretString: "x".repeat(9000), versionId: "v1" },
    });
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN }),
    ).rejects.toThrow(/secret_malformed/);
  });

  test("a failed refresh does not fall back to the expired cached bearer", async () => {
    let now = 1_000_000;
    let calls = 0;
    const client: SecretsVaultClient = {
      async getSecret() {
        calls += 1;
        if (calls > 1) throw new Error("AccessDeniedException");
        return { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" };
      },
    };
    const r = new SecretResolver({ client, clock: () => now, ttlMs: 100 });
    const ctx = { organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN };
    await r.resolve(ctx);
    now += 500; // past TTL — the key was revoked in the meantime
    await expect(r.resolve(ctx)).rejects.toThrow(/secret_access_denied/);
    // and the stale entry is gone rather than lingering for the next call
    expect(r.size()).toBe(0);
  });

  test("no secret material appears in any thrown error", async () => {
    const BEARER = "TEST_FAKE_BEARER_supersecretvalue999";
    const client = makeClient({
      [ARN]: { secretString: JSON.stringify({ apiKey: BEARER, nope: 1 }), versionId: "v1" },
    });
    const r = new SecretResolver({ client });
    const err = await r
      .resolve({ organizationId: "o", providerRegistryId: "p", providerSecretRef: ARN })
      .catch((e: Error) => e);
    const serialized = `${(err as Error).message}|${(err as Error).stack ?? ""}`;
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain("supersecret");
  });

  test("refuses malformed short bearer value", async () => {
    const client = makeClient({ [ARN]: { secretString: "shortkey", versionId: "v1" } });
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: ARN,
      }),
    ).rejects.toThrow(/secret_malformed/);
  });

  test("caches within TTL and refreshes past TTL", async () => {
    let now = 1_000_000;
    let calls = 0;
    const client: SecretsVaultClient = {
      async getSecret() {
        calls += 1;
        return { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v" + calls };
      },
    };
    const r = new SecretResolver({ client, clock: () => now, ttlMs: 100 });
    const ctx = { organizationId: "org-1", providerRegistryId: "prov-1", providerSecretRef: ARN };
    await r.resolve(ctx);
    await r.resolve(ctx);
    expect(calls).toBe(1);
    now += 500;
    await r.resolve(ctx);
    expect(calls).toBe(2);
  });

  test("invalidateAll clears the cache", async () => {
    const client = makeClient({ [ARN]: { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" } });
    const r = new SecretResolver({ client });
    await r.resolve({ organizationId: "org-1", providerRegistryId: "prov-1", providerSecretRef: ARN });
    expect(r.size()).toBe(1);
    r.invalidateAll();
    expect(r.size()).toBe(0);
  });

  test("no user-supplied secret identifier can be smuggled in", async () => {
    // The interface takes only the registry-stored reference. Even if a
    // caller lies about the arn, the resolver goes to the AWS SM client
    // for THAT arn — the client controls whether it returns anything. A
    // reference the caller invented that does NOT map to an approved
    // secret always fails.
    const client = makeClient({ [ARN]: { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" } });
    const r = new SecretResolver({ client });
    await expect(
      r.resolve({
        organizationId: "org-1",
        providerRegistryId: "prov-1",
        providerSecretRef: "arn:aws:secretsmanager:us-east-1:999999999999:secret:not-mine",
      }),
    ).rejects.toThrow();
  });
});
