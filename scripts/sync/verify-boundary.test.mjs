/**
 * The /sync/verify boundary on the worker's callback server: the ONLY path
 * a patient app can use to bind a connection — one-time code + opaque
 * subject, signed like every callback, minimum-necessary response (never
 * the desktop patient id), and a single typed refusal for every failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createCallbackServer } from "./callback-server.mjs";
import { SyncError } from "./errors.mjs";

const SECRET = "verify-secret";
const KEY_ID = "alp-key-1";
// A fresh port per test: undici's keep-alive pool must never reuse a
// connection to a previous test's closed server instance.
let PORT = 39443;

let server;
let rpcCalls;
let rpcResult;

const sign = (rawBody, timestamp, nonce) => {
  const h = createHmac("sha256", SECRET);
  h.update(`v1:${timestamp}:${nonce}:`, "utf8");
  h.update(rawBody);
  return h.digest("hex");
};

const post = async (path, body, { timestamp = Date.now(), nonce = `n-${Math.random()}` } = {}) => {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sync-signature": sign(rawBody, timestamp, nonce),
      "x-sync-key-id": KEY_ID,
      "x-sync-timestamp": String(timestamp),
      "x-sync-nonce": nonce,
    },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
};

beforeEach(async () => {
  PORT += 1;
  rpcCalls = [];
  rpcResult = {
    ok: true,
    connectionId: "conn-77",
    organizationId: "org-77",
    patientId: "SHOULD-NEVER-CROSS",
    contractVersion: "patient-sync/1",
  };
  server = createCallbackServer({
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "register_sync_callback_nonce") return { ok: true, replay: false };
      if (name === "verify_sync_invitation") {
        if (rpcResult instanceof Error) throw rpcResult;
        return rpcResult;
      }
      return { ok: true };
    },
    organizationId: "org-77",
    provider: "alp_patient_sync",
    resolveSecret: (keyId) => (keyId === KEY_ID ? SECRET : null),
    logger: { log: () => undefined },
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("/sync/verify", () => {
  it("verifies a one-time code and returns ONLY the connection identifiers — never the patient id", async () => {
    const result = await post("/sync/verify", { token: "a".repeat(64), subject: "alp-user-1" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      connectionId: "conn-77",
      organizationId: "org-77",
      contractVersion: "patient-sync/1",
    });
    expect(JSON.stringify(result.body)).not.toContain("SHOULD-NEVER-CROSS");
    const verify = rpcCalls.find((c) => c.name === "verify_sync_invitation");
    expect(verify.args).toEqual({ _token: "a".repeat(64), _external_subject_id: "alp-user-1" });
  });

  it("answers every verification failure with ONE typed refusal — nothing to probe", async () => {
    for (const failure of [
      new SyncError("permanent", "rpc_P0002", "not found"),
      new SyncError("permanent", "rpc_22023", "expired"),
      new SyncError("permanent", "rpc_23505", "subject bound"),
    ]) {
      rpcResult = failure;
      const result = await post("/sync/verify", { token: "b".repeat(64), subject: "alp-user-2" });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: { code: "invitation_invalid" } });
    }
  });

  it("refuses an unsigned verification attempt before anything is parsed", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/sync/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "c".repeat(64), subject: "alp-user-3" }),
    });
    expect(response.status).toBe(401);
    expect(rpcCalls.find((c) => c.name === "verify_sync_invitation")).toBeUndefined();
  });

  it("refuses a missing token or subject without calling the database", async () => {
    for (const body of [{ token: "d".repeat(64) }, { subject: "alp-user-4" }, {}]) {
      const result = await post("/sync/verify", body);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_verification_request");
    }
    expect(rpcCalls.filter((c) => c.name === "verify_sync_invitation")).toHaveLength(0);
  });

  it("keeps the exact method + path binding — GET and other paths miss", async () => {
    const get = await fetch(`http://127.0.0.1:${PORT}/sync/verify`);
    expect(get.status).toBe(404);
  });
});
