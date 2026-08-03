#!/usr/bin/env node
/**
 * The patient-sync worker entry point — a SEPARATELY runnable process.
 *
 *   node scripts/sync/worker.mjs [--once] [--callback-port <port>]
 *
 * Environment (names only; values are never logged):
 *   SYNC_WORKER_SUPABASE_URL       backend URL (worker only)
 *   SYNC_WORKER_SERVICE_ROLE_KEY   service-role key (worker only — NEVER a
 *                                  NEXT_PUBLIC_* variable, never in src/)
 *   SYNC_WORKER_ORG_ID             organization to work
 *   SYNC_PROVIDER                  none | fixture   ('alp' is Phase 6B and
 *                                  refuses until separately authorized)
 *   SYNC_FIXTURE_SCENARIOS         optional JSON {resourceType: scenario}
 *   SYNC_WORKER_BATCH              batch size (default 10)
 *   SYNC_WORKER_INTERVAL_MS        loop interval (default 5000)
 *   SYNC_WORKER_LEASE_SECONDS      claim lease (default 120)
 *   SYNC_CALLBACK_SECRET           HMAC secret for the callback boundary
 *   SYNC_CALLBACK_KEY_ID           key id identifying that secret
 *
 * With SYNC_PROVIDER=none (or unset) the worker exits idle — worker absence
 * never makes the web application unhealthy, and the web app never needs
 * these variables.
 */
import { randomUUID } from "node:crypto";
import { createRpcClient } from "./supabase.mjs";
import { createFixtureProvider, FIXTURE_LABEL } from "./fixture-provider.mjs";
import { assertFixtureAllowed } from "./deploy-guard.mjs";
import { createCircuit } from "./circuit.mjs";
import { makeLogger } from "./redact.mjs";
import { runCycle } from "./worker-core.mjs";
import { createCallbackServer } from "./callback-server.mjs";
import { backoffMs } from "./backoff.mjs";

const argv = process.argv.slice(2);
const once = argv.includes("--once");
const portFlag = argv.indexOf("--callback-port");
const callbackPort = portFlag >= 0 ? Number(argv[portFlag + 1]) : null;

const logger = makeLogger();
const providerMode = process.env.SYNC_PROVIDER ?? "none";

async function main() {
  if (providerMode === "none") {
    logger.log("worker_idle", { posture: "disabled", reason: "no provider configured" });
    return 0;
  }
  if (providerMode !== "fixture") {
    // A real AI Longevity Pro provider is Phase 6B and requires separate
    // explicit authorization — this entry point refuses to pretend otherwise.
    logger.log("worker_refused", { posture: providerMode, reason: "provider not authorized" });
    return 1;
  }

  // TEST FIXTURE ONLY: refuses every deployed environment, no override.
  assertFixtureAllowed(process.env);
  let scenarioMap = {};
  try {
    scenarioMap = process.env.SYNC_FIXTURE_SCENARIOS
      ? JSON.parse(process.env.SYNC_FIXTURE_SCENARIOS)
      : {};
  } catch {
    scenarioMap = {};
  }
  const provider = createFixtureProvider({
    scenarioFor: (envelope) => scenarioMap[envelope.resourceType] ?? "success",
  });
  logger.log("worker_started", { provider: provider.name, posture: "fixture" });
  // The fixture identifies itself loudly, every run.
  process.stdout.write(`# ${FIXTURE_LABEL}\n`);

  const rpc = createRpcClient({
    url: process.env.SYNC_WORKER_SUPABASE_URL,
    serviceKey: process.env.SYNC_WORKER_SERVICE_ROLE_KEY,
  }).rpc;
  const organizationId = process.env.SYNC_WORKER_ORG_ID;
  if (!organizationId) {
    logger.log("worker_refused", { reason: "SYNC_WORKER_ORG_ID missing" });
    return 1;
  }
  const circuit = createCircuit();
  const workerId = randomUUID();
  const batchSize = Number(process.env.SYNC_WORKER_BATCH ?? 10);
  const leaseSeconds = Number(process.env.SYNC_WORKER_LEASE_SECONDS ?? 120);
  const intervalMs = Number(process.env.SYNC_WORKER_INTERVAL_MS ?? 5000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let server = null;
  if (callbackPort) {
    server = createCallbackServer({
      rpc,
      organizationId,
      provider: provider.name,
      resolveSecret: (keyId) =>
        keyId === (process.env.SYNC_CALLBACK_KEY_ID ?? "fixture-key-1")
          ? process.env.SYNC_CALLBACK_SECRET ?? null
          : null,
      logger,
    });
    await new Promise((resolve) => server.listen(callbackPort, "127.0.0.1", resolve));
    logger.log("callback_listening", { port: callbackPort });
  }

  let attempt = 0;
  do {
    try {
      await runCycle({
        rpc, provider, circuit, logger, organizationId,
        batchSize, leaseSeconds, workerId, sleep,
      });
      attempt = 0;
    } catch (e) {
      attempt += 1;
      logger.log("cycle_failed", { errorClass: e.errorClass ?? "retryable", errorCode: e.code ?? "unknown" });
      if (once) {
        if (server) server.close();
        return 1;
      }
      await sleep(backoffMs(attempt));
    }
    if (!once) await sleep(intervalMs);
  } while (!once);

  if (server) server.close();
  return 0;
}

// Set the exit code and let Node exit naturally. Calling `process.exit()` here
// races the runtime's async-handle teardown on Windows/Node 24 (libuv fires
// `!(handle->flags & UV_HANDLE_CLOSING)` at src\win\async.c line 94 when the
// forced exit interrupts undici's connection-pool cleanup). Node 22 tolerates
// the race and Linux does not observe it, but the honest fix is not to force
// exit at all: drain the loop by returning, and the process leaves with its
// intended code once no handles remain.
main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    logger.log("worker_crashed", { errorClass: e.errorClass ?? "unknown", errorCode: e.code ?? "unknown" });
    process.exitCode = 1;
  },
);
