import { describe, expect, test } from "vitest";
import { SecretResolver, type SecretsManagerClient } from "./secrets";

function makeClient(map: Record<string, { secretString: string; versionId: string }>): SecretsManagerClient {
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
    const client: SecretsManagerClient = {
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
    const client: SecretsManagerClient = {
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

  test("collapses unknown client failures to secret_resolution_failed", async () => {
    const client: SecretsManagerClient = {
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
    ).rejects.toThrow(/secret_resolution_failed/);
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
    const client: SecretsManagerClient = {
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
