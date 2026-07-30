import { describe, expect, test } from "vitest";
import { validateOutboundEnvelope, sha256Hex, CONTRACT_VERSION } from "./contract.mjs";
import { SyncError, classifyHttpStatus, isRetryable } from "./errors.mjs";
import { backoffMs } from "./backoff.mjs";
import { createCircuit } from "./circuit.mjs";
import { signCallback, verifyCallback } from "./hmac.mjs";
import { sanitizeFields, makeLogger } from "./redact.mjs";
import { assertFixtureAllowed, deployedMarker } from "./deploy-guard.mjs";
import { createFixtureProvider } from "./fixture-provider.mjs";
import { runCycle } from "./worker-core.mjs";
import { createCallbackServer } from "./callback-server.mjs";

/* ------------------------------------------------------------ helpers */

function envelope(overrides = {}) {
  const payload = overrides.payload ?? { appointmentId: "a-1", startsAt: "2026-08-01T10:00:00Z" };
  return {
    eventId: "e-1",
    eventUid: "11111111-1111-4111-8111-111111111111",
    contractVersion: CONTRACT_VERSION,
    connectionId: "c-1",
    idempotencyKey: "c-1:appointment_summary:a-1:1",
    scope: "appointments",
    resourceType: "appointment_summary",
    resourceId: "a-1",
    resourceVersion: "1",
    occurredAt: "2026-07-30T00:00:00Z",
    producer: "desktop",
    provenance: { producer: "desktop" },
    payload,
    payloadHash: sha256Hex(JSON.stringify(payload)),
    attempts: 1,
    correlationId: null,
    ...overrides,
  };
}

function fakeRpc(script = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      const fn = script[name];
      if (typeof fn === "function") return fn(args, calls);
      return fn ?? { ok: true };
    },
  };
}

const silentLogger = { log: () => {} };

/* ------------------------------------------------------- contract DTO */

describe("patient-sync/1 envelope validation fails closed", () => {
  test("accepts a valid envelope", () => {
    expect(validateOutboundEnvelope(envelope())).toBeTruthy();
  });
  test("unknown fields are refused", () => {
    expect(() => validateOutboundEnvelope({ ...envelope(), surprise: 1 })).toThrowError(/unknown envelope field/);
  });
  test("wrong contract version is refused", () => {
    expect(() => validateOutboundEnvelope(envelope({ contractVersion: "patient-sync/2" })))
      .toThrowError(/unsupported contract version/);
  });
  test("malformed hash is refused", () => {
    expect(() => validateOutboundEnvelope(envelope({ payloadHash: "nope" })))
      .toThrowError(/sha256/);
  });
  test("oversized payload is refused", () => {
    const big = envelope({ payload: { blob: "x".repeat(70000) } });
    big.payloadHash = sha256Hex(JSON.stringify(big.payload));
    expect(() => validateOutboundEnvelope(big)).toThrowError(/size limit/);
  });
});

/* ---------------------------------------------------- error taxonomy */

describe("error classification", () => {
  test("429 is retryable with Retry-After", () => {
    const e = classifyHttpStatus(429, { retryAfterMs: 2000 });
    expect(isRetryable(e)).toBe(true);
    expect(e.retryAfterMs).toBe(2000);
  });
  test("5xx retryable, 4xx permanent, 401/403 security", () => {
    expect(classifyHttpStatus(503).errorClass).toBe("retryable");
    expect(classifyHttpStatus(422).errorClass).toBe("permanent");
    expect(classifyHttpStatus(401).errorClass).toBe("security");
  });
});

/* ------------------------------------------------------------ backoff */

describe("backoff", () => {
  test("grows exponentially, capped, deterministic jitter", () => {
    const rand = () => 0.5;
    expect(backoffMs(0, { rand })).toBe(1100);
    expect(backoffMs(3, { rand })).toBe(8800);
    expect(backoffMs(20, { rand })).toBe(60000);
  });
});

/* ------------------------------------------------------------ circuit */

