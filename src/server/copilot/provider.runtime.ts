/**
 * Phase 10B.1 — provider runtime composition.
 *
 * SERVER-ONLY. This is the single place that decides whether a secret
 * resolver or an HTTPS transport is CONSTRUCTED at all.
 *
 * The ordering matters and is the point of the module: the disabled branch
 * returns BEFORE either factory is invoked. "No AWS client is built when
 * the copilot is off" is therefore a property of control flow that a test
 * can observe by counting factory invocations, not a comment asking the
 * reader to trust it.
 *
 * Nothing here treats an environment variable, the presence of a secret,
 * or a successful secret lookup as approval. Approval is evaluated
 * separately from governed records in `provider.openai.ts`.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider.runtime is server-only.");
}

import { createHttpsTransport, refusalTransport, type Transport } from "./http-transport";
import { OPENAI_API_ORIGIN } from "./provider.openai.request";
import { createProductionSecretResolver } from "./secrets.aws";
import type { SecretResolver } from "./secrets";
import { resolveCopilotMode, type CopilotMode } from "./provider";

/** Why a runtime refused to build a live path. PHI-safe. */
export type RuntimeRefusal =
  | "copilot_disabled"
  | "fixture_mode"
  | "secret_backend_unconfigured";

export type ProviderRuntime =
  | { kind: "disabled"; refusal: "copilot_disabled" }
  | { kind: "fixture"; refusal: "fixture_mode" }
  | { kind: "live"; transport: Transport; secretResolver: SecretResolver }
  | { kind: "live_unconfigured"; refusal: "secret_backend_unconfigured" };

/**
 * Factories are injected so tests can count construction without reaching
 * AWS or the network. Production uses the real ones.
 */
export type ProviderRuntimeDeps = {
  mode?: CopilotMode;
  makeTransport?: () => Transport;
  makeSecretResolver?: () => SecretResolver | null;
};

/**
 * The bounded HTTPS transport for the OpenAI provider, pinned to the
 * official API origin. The allowlist is a constant, not a configuration
 * value — no environment variable can widen it.
 */
export function createOpenAITransport(fetchImpl?: typeof fetch): Transport {
  return createHttpsTransport({
    allowedOrigins: [OPENAI_API_ORIGIN],
    timeoutMs: 20_000,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 1024 * 1024,
    fetchImpl,
  });
}

/**
 * Decide what the provider runtime is allowed to build.
 *
 * Read the branches in order — the sequence IS the guarantee:
 *   1. disabled  → return immediately. No transport, no resolver, no AWS
 *                  client, no environment read beyond the mode itself.
 *   2. fixture   → return. The fixture provider is in-process; it has no
 *                  transport and no secret.
 *   3. live      → only now is a secret backend consulted. If the
 *                  environment cannot supply an AWS identity, the runtime
 *                  is `live_unconfigured` and the adapter refuses. It never
 *                  falls back to a key from the environment, and never
 *                  falls back to the fixture.
 */
export function resolveProviderRuntime(deps: ProviderRuntimeDeps = {}): ProviderRuntime {
  const mode = deps.mode ?? resolveCopilotMode();

  if (mode === "disabled") {
    return { kind: "disabled", refusal: "copilot_disabled" };
  }
  if (mode === "fixture") {
    return { kind: "fixture", refusal: "fixture_mode" };
  }

  const makeSecretResolver = deps.makeSecretResolver ?? (() => createProductionSecretResolver());
  const secretResolver = makeSecretResolver();
  if (!secretResolver) {
    return { kind: "live_unconfigured", refusal: "secret_backend_unconfigured" };
  }
  const makeTransport = deps.makeTransport ?? (() => createOpenAITransport());
  return { kind: "live", transport: makeTransport(), secretResolver };
}

/**
 * The transport an adapter gets when the runtime refused. Exported so a
 * caller cannot accidentally substitute something permissive.
 */
export function refusedTransport(): Transport {
  return refusalTransport;
}
