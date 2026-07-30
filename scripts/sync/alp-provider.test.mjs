/**
 * The real ALP adapter: exact wire projection, signatures the receiver can
 * verify, evidence mapping, and a failure taxonomy that never retries what
 * must not be retried. No fixture is reachable from this module.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAlpProvider, ALP_PROVIDER_NAME } from "./alp-provider.mjs";
import { WIRE_ENVELOPE_KEYS } from "./contract.mjs";
import { verifyCallback } from "./hmac.mjs";

const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const ORG = "org-e2e-1";
const CONFIG = {
  baseUrl: "http://alp.local:3997",
  secret: "bridge-secret",
  keyId: "desktop-key-1",
  organizationId: ORG,
};

function claimedEnvelope(overrides = {}) {
  const payload = overrides.payload ?? { title: "Protocol v3", status: "approved" };
  return {
    eventId: "row-1",
    eventUid: "uid-abc",
    contractVersion: "patient-sync/1",
    connectionId: "conn-1",
    idempotencyKey: "conn-1:protocol_version:res-1:3",
    scope: "protocols_supplements",
    resourceType: "protocol_version",
    resourceId: "res-1",
    resourceVersion: "3",
    occurredAt: "2026-07-30T12:00:00.000Z",
    producer: "desktop",
    provenance: { producer: "desktop" },
    payload,
    payloadHash: sha256(JSON.stringify(payload)),
    correlationId: null,
    causationId: null,
    organizationId: ORG,
    attempts: 1,
    leaseExpiresAt: "2026-07-30T12:02:00.000Z",
    ...overrides,
  };
}

const okReceipts = (eventUid) => ({
  ok: true,
  duplicate: false,
  receipts: [{
    providerEventId: `alp-del-${sha256(eventUid).slice(0, 16)}`,
    kind: "delivered", occurredAt: "2026-07-30T12:00:01.000Z", eventUid,
  }],
});

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("configuration is all-or-nothing", () => {
  it("refuses to construct without the complete staging config", () => {
    for (const missing of ["baseUrl", "secret", "keyId", "organizationId"]) {
      const config = { ...CONFIG, [missing]: "" };
      expect(() => createAlpProvider(config)).toThrowError(/SYNC_ALP|organization/i);
    }
  });

  it("is the real provider — not a fixture, no fixture path", () => {
    const provider = createAlpProvider(CONFIG);
    expect(provider.name).toBe(ALP_PROVIDER_NAME);
    expect(provider.fixture).toBe(false);
    expect(provider.health()).toEqual({
      name: ALP_PROVIDER_NAME, fixture: false, contractVersion: "patient-sync/1",
    });
  });
});

describe("wire projection and signing", () => {
  it("POSTs EXACTLY the wire DTO — no worker-internal fields — with a verifiable signature", async () => {
    let captured = null;
    const provider = createAlpProvider({
      ...CONFIG,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init };
        return jsonResponse(200, okReceipts("uid-abc"));
      },
    });
    const result = await provider.deliver(claimedEnvelope());
    expect(result.evidence).toHaveLength(1);
    expect(captured.url).toBe("http://alp.local:3997/patient-sync/v1/envelopes");

    const body = JSON.parse(Buffer.from(captured.init.body).toString("utf8"));
    expect(Object.keys(body).sort()).toEqual([...WIRE_ENVELOPE_KEYS].sort());
    expect(body.eventId).toBeUndefined();
    expect(body.attempts).toBeUndefined();
    expect(body.leaseExpiresAt).toBeUndefined();
    expect(body.organizationId).toBe(ORG);
    expect(body.contractVersion).toBe("patient-sync/1");

    expect(verifyCallback({
      rawBody: Buffer.from(captured.init.body),
      signature: captured.init.headers["x-sync-signature"],
      keyId: captured.init.headers["x-sync-key-id"],
      timestamp: captured.init.headers["x-sync-timestamp"],
      nonce: captured.init.headers["x-sync-nonce"],
      resolveSecret: (k) => (k === CONFIG.keyId ? CONFIG.secret : null),
    })).toBe(true);
  });

  it("uses the claim projection's organizationId when present, the worker's only as the equal fallback", async () => {
    let body = null;
    const provider = createAlpProvider({
      ...CONFIG,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(Buffer.from(init.body).toString("utf8"));
        return jsonResponse(200, okReceipts("uid-abc"));
      },
    });
    const envelope = claimedEnvelope();
    delete envelope.organizationId;
    await provider.deliver(envelope);
    expect(body.organizationId).toBe(ORG);
  });
});

describe("evidence mapping", () => {
  it("maps receiver receipts to evidence verbatim and surfaces duplicates", async () => {
    const provider = createAlpProvider({
      ...CONFIG,
      fetchImpl: async () => jsonResponse(200, { ...okReceipts("uid-abc"), duplicate: true }),
    });
    const result = await provider.deliver(claimedEnvelope());
    expect(result.duplicate).toBe(true);
    expect(result.evidence[0]).toEqual({
      providerEventId: `alp-del-${sha256("uid-abc").slice(0, 16)}`,
      kind: "delivered",
      occurredAt: "2026-07-30T12:00:01.000Z",
    });
  });

  it("refuses malformed receipts and receipt-less success as CONTRACT failures", async () => {
    const cases = [
      { ok: true, duplicate: false, receipts: [] },
      { ok: true, duplicate: false, receipts: [{ providerEventId: "x", kind: "signed", occurredAt: "t", eventUid: "uid-abc" }] },
      { ok: true, duplicate: false, receipts: [{ providerEventId: "x", kind: "delivered", occurredAt: "t", eventUid: "SOMEONE-ELSES" }] },
    ];
    for (const body of cases) {
      const provider = createAlpProvider({ ...CONFIG, fetchImpl: async () => jsonResponse(200, body) });
      await expect(provider.deliver(claimedEnvelope())).rejects.toMatchObject({ errorClass: "contract" });
    }
  });
});

describe("failure taxonomy — never weaker than the receiver's answer", () => {
  const attempt = (status, body, headers) =>
    createAlpProvider({ ...CONFIG, fetchImpl: async () => jsonResponse(status, body, headers) })
      .deliver(claimedEnvelope());

  it("401 invalid signature -> security, never retried", async () => {
    await expect(attempt(401, { error: { code: "invalid_signature" } }))
      .rejects.toMatchObject({ errorClass: "security", code: "invalid_signature" });
  });

  it("403 connection_revoked -> consent class (durably not deliverable)", async () => {
    await expect(attempt(403, { error: { code: "connection_revoked" } }))
      .rejects.toMatchObject({ errorClass: "consent", code: "connection_revoked" });
  });

  it("403 wrong organization -> security", async () => {
    await expect(attempt(403, { error: { code: "wrong_organization" } }))
      .rejects.toMatchObject({ errorClass: "security", code: "wrong_organization" });
  });

  it("422 contract refusal -> contract with the receiver's code", async () => {
    await expect(attempt(422, { error: { code: "unknown_field" } }))
      .rejects.toMatchObject({ errorClass: "contract", code: "unknown_field" });
  });

  it("413 and 415 -> contract", async () => {
    await expect(attempt(413, { error: { code: "payload_too_large" } }))
      .rejects.toMatchObject({ errorClass: "contract" });
    await expect(attempt(415, { error: { code: "unsupported_content_type" } }))
      .rejects.toMatchObject({ errorClass: "contract" });
  });

  it("409 nonce collision -> retryable (fresh nonce next attempt)", async () => {
    await expect(attempt(409, { error: { code: "replay" } }))
      .rejects.toMatchObject({ errorClass: "retryable" });
  });

  it("429 -> retryable honoring Retry-After", async () => {
    await expect(attempt(429, { error: { code: "rate_limited" } }, { "retry-after": "7" }))
      .rejects.toMatchObject({ errorClass: "retryable", retryAfterMs: 7000 });
  });

  it("5xx -> retryable", async () => {
    await expect(attempt(503, { error: { code: "unavailable" } }))
      .rejects.toMatchObject({ errorClass: "retryable" });
  });

  it("network failure -> retryable alp_unreachable", async () => {
    const provider = createAlpProvider({
      ...CONFIG,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    await expect(provider.deliver(claimedEnvelope()))
      .rejects.toMatchObject({ errorClass: "retryable", code: "alp_unreachable" });
  });

  it("timeout aborts the request -> retryable alp_timeout", async () => {
    const provider = createAlpProvider({
      ...CONFIG,
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    });
    await expect(provider.deliver(claimedEnvelope()))
      .rejects.toMatchObject({ errorClass: "retryable", code: "alp_timeout" });
  });

  it("an invalid claimed envelope never reaches the wire", async () => {
    let called = false;
    const provider = createAlpProvider({
      ...CONFIG,
      fetchImpl: async () => { called = true; return jsonResponse(200, okReceipts("uid-abc")); },
    });
    const bad = claimedEnvelope();
    bad.contractVersion = "patient-sync/9";
    await expect(provider.deliver(bad)).rejects.toMatchObject({ errorClass: "contract" });
    expect(called).toBe(false);
  });
});