describe("circuit breaker", () => {
  test("opens after threshold, half-opens after cooldown, recovers on success", () => {
    let t = 0;
    const c = createCircuit({ failureThreshold: 2, cooldownMs: 100, now: () => t });
    expect(c.canAttempt()).toBe(true);
    c.onFailure();
    c.onFailure();
    expect(c.state).toBe("open");
    expect(c.canAttempt()).toBe(false);
    t = 150;
    expect(c.state).toBe("half_open");
    expect(c.canAttempt()).toBe(true);
    c.onSuccess();
    expect(c.state).toBe("closed");
  });
  test("half-open failure re-opens", () => {
    let t = 0;
    const c = createCircuit({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    c.onFailure();
    t = 150;
    expect(c.state).toBe("half_open");
    c.onFailure();
    expect(c.state).toBe("open");
  });
});

/* --------------------------------------------------------------- hmac */

describe("callback signatures", () => {
  const secret = "test-secret";
  const raw = Buffer.from('{"kind":"delivered"}', "utf8");
  const base = { rawBody: raw, keyId: "k1", resolveSecret: (id) => (id === "k1" ? secret : null) };

  test("valid signature verifies", () => {
    const ts = 1_000_000;
    const sig = signCallback({ rawBody: raw, secret, timestamp: ts, nonce: "n1" });
    expect(verifyCallback({ ...base, signature: sig, timestamp: String(ts), nonce: "n1", nowMs: ts })).toBe(true);
  });
  test("tampered body is refused", () => {
    const ts = 1_000_000;
    const sig = signCallback({ rawBody: raw, secret, timestamp: ts, nonce: "n1" });
    expect(() => verifyCallback({
      ...base, rawBody: Buffer.from("{}"), signature: sig, timestamp: String(ts), nonce: "n1", nowMs: ts,
    })).toThrowError(/invalid/);
  });
  test("expired timestamp is refused", () => {
    const ts = 1_000_000;
    const sig = signCallback({ rawBody: raw, secret, timestamp: ts, nonce: "n1" });
    expect(() => verifyCallback({
      ...base, signature: sig, timestamp: String(ts), nonce: "n1", nowMs: ts + 10 * 60_000,
    })).toThrowError(/tolerance/);
  });
  test("unknown key id is refused", () => {
    const ts = 1_000_000;
    const sig = signCallback({ rawBody: raw, secret, timestamp: ts, nonce: "n1" });
    expect(() => verifyCallback({
      ...base, keyId: "k9", signature: sig, timestamp: String(ts), nonce: "n1", nowMs: ts,
    })).toThrowError(/key id/);
  });
});

/* ------------------------------------------------------------- redact */

describe("PHI-safe telemetry", () => {
  test("synthetic PHI-like fields never reach the log line", () => {
    const lines = [];
    const logger = makeLogger((l) => lines.push(l));
    logger.log("cycle_completed", {
      claimed: 3,
      patientName: "Synthetic Testpatient",
      email: "synthetic@example.com",
      dob: "1990-01-01",
      body: "chest pain since Tuesday",
      payload: { symptom: "synthetic clinical text" },
      invitationToken: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      serviceKey: "sk-secret-value",
      errorClass: "retryable",
    });
    const joined = lines.join("\n");
    expect(joined).toContain('"claimed":3');
    expect(joined).toContain('"errorClass":"retryable"');
    for (const leak of [
      "Synthetic Testpatient", "synthetic@example.com", "1990-01-01",
      "chest pain", "synthetic clinical text", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sk-secret-value",
    ]) {
      expect(joined).not.toContain(leak);
    }
  });
  test("objects are dropped structurally", () => {
    expect(sanitizeFields({ eventUid: "u", payload: { a: 1 } })).toEqual({ eventUid: "u" });
  });
});

/* ------------------------------------------------------- deploy guard */

describe("fixture deployment refusal", () => {
  const markers = [
    { RAILWAY_ENVIRONMENT: "production" },
    { FLY_APP_NAME: "app" },
    { VERCEL: "1" },
    { RENDER: "true" },
    { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
    { NODE_ENV: "production" },
  ];
  for (const env of markers) {
    test(`refuses under ${Object.keys(env)[0]}`, () => {
      expect(() => assertFixtureAllowed(env)).toThrowError(/refuses to run in a deployed environment/);
    });
  }
  test("no override flag exists", () => {
    expect(() =>
      assertFixtureAllowed({ VERCEL: "1", SYNC_FIXTURE_FORCE: "1", ALLOW_FIXTURE: "yes" }),
    ).toThrowError(/no override/);
  });
  test("a plain dev environment is allowed", () => {
    expect(deployedMarker({ NODE_ENV: "test" })).toBeNull();
    expect(assertFixtureAllowed({ NODE_ENV: "development" })).toBe(true);
  });
});

/* --------------------------------------------------- fixture provider */

describe("deterministic contract fixture", () => {
  test("identifies itself as a test fixture", () => {
    const p = createFixtureProvider();
    expect(p.fixture).toBe(true);
    expect(p.label).toMatch(/TEST/);
    expect(p.health().fixture).toBe(true);
  });
  test("success returns deterministic evidence ids (safe redelivery)", async () => {
    const p = createFixtureProvider();
    const a = await p.deliver(envelope());
    const b = await p.deliver(envelope());
    expect(a.evidence.map((e) => e.providerEventId)).toEqual(b.evidence.map((e) => e.providerEventId));
  });
  test("the fixture itself validates payload hashes", async () => {
    const p = createFixtureProvider();
    const bad = envelope();
    bad.payloadHash = sha256Hex("something else");
    await expect(p.deliver(bad)).rejects.toThrowError(/hash/);
  });
  test("failure scenarios carry the right classes", async () => {
    for (const [scenario, cls] of [
      ["timeout", "retryable"], ["retryable_429", "retryable"], ["retryable_5xx", "retryable"],
      ["permanent_400", "permanent"], ["invalid_contract_version", "contract"],
      ["invalid_payload_hash", "contract"],
    ]) {
      const p = createFixtureProvider({ scenarioFor: () => scenario });
      await expect(p.deliver(envelope())).rejects.toMatchObject({ errorClass: cls });
    }
  });
});

/* --------------------------------------------------------- worker core */

describe("worker cycle", () => {
  const claimOf = (...events) => ({ ok: true, events, leaseReclaims: 0, maxQueueAgeSeconds: 5 });

  test("success: evidence recorded ONLY via record_sync_delivery + cycle telemetry", async () => {
    const { rpc, calls } = fakeRpc({
      claim_sync_outbound: claimOf(envelope()),
      recheck_sync_export: { deliverable: true },
    });
    const stats = await runCycle({
      rpc, provider: createFixtureProvider(), circuit: createCircuit(),
      logger: silentLogger, organizationId: "org-1",
    });
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, deadLettered: 0 });
    const recorded = calls.filter((c) => c.name === "record_sync_delivery");
    expect(recorded).toHaveLength(2); // delivered + acknowledged evidence
    expect(calls.at(-1).name).toBe("record_sync_worker_cycle");
  });

  test("recheck refusal cancels durably and the provider is never called", async () => {
    let delivered = 0;
    const provider = { name: "sync_contract_fixture", contractVersion: CONTRACT_VERSION,
      deliver: async () => { delivered += 1; return { evidence: [] }; } };
    const { rpc, calls } = fakeRpc({
      claim_sync_outbound: claimOf(envelope()),
      recheck_sync_export: { deliverable: false, reason: "refused_consent" },
    });
    const stats = await runCycle({ rpc, provider, circuit: createCircuit(), logger: silentLogger, organizationId: "org-1" });
    expect(delivered).toBe(0);
    expect(stats.cancelled).toBe(1);
    expect(calls.filter((c) => c.name === "record_sync_delivery")).toHaveLength(0);
  });

  test("retryable failure records 'failed' and trips the circuit counter", async () => {
    const { rpc, calls } = fakeRpc({
      claim_sync_outbound: claimOf(envelope()),
      recheck_sync_export: { deliverable: true },
    });
    const provider = createFixtureProvider({ scenarioFor: () => "retryable_5xx" });
    const circuit = createCircuit({ failureThreshold: 5 });
    const stats = await runCycle({ rpc, provider, circuit, logger: silentLogger, organizationId: "org-1" });
    expect(stats.retried).toBe(1);
    const rec = calls.find((c) => c.name === "record_sync_delivery");
    expect(rec.args._kind).toBe("failed");
    expect(circuit.failureCount).toBe(1);
  });

  test("permanent/contract/security failures are rejected, never retried", async () => {
    for (const scenario of ["permanent_400", "invalid_contract_version"]) {
      const { rpc, calls } = fakeRpc({
        claim_sync_outbound: claimOf(envelope()),
        recheck_sync_export: { deliverable: true },
      });
      const provider = createFixtureProvider({ scenarioFor: () => scenario });
      const stats = await runCycle({ rpc, provider, circuit: createCircuit(), logger: silentLogger, organizationId: "org-1" });
      expect(stats.deadLettered).toBe(1);
      expect(calls.find((c) => c.name === "record_sync_delivery").args._kind).toBe("rejected");
    }
  });

  test("a malformed claimed envelope is a contract rejection", async () => {
    const bad = { ...envelope(), contractVersion: "patient-sync/9" };
    const { rpc, calls } = fakeRpc({ claim_sync_outbound: claimOf(bad) });
    const stats = await runCycle({
      rpc, provider: createFixtureProvider(), circuit: createCircuit(),
      logger: silentLogger, organizationId: "org-1",
    });
    expect(stats.deadLettered).toBe(1);
    expect(calls.find((c) => c.name === "record_sync_delivery").args._error_safe).toMatch(/contract/);
  });

  test("an open circuit skips delivery without touching state", async () => {
    const circuit = createCircuit({ failureThreshold: 1 });
    circuit.onFailure(); // open
    let delivered = 0;
    const provider = { name: "sync_contract_fixture", contractVersion: CONTRACT_VERSION,
      deliver: async () => { delivered += 1; return { evidence: [] }; } };
    const { rpc, calls } = fakeRpc({
      claim_sync_outbound: claimOf(envelope()),
      recheck_sync_export: { deliverable: true },
    });
    await runCycle({ rpc, provider, circuit, logger: silentLogger, organizationId: "org-1" });
    expect(delivered).toBe(0);
    expect(calls.filter((c) => c.name === "record_sync_delivery")).toHaveLength(0);
  });

  test("worker crash after delivery is safe: redelivery yields identical evidence ids", async () => {
    // Cycle 1: provider delivers, but recording throws (crash simulation).
    const p = createFixtureProvider();
    const failing = fakeRpc({
      claim_sync_outbound: claimOf(envelope()),
      recheck_sync_export: { deliverable: true },
      record_sync_delivery: () => { throw new SyncError("retryable", "backend_unreachable", "down"); },
    });
    await expect(runCycle({
      rpc: failing.rpc, provider: p, circuit: createCircuit(), logger: silentLogger, organizationId: "org-1",
    })).rejects.toBeTruthy();

    // Cycle 2 (after lease reclaim): the SAME envelope redelivers with the
    // SAME deterministic evidence ids, so the database dedupes — duplicate
    // responses are tolerated, nothing is falsely completed.
    const ok = fakeRpc({
      claim_sync_outbound: claimOf(envelope()),
      recheck_sync_export: { deliverable: true },
      record_sync_delivery: { ok: true, duplicate: true, state: "acknowledged" },
    });
    const stats = await runCycle({
      rpc: ok.rpc, provider: p, circuit: createCircuit(), logger: silentLogger, organizationId: "org-1",
    });
    expect(stats.succeeded).toBe(1);
  });
});

/* ----------------------------------------------------- callback server */

describe("callback boundary", () => {
  const secret = "cb-secret";
  const resolveSecret = (id) => (id === "k1" ? secret : null);

  function request(server, { rawBody, headers }) {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", async () => {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}/sync/callback`, {
          method: "POST", headers, body: rawBody,
        });
        const body = await res.json().catch(() => null);
        server.close();
        resolve({ status: res.status, body });
      });
    });
  }

  function signed(bodyObj, { nonce = "n1", timestamp = Date.now(), tamper = false } = {}) {
    const rawBody = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const signature = signCallback({ rawBody, secret, timestamp, nonce });
    return {
      rawBody: tamper ? Buffer.from(JSON.stringify({ ...bodyObj, extra: 1 })) : rawBody,
      headers: {
        "content-type": "application/json",
        "x-sync-signature": signature,
        "x-sync-key-id": "k1",
        "x-sync-timestamp": String(timestamp),
        "x-sync-nonce": nonce,
      },
    };
  }

  test("signature verification happens BEFORE any parsing", async () => {
    let parsed = 0;
    const server = createCallbackServer({
      rpc: async () => ({ ok: true, replay: false }),
      organizationId: "org-1", provider: "sync_contract_fixture",
      resolveSecret, logger: silentLogger,
      parseJson: (buf) => { parsed += 1; return JSON.parse(buf.toString("utf8")); },
    });
    const req = signed({ kind: "delivered", eventUid: "u-1", providerEventId: "p-1" }, { tamper: true });
    const res = await request(server, req);
    expect(res.status).toBe(401);
    expect(parsed).toBe(0); // parse never ran on a bad signature
  });

  test("a valid delivery callback routes to record_sync_delivery", async () => {
    const calls = [];
    const server = createCallbackServer({
      rpc: async (name, args) => { calls.push({ name, args }); return name === "register_sync_callback_nonce" ? { ok: true, replay: false } : { ok: true, state: "delivered" }; },
      organizationId: "org-1", provider: "sync_contract_fixture",
      resolveSecret, logger: silentLogger,
    });
    const res = await request(server, signed({ kind: "delivered", eventUid: "u-1", providerEventId: "p-1", occurredAt: new Date().toISOString() }));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual(["register_sync_callback_nonce", "record_sync_delivery"]);
  });

  test("a replayed nonce is refused with 409", async () => {
    const server = createCallbackServer({
      rpc: async (name) => (name === "register_sync_callback_nonce" ? { ok: true, replay: true } : { ok: true }),
      organizationId: "org-1", provider: "sync_contract_fixture",
      resolveSecret, logger: silentLogger,
    });
    const res = await request(server, signed({ kind: "delivered", eventUid: "u-1", providerEventId: "p-1" }));
    expect(res.status).toBe(409);
  });

  test("oversized bodies are refused with 413", async () => {
    const server = createCallbackServer({
      rpc: async () => ({ ok: true, replay: false }),
      organizationId: "org-1", provider: "sync_contract_fixture",
      resolveSecret, logger: silentLogger,
    });
    const res = await request(server, signed({ blob: "x".repeat(70000) }));
    expect(res.status).toBe(413);
  });

  test("wrong content type is refused with 415", async () => {
    const server = createCallbackServer({
      rpc: async () => ({ ok: true, replay: false }),
      organizationId: "org-1", provider: "sync_contract_fixture",
      resolveSecret, logger: silentLogger,
    });
    const req = signed({ kind: "delivered" });
    req.headers["content-type"] = "text/plain";
    const res = await request(server, req);
    expect(res.status).toBe(415);
  });

  test("responses are sanitized and never echo bodies", async () => {
    const server = createCallbackServer({
      rpc: async (name) => (name === "register_sync_callback_nonce" ? { ok: true, replay: false } : { ok: true, state: "delivered" }),
      organizationId: "org-1", provider: "sync_contract_fixture",
      resolveSecret, logger: silentLogger,
    });
    const res = await request(server, signed({ kind: "delivered", eventUid: "u-1", providerEventId: "p-1", secretNote: "synthetic PHI text" }));
    expect(JSON.stringify(res.body)).not.toContain("synthetic PHI text");
  });
});
