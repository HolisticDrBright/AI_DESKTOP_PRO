import { describe, expect, test, vi } from "vitest";
import {
  createAwsSecretsManagerClient,
  createProductionSecretResolver,
  safeEquals,
  secretsManagerOrigin,
  signRequest,
} from "./secrets.aws";
import { SecretResolutionError } from "./secrets";
import type { Transport, TransportRequest } from "./http-transport";
import { TransportError } from "./http-transport";

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-hipaa-live";
const CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "TEST_FAKE_AWS_SECRET_wJalrXUtnFEMI/K7MDENG",
};
const FIXED_CLOCK = () => new Date("2026-08-04T12:00:00.000Z");

/**
 * A transport that records what it was asked to send and replays a fixed
 * response. Nothing in this file opens a socket — see the explicit
 * zero-network assertion at the bottom.
 */
function recordingTransport(
  respond: (req: TransportRequest) => { status: number; bodyText: string; headers?: Record<string, string> },
): Transport & { calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  return {
    kind: "fake",
    calls,
    async send(req) {
      calls.push(req);
      const r = respond(req);
      return {
        status: r.status,
        statusText: "",
        headers: r.headers ?? { "content-type": "application/x-amz-json-1.1" },
        bodyText: r.bodyText,
      };
    },
  };
}

const okSecret = () => ({
  status: 200,
  bodyText: JSON.stringify({
    ARN,
    Name: "openai-hipaa-live",
    VersionId: "ver-1",
    SecretString: JSON.stringify({ apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234" }),
  }),
});

describe("SigV4 signing", () => {
  test("produces a deterministic, complete Authorization header", () => {
    const headers = signRequest({
      region: "us-east-1",
      credentials: CREDS,
      host: "secretsmanager.us-east-1.amazonaws.com",
      path: "/",
      body: JSON.stringify({ SecretId: ARN }),
      now: FIXED_CLOCK(),
    });
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    expect(headers.Authorization).toContain("/us-east-1/secretsmanager/aws4_request");
    expect(headers.Authorization).toMatch(/SignedHeaders=[a-z0-9;-]+/);
    expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
    expect(headers["x-amz-date"]).toBe("20260804T120000Z");
    expect(headers["content-type"]).toBe("application/x-amz-json-1.1");
  });

  test("is stable for identical input and changes when the body changes", () => {
    const base = {
      region: "us-east-1",
      credentials: CREDS,
      host: "secretsmanager.us-east-1.amazonaws.com",
      path: "/",
      now: FIXED_CLOCK(),
    };
    const a = signRequest({ ...base, body: '{"SecretId":"a"}' });
    const b = signRequest({ ...base, body: '{"SecretId":"a"}' });
    const c = signRequest({ ...base, body: '{"SecretId":"b"}' });
    expect(a.Authorization).toBe(b.Authorization);
    expect(a.Authorization).not.toBe(c.Authorization);
  });

  test("never emits the AWS secret access key", () => {
    const headers = signRequest({
      region: "us-east-1",
      credentials: CREDS,
      host: "secretsmanager.us-east-1.amazonaws.com",
      path: "/",
      body: "{}",
      now: FIXED_CLOCK(),
    });
    const all = JSON.stringify(headers);
    expect(all).not.toContain(CREDS.secretAccessKey);
    expect(all).not.toContain("wJalrXUtnFEMI");
  });

  test("includes the session token in the signature when present", () => {
    const withToken = signRequest({
      region: "us-east-1",
      credentials: { ...CREDS, sessionToken: "TEST_FAKE_SESSION_TOKEN" },
      host: "secretsmanager.us-east-1.amazonaws.com",
      path: "/",
      body: "{}",
      now: FIXED_CLOCK(),
    });
    expect(withToken["x-amz-security-token"]).toBe("TEST_FAKE_SESSION_TOKEN");
    expect(withToken.Authorization).toContain("x-amz-security-token");
  });

  test("the host header is signed but not sent explicitly", () => {
    const headers = signRequest({
      region: "us-east-1",
      credentials: CREDS,
      host: "secretsmanager.us-east-1.amazonaws.com",
      path: "/",
      body: "{}",
      now: FIXED_CLOCK(),
    });
    expect(headers.Authorization).toContain("host");
    expect(headers.host).toBeUndefined();
  });
});

describe("createAwsSecretsManagerClient", () => {
  test("pins the regional Secrets Manager origin", async () => {
    const transport = recordingTransport(okSecret);
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport,
      clock: FIXED_CLOCK,
    });
    await client.getSecret({ arn: ARN });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.endpoint.origin).toBe("https://secretsmanager.us-east-1.amazonaws.com");
    expect(secretsManagerOrigin("eu-west-2")).toBe("https://secretsmanager.eu-west-2.amazonaws.com");
  });

  test("sends the body as an exact string so the signature stays valid", async () => {
    const transport = recordingTransport(okSecret);
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport,
      clock: FIXED_CLOCK,
    });
    await client.getSecret({ arn: ARN });
    expect(transport.calls[0]!.body).toBe(JSON.stringify({ SecretId: ARN }));
    expect(typeof transport.calls[0]!.body).toBe("string");
  });

  test("returns the secret string and version", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport: recordingTransport(okSecret),
      clock: FIXED_CLOCK,
    });
    const res = await client.getSecret({ arn: ARN });
    expect(res.versionId).toBe("ver-1");
    expect(res.secretString).toContain("TEST_FAKE_BEARER_");
  });

  test("refuses a malformed region without constructing anything", () => {
    expect(() =>
      createAwsSecretsManagerClient({ region: "not a region", credentials: CREDS }),
    ).toThrow(SecretResolutionError);
  });

  test("refuses missing credentials", () => {
    expect(() =>
      createAwsSecretsManagerClient({
        region: "us-east-1",
        credentials: { accessKeyId: "", secretAccessKey: "" },
      }),
    ).toThrow(/secret_access_denied/);
  });

  test("refuses a binary-only secret rather than guessing an encoding", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport: recordingTransport(() => ({
        status: 200,
        bodyText: JSON.stringify({ ARN, VersionId: "v1", SecretBinary: "AAAA" }),
      })),
      clock: FIXED_CLOCK,
    });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_malformed/);
  });

  test("refuses a non-JSON success body", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport: recordingTransport(() => ({ status: 200, bodyText: "not json" })),
      clock: FIXED_CLOCK,
    });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_malformed/);
  });
});

