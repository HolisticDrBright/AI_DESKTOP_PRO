/**
 * CROSS-REPO ROUND TRIP: the desktop's REAL alp-provider adapter and REAL
 * callback server against AI Longevity Pro's REAL patient-sync/1 receiver
 * and REAL outbound dispatcher (spawned from the sibling repository via
 * `bun run backend/sync/dev-server.ts`, in-memory storage).
 *
 * Every request here is a genuine signed HTTP exchange between the two
 * production code paths — no staging environment, no database, no real
 * patient data. Gated on ALP_BRIDGE_DIR; skipped (visibly) when the
 * sibling repository is not present.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAlpProvider } from "./alp-provider.mjs";
import { createCallbackServer } from "./callback-server.mjs";

const ALP_DIR = process.env.ALP_BRIDGE_DIR ?? "";
const RUN = Boolean(ALP_DIR) && existsSync(ALP_DIR);
const BUN_EXECUTABLE = process.env.BUN_EXECUTABLE ?? "bun";

const ALP_PORT = 3996;
const DESKTOP_PORT = 3995;
const ALP_BASE = `http://127.0.0.1:${ALP_PORT}`;
const INBOUND_SECRET = "rt-desktop-to-alp-secret";
const OUTBOUND_SECRET = "rt-alp-to-desktop-secret";
const CONNECTION_ID = "conn-rt-1";
const ORG_ID = "org-rt-1";

const sha256 = (t) => createHash("sha256").update(t).digest("hex");

let alpProcess = null;
let desktopServer = null;
let provider = null;
let rpcCalls = [];
let nonceLedger = new Set();

function claimedEnvelope(overrides = {}) {
  const payload = overrides.payload ?? { title: "Longevity protocol v4", status: "approved" };
  const uid = overrides.eventUid ?? `rt-uid-${Math.random().toString(36).slice(2, 10)}`;
  return {
    eventId: "row-rt",
    eventUid: uid,
    contractVersion: "patient-sync/1",
    connectionId: CONNECTION_ID,
    idempotencyKey: `${CONNECTION_ID}:protocol_version:res-rt:4`,
    scope: "protocols_supplements",
    resourceType: "protocol_version",
    resourceId: "res-rt",
    resourceVersion: "4",
    occurredAt: new Date().toISOString(),
    producer: "desktop",
    provenance: { producer: "desktop", practitionerReviewed: true },
    payload,
    payloadHash: sha256(JSON.stringify(payload)),
    correlationId: null,
    causationId: null,
    organizationId: ORG_ID,
    attempts: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  };
}

describe.skipIf(!RUN)("patient-sync/1 bridge round trip (both real codebases)", () => {
  beforeAll(async () => {
    alpProcess = spawn(BUN_EXECUTABLE, ["run", "backend/sync/dev-server.ts"], {
      cwd: ALP_DIR,
      env: {
        ...process.env,
        SYNC_DEV_PORT: String(ALP_PORT),
        PATIENT_SYNC_INBOUND_SECRET: INBOUND_SECRET,
        PATIENT_SYNC_INBOUND_KEY_ID: "desktop-key-1",
        PATIENT_SYNC_OUTBOUND_URL: `http://127.0.0.1:${DESKTOP_PORT}`,
        PATIENT_SYNC_OUTBOUND_SECRET: OUTBOUND_SECRET,
        PATIENT_SYNC_OUTBOUND_KEY_ID: "alp-key-1",
        SYNC_DEV_CONNECTION_ID: CONNECTION_ID,
        SYNC_DEV_ORGANIZATION_ID: ORG_ID,
        SYNC_DEV_USER_ID: "user-rt-1",
      },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ALP dev server did not start")), 20_000);
      alpProcess.stdout.on("data", (d) => {
        if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
      });
      alpProcess.stderr.on("data", () => undefined);
    });

    // The desktop's REAL callback boundary, with an rpc recorder standing in
    // for the (separately DB-proven) service-role RPCs.
    desktopServer = createCallbackServer({
      rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        if (name === "register_sync_callback_nonce") {
          const key = String(args._nonce);
          if (nonceLedger.has(key)) return { ok: true, replay: true };
          nonceLedger.add(key);
          return { ok: true, replay: false };
        }
        if (name === "record_sync_delivery") return { ok: true, duplicate: false, state: "acknowledged" };
        if (name === "record_sync_inbound") return { ok: true, duplicate: false, state: "processed", eventId: "in-rt-1" };
        return { ok: true };
      },
      organizationId: ORG_ID,
      provider: "alp_patient_sync",
      resolveSecret: (keyId) => (keyId === "alp-key-1" ? OUTBOUND_SECRET : null),
      logger: { log: () => undefined },
    });
    await new Promise((resolve) => desktopServer.listen(DESKTOP_PORT, "127.0.0.1", resolve));

    provider = createAlpProvider({
      baseUrl: ALP_BASE,
      secret: INBOUND_SECRET,
      keyId: "desktop-key-1",
      organizationId: ORG_ID,
    });
  }, 30_000);

  afterAll(async () => {
    if (alpProcess && !alpProcess.killed) alpProcess.kill();
    if (desktopServer) await new Promise((resolve) => desktopServer.close(resolve));
  });

  let sharedEventUid = "";

  it("1. delivers a signed envelope end to end and materializes the resource on the patient side", async () => {
    const envelope = claimedEnvelope();
    sharedEventUid = envelope.eventUid;
    const result = await provider.deliver(envelope);
    expect(result.duplicate).toBe(false);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe("delivered");

    const resources = await (await fetch(`${ALP_BASE}/__dev/resources`)).json();
    const shared = resources.resources.find((r) => r.resourceType === "protocol_version");
    expect(shared.resourceVersion).toBe("4");
    expect(shared.provenance.practitionerReviewed).toBe(true);
    expect(shared.tombstoned).toBe(false);
  });

  it("2. re-delivery is idempotent across the wire: identical receipt ids, duplicate flagged", async () => {
    const envelope = claimedEnvelope({ eventUid: sharedEventUid });
    const again = await provider.deliver(envelope);
    expect(again.duplicate).toBe(true);
    expect(again.evidence[0].providerEventId).toBe(`alp-del-${sha256(sharedEventUid).slice(0, 16)}`);
  });

  it("3. a tampered body is refused by the real receiver with a signature error", async () => {
    const envelope = claimedEnvelope();
    const raw = JSON.stringify(envelope);
    const { signCallback } = await import("./hmac.mjs");
    const timestamp = Date.now();
    const nonce = `tamper-${Math.random()}`;
    const response = await fetch(`${ALP_BASE}/patient-sync/v1/envelopes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-signature": signCallback({
          rawBody: Buffer.from(raw, "utf8"), secret: INBOUND_SECRET, timestamp, nonce,
        }),
        "x-sync-key-id": "desktop-key-1",
        "x-sync-timestamp": String(timestamp),
        "x-sync-nonce": nonce,
      },
      body: raw.replace("approved", "tampered"),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("invalid_signature");
  });

  it("4. a cross-organization envelope is refused as security, never delivered", async () => {
    const envelope = claimedEnvelope({ organizationId: "org-evil" });
    await expect(provider.deliver(envelope))
      .rejects.toMatchObject({ errorClass: "security", code: "wrong_organization" });
  });

  it("5. a resource withdrawal tombstones on the patient side and auto-acknowledges", async () => {
    const withdrawalPayload = {
      withdrawnResourceType: "protocol_version", resourceId: "res-rt",
      reason: "superseded in person",
    };
    const envelope = claimedEnvelope({
      resourceType: "resource_withdrawal",
      payload: withdrawalPayload,
      payloadHash: sha256(JSON.stringify(withdrawalPayload)),
    });
    const result = await provider.deliver(envelope);
    expect(result.evidence.map((e) => e.kind)).toEqual(["delivered", "acknowledged"]);

    const resources = await (await fetch(`${ALP_BASE}/__dev/resources`)).json();
    const withdrawn = resources.resources.find((r) => r.resourceType === "protocol_version");
    expect(withdrawn.tombstoned).toBe(true);
    expect(withdrawn.payload).toEqual({});
  });

  it("6. the patient's acknowledgment travels back through ALP's REAL outbox to the desktop's REAL callback boundary", async () => {
    rpcCalls = [];
    await fetch(`${ALP_BASE}/__dev/queue-ack`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventUid: sharedEventUid }),
    });
    const dispatch = await (await fetch(`${ALP_BASE}/__dev/dispatch`, { method: "POST" })).json();
    expect(dispatch.delivered).toBe(1);
    const recorded = rpcCalls.find((c) => c.name === "record_sync_delivery");
    expect(recorded.args._event_uid).toBe(sharedEventUid);
    expect(recorded.args._kind).toBe("acknowledged");
    expect(recorded.args._signature_key_id).toBe("alp-key-1");
  });

  it("7. patient adherence travels back as a signed inbound envelope with a verifiable hash", async () => {
    rpcCalls = [];
    await fetch(`${ALP_BASE}/__dev/queue-event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "supplement_adherence",
        payload: { adherence: "took the evening stack", day: "2026-07-30" },
        externalResourceId: "adh-rt-1", resourceVersion: "1",
      }),
    });
    const dispatch = await (await fetch(`${ALP_BASE}/__dev/dispatch`, { method: "POST" })).json();
    expect(dispatch.delivered).toBe(1);
    const recorded = rpcCalls.find((c) => c.name === "record_sync_inbound");
    expect(recorded.args._connection_id).toBe(CONNECTION_ID);
    expect(recorded.args._contract_version).toBe("patient-sync/1");
    expect(recorded.args._resource_type).toBe("supplement_adherence");
    expect(recorded.args._payload_hash)
      .toBe(sha256(JSON.stringify(recorded.args._payload)));
  });

  it("8. patient-side revocation refuses the next delivery as consent — durably not deliverable", async () => {
    await fetch(`${ALP_BASE}/__dev/revoke`, { method: "POST" });
    await expect(provider.deliver(claimedEnvelope()))
      .rejects.toMatchObject({ errorClass: "consent", code: "connection_revoked" });
  });

  it("9. a dead receiver is a RETRYABLE failure — never fabricated evidence, never a fixture fallback", async () => {
    alpProcess.kill();
    await new Promise((resolve) => alpProcess.on("close", resolve));
    await expect(provider.deliver(claimedEnvelope()))
      .rejects.toMatchObject({ errorClass: "retryable", code: "alp_unreachable" });
  });
});

describe.skipIf(RUN)("bridge round trip prerequisites", () => {
  it("is SKIPPED: set ALP_BRIDGE_DIR to the AI Longevity Pro expo directory to run the cross-repo round trip", () => {
    expect(RUN).toBe(false);
  });
});
