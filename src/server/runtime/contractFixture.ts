/**
 * The local contract-fixture boundary.
 *
 * SERVER-ONLY. This is the single gate that decides whether the process is
 * allowed to run against a deterministic local contract fixture — the
 * in-process synthetic provider and the loopback stub backend that the
 * browser suite drives.
 *
 * It is deliberately a SEPARATE module from `deployedRuntime.ts` and a
 * separate concept from `resolveCopilotMode()`. Those answer "is this a
 * deployed process?" and "what did the operator ask for?". This answers a
 * narrower question with a much higher bar:
 *
 *     Is this unambiguously a local test harness, talking to a loopback
 *     backend that is definitely not the clinical project?
 *
 * ALL of the following must hold. Any one failing refuses, and the refusal
 * names which one, because "fixture refused" with no reason is the kind of
 * message that gets worked around rather than understood.
 *
 *   1. `CLINICAL_CONTRACT_FIXTURE=1` is set explicitly. There is no
 *      default-on path; forgetting the flag refuses.
 *   2. `isDeployedRuntime()` is false. This is the SAME categorical
 *      detector Phase 10A uses, including its `NODE_ENV=production`
 *      last-resort signal, so a production-mode server refuses even on
 *      loopback. That is why the browser suite that needs deterministic
 *      provider output runs against a dev server.
 *   3. A clinical backend URL is configured at all.
 *   4. That URL is not the real clinical Supabase project, and not any
 *      hosted Supabase project.
 *   5. That URL's host is loopback.
 *
 * Nothing here can be satisfied by a `NEXT_PUBLIC_*` value, because none is
 * consulted. Nothing here weakens the Phase 10A refusal: a deployed
 * runtime is refused by rule 2 before any of the local checks run.
 */
if (typeof window !== "undefined") {
  throw new Error("runtime/contractFixture is server-only.");
}

import { detectDeploymentPosture } from "./deployedRuntime";

export type ContractFixtureRefusal =
  | "not_enabled"
  | "deployed_runtime"
  | "backend_not_configured"
  | "hosted_supabase_project"
  | "non_loopback_backend"
  | "backend_url_unparseable";

export type ContractFixtureVerdict =
  | { allowed: true; backendOrigin: string }
  | { allowed: false; refusal: ContractFixtureRefusal; detail: string };

/**
 * The clinical project id. Named explicitly so that pointing a fixture run
 * at it is refused by identity, not merely by the loopback rule — a tunnel
 * or a hosts-file entry could otherwise make it look local.
 */
const CLINICAL_PROJECT_REF = "urcjiehlxoehievobezf";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

type FixtureEnv = {
  CLINICAL_CONTRACT_FIXTURE?: string;
  CLINICAL_SUPABASE_URL?: string;
  CLINICAL_SUPABASE_ANON_KEY?: string;
};

export function evaluateContractFixtureBoundary(
  env: FixtureEnv = process.env as FixtureEnv,
): ContractFixtureVerdict {
  // 1. Explicit opt-in. No default-on path.
  if (String(env.CLINICAL_CONTRACT_FIXTURE ?? "").trim() !== "1") {
    return {
      allowed: false,
      refusal: "not_enabled",
      detail: "CLINICAL_CONTRACT_FIXTURE is not set to 1.",
    };
  }

  // 2. Categorical deployed-runtime refusal — the Phase 10A rule, unchanged
  //    and reused rather than reimplemented.
  const posture = detectDeploymentPosture();
  if (posture.isDeployed) {
    return {
      allowed: false,
      refusal: "deployed_runtime",
      detail:
        "This process is a deployed runtime " +
        `(${posture.signals.join(", ")}). A contract fixture is refused here.`,
    };
  }

  // 3. There has to be a backend to check.
  const raw = String(env.CLINICAL_SUPABASE_URL ?? "").trim();
  if (!raw) {
    return {
      allowed: false,
      refusal: "backend_not_configured",
      detail: "CLINICAL_SUPABASE_URL is not set.",
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      allowed: false,
      refusal: "backend_url_unparseable",
      detail: "CLINICAL_SUPABASE_URL is not a valid URL.",
    };
  }

  // 4. Never the real clinical project, and never any hosted Supabase.
  //    Checked before the loopback rule so the refusal is precise.
  const host = url.hostname.toLowerCase();
  if (host.includes(CLINICAL_PROJECT_REF) || /\.supabase\.(co|in|net)$/.test(host)) {
    return {
      allowed: false,
      refusal: "hosted_supabase_project",
      detail: "A contract fixture must never run against a hosted Supabase project.",
    };
  }

  // 5. Loopback only.
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      allowed: false,
      refusal: "non_loopback_backend",
      detail: `The clinical backend host "${host}" is not loopback.`,
    };
  }

  return { allowed: true, backendOrigin: url.origin };
}

/** Convenience boolean. Prefer the verdict when you need to report why. */
export function isContractFixtureAllowed(env?: FixtureEnv): boolean {
  return evaluateContractFixtureBoundary(env).allowed;
}

/**
 * The only accessor allowed to expose the retired REST-shaped local fixture.
 * It never returns a hosted origin and is categorically refused in deployment.
 */
export function getContractFixtureTransport(env: FixtureEnv = process.env as FixtureEnv): {
  origin: string;
  credential: string;
} | null {
  const verdict = evaluateContractFixtureBoundary(env);
  if (!verdict.allowed) return null;
  const credential = String(env.CLINICAL_SUPABASE_ANON_KEY ?? "").trim();
  if (!credential) return null;
  return { origin: verdict.backendOrigin, credential };
}