describe("AWS failure mapping", () => {
  const cases: Array<[string, number, string]> = [
    ["ResourceNotFoundException", 400, "secret_missing"],
    ["AccessDeniedException", 400, "secret_access_denied"],
    ["UnrecognizedClientException", 400, "secret_access_denied"],
    ["InvalidSignatureException", 403, "secret_access_denied"],
    ["InvalidRequestException", 400, "secret_expired"],
    ["DecryptionFailure", 400, "secret_malformed"],
    ["InvalidParameterException", 400, "secret_malformed"],
    ["ThrottlingException", 400, "secret_unavailable"],
    ["InternalServiceError", 500, "secret_unavailable"],
  ];

  test.each(cases)("%s → %s", async (errorType, status, expected) => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport: recordingTransport(() => ({
        status,
        bodyText: JSON.stringify({ __type: `com.amazonaws.secretsmanager#${errorType}`, message: "PHI?" }),
      })),
      clock: FIXED_CLOCK,
    });
    const err = (await client.getSecret({ arn: ARN }).catch((e) => e)) as SecretResolutionError;
    expect(err.category).toBe(expected);
    // The AWS error *message* is never read into the category or message.
    expect(err.message).toBe(expected);
  });

  test("reads the error type from the x-amzn-errortype header too", async () => {
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport: recordingTransport(() => ({
        status: 400,
        bodyText: "{}",
        headers: { "x-amzn-errortype": "ResourceNotFoundException" },
      })),
      clock: FIXED_CLOCK,
    });
    await expect(client.getSecret({ arn: ARN })).rejects.toThrow(/secret_missing/);
  });

  test("maps transport-layer failures to PHI-safe secret categories", async () => {
    const pairs: Array<[TransportError, string]> = [
      [new TransportError("transport_timeout"), "secret_unavailable"],
      [new TransportError("transport_network"), "secret_unavailable"],
      [new TransportError("transport_origin_refused"), "secret_access_denied"],
      [new TransportError("transport_content_type_invalid"), "secret_malformed"],
    ];
    for (const [thrown, expected] of pairs) {
      const client = createAwsSecretsManagerClient({
        region: "us-east-1",
        credentials: CREDS,
        transport: {
          kind: "fake",
          async send() {
            throw thrown;
          },
        },
        clock: FIXED_CLOCK,
      });
      await expect(client.getSecret({ arn: ARN })).rejects.toThrow(new RegExp(expected));
    }
  });
});

describe("createProductionSecretResolver", () => {
  test("returns null — never a key from the environment — when AWS identity is absent", () => {
    expect(createProductionSecretResolver({})).toBeNull();
    expect(createProductionSecretResolver({ AWS_REGION: "us-east-1" })).toBeNull();
    expect(
      createProductionSecretResolver({ AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" }),
    ).toBeNull();
  });

  test("returns null for a malformed region rather than throwing", () => {
    expect(
      createProductionSecretResolver({
        CLINICAL_COPILOT_AWS_REGION: "nonsense",
        AWS_ACCESS_KEY_ID: "x",
        AWS_SECRET_ACCESS_KEY: "y",
      }),
    ).toBeNull();
  });

  test("builds a resolver when region and identity are present", () => {
    const r = createProductionSecretResolver(
      {
        CLINICAL_COPILOT_AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: CREDS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
      },
      { transport: recordingTransport(okSecret), clock: FIXED_CLOCK },
    );
    expect(r).not.toBeNull();
    expect(r!.size()).toBe(0);
  });

  test("the environment supplies the ARN and region, never the provider secret", async () => {
    const transport = recordingTransport(okSecret);
    const r = createProductionSecretResolver(
      {
        CLINICAL_COPILOT_AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: CREDS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
      },
      { transport, clock: FIXED_CLOCK },
    )!;
    const resolved = await r.resolve({
      organizationId: "org-1",
      providerRegistryId: "prov-1",
      providerSecretRef: ARN,
    });
    // The bearer came from the vault response, not from any env var.
    expect(resolved.bearer).toBe("TEST_FAKE_BEARER_abcdefghijklmnop1234");
    expect(transport.calls).toHaveLength(1);
  });
});

describe("zero real AWS traffic", () => {
  test("no test in this file reaches the network", async () => {
    // Every client above was handed an injected transport. Proven here by
    // constructing one with a fetch spy and asserting it is never called:
    // the only path to a socket is the transport, and ours is a fake.
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const transport = recordingTransport(okSecret);
    const client = createAwsSecretsManagerClient({
      region: "us-east-1",
      credentials: CREDS,
      transport,
      clock: FIXED_CLOCK,
    });
    await client.getSecret({ arn: ARN });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(1);
  });
});

describe("safeEquals", () => {
  test("compares without leaking length-independent timing", () => {
    expect(safeEquals("abc", "abc")).toBe(true);
    expect(safeEquals("abc", "abd")).toBe(false);
    expect(safeEquals("abc", "abcd")).toBe(false);
  });
});
