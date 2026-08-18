import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createSignedBridgeHandler } from "./aws-bridge-handler.mjs";

function signedEvent(path, body, { secret = "a".repeat(64), keyId = "v2-to-desktop-2026-08", now = 1_800_000_000_000 } = {}) {
  const raw = JSON.stringify(body);
  const nonce = "nonce-1";
  const signature = createHmac("sha256", secret)
    .update(`v1:${now}:${nonce}:`, "utf8")
    .update(Buffer.from(raw))
    .digest("hex");
  return {
    rawPath: path,
    requestContext: { http: { method: "POST", path } },
    headers: {
      "content-type": "application/json",
      "x-sync-signature": signature,
      "x-sync-key-id": keyId,
      "x-sync-timestamp": String(now),
      "x-sync-nonce": nonce,
    },
    body: raw,
  };
}

describe("AWS patient-sync bridge", () => {
  it("verifies an invitation only after signature and nonce checks", async () => {
    const calls = [];
    const handler = createSignedBridgeHandler({
      rpc: async (name) => {
        calls.push(name);
        if (name === "register_sync_callback_nonce") return { replay: false };
        return { connectionId: "connection-1", organizationId: "org-1", contractVersion: "patient-sync/1" };
      },
      organizationId: "org-1",
      callbackKeyId: "v2-to-desktop-2026-08",
      callbackSecret: "a".repeat(64),
      nowMs: () => 1_800_000_000_000,
      log: { log() {} },
    });
    const result = await handler(signedEvent("/sync/verify", { token: "b".repeat(64), subject: "subject-1" }));
    expect(result.statusCode).toBe(200);
    expect(calls).toEqual(["register_sync_callback_nonce", "verify_sync_invitation"]);
  });

  it("routes a wearable summary to the governed inbound RPC", async () => {
    const calls = [];
    const handler = createSignedBridgeHandler({
      rpc: async (name, args) => {
        calls.push([name, args]);
        return name === "register_sync_callback_nonce" ? { replay: false } : { duplicate: false };
      },
      organizationId: "org-1",
      callbackKeyId: "v2-to-desktop-2026-08",
      callbackSecret: "a".repeat(64),
      nowMs: () => 1_800_000_000_000,
      log: { log() {} },
    });
    const result = await handler(signedEvent("/sync/callback", {
      connectionId: "connection-1",
      providerEventId: "event-1",
      contractVersion: "patient-sync/1",
      resourceType: "wearable_summary",
      payload: { date: "2026-08-17" },
      payloadHash: "f".repeat(64),
      occurredAt: "2026-08-17T12:00:00.000Z",
      externalResourceId: "wearable-summary-2026-08-17",
      resourceVersion: "2026-08-17",
    }));
    expect(result.statusCode).toBe(200);
    expect(calls[1][0]).toBe("record_sync_inbound");
    expect(calls[1][1]._resource_type).toBe("wearable_summary");
  });

  it("routes lab results only to the clinician-review import RPC", async () => {
    const calls = [];
    const handler = createSignedBridgeHandler({
      rpc: async (name, args) => {
        calls.push([name, args]);
        return name === "register_sync_callback_nonce" ? { replay: false } : { duplicate: false };
      },
      organizationId: "org-1",
      callbackKeyId: "v2-to-desktop-2026-08",
      callbackSecret: "a".repeat(64),
      nowMs: () => 1_800_000_000_000,
      log: { log() {} },
    });
    const result = await handler(signedEvent("/sync/callback", {
      connectionId: "connection-1",
      providerEventId: "alp-lab-synthetic-1",
      contractVersion: "patient-sync/1",
      resourceType: "lab_result",
      payload: { schemaVersion: "lab-result/1" },
      payloadHash: "f".repeat(64),
      occurredAt: "2026-08-17T12:00:00.000Z",
      externalResourceId: "panel-1:glucose",
      resourceVersion: "2026-08-17T12:00:00.000Z",
    }));
    expect(result.statusCode).toBe(200);
    expect(calls[1][0]).toBe("record_sync_lab_result");
    expect(calls[1][1]._resource_type).toBe("lab_result");
  });

  it("refuses a tampered body before any database call", async () => {
    let calls = 0;
    const event = signedEvent("/sync/callback", { kind: "delivered", eventUid: "event-1" });
    event.body = JSON.stringify({ kind: "acknowledged", eventUid: "event-1" });
    const handler = createSignedBridgeHandler({
      rpc: async () => { calls += 1; return {}; },
      organizationId: "org-1",
      callbackKeyId: "v2-to-desktop-2026-08",
      callbackSecret: "a".repeat(64),
      nowMs: () => 1_800_000_000_000,
      log: { log() {} },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
    expect(calls).toBe(0);
  });
});
