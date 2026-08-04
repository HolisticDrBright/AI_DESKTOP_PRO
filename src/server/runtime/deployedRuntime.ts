/**
 * Shared server-only deployed-runtime posture detector.
 *
 * ANY of these signals means the process is running in a deployed
 * environment and MUST NOT use a fixture / test-only path:
 *
 *   - VERCEL_ENV in {production, preview, development-deploy}
 *   - VERCEL === "1"
 *   - RAILWAY_ENVIRONMENT, RAILWAY_SERVICE_NAME, RAILWAY_STATIC_URL
 *   - FLY_APP_NAME, FLY_MACHINE_ID, FLY_ALLOC_ID
 *   - RENDER, RENDER_SERVICE_NAME, RENDER_INSTANCE_ID
 *   - AWS_LAMBDA_FUNCTION_NAME, AWS_EXECUTION_ENV, ECS_CONTAINER_METADATA_URI*
 *   - K_SERVICE (Cloud Run / Knative), CLOUD_RUN_JOB
 *   - CF_PAGES, CF_PAGES_URL (Cloudflare Pages)
 *   - NETLIFY, DEPLOY_PRIME_URL (Netlify)
 *   - HEROKU_APP_NAME, HEROKU_APP_ID, DYNO
 *   - NODE_ENV === "production" (last-resort)
 *   - APP_RUNTIME_ENV in {production, preview, staging}
 *
 * A `NEXT_PUBLIC_*` variable is deliberately NOT trusted as the
 * controlling boundary — those are shipped to the client and can be
 * spoofed / edited. `NEXT_PUBLIC_APP_ENV` is CONSULTED as one signal but
 * cannot be the sole basis for allowing a fixture.
 *
 * A deployed process CANNOT opt back into fixture with an env flag.
 */
if (typeof window !== "undefined") {
  throw new Error("runtime/deployedRuntime is server-only.");
}

export type DeploymentPosture = {
  isDeployed: boolean;
  signals: string[];
};

/** Read from process.env dynamically so tests can override. */
function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

/**
 * Returns every deployment signal present. Callers that need a boolean
 * can use `.isDeployed`. Tests and audits can inspect `.signals`.
 */
export function detectDeploymentPosture(): DeploymentPosture {
  const signals: string[] = [];

  // --- Vercel
  const vercelEnv = env("VERCEL_ENV").toLowerCase();
  if (["production", "preview", "development-deploy"].includes(vercelEnv)) {
    signals.push(`VERCEL_ENV=${vercelEnv}`);
  }
  if (env("VERCEL") === "1" && vercelEnv !== "development" && vercelEnv !== "") {
    signals.push("VERCEL=1");
  }

  // --- Railway
  for (const k of ["RAILWAY_ENVIRONMENT", "RAILWAY_SERVICE_NAME", "RAILWAY_STATIC_URL", "RAILWAY_PROJECT_ID"]) {
    if (env(k)) signals.push(k);
  }

  // --- Fly.io
  for (const k of ["FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID", "FLY_REGION"]) {
    if (env(k)) signals.push(k);
  }

  // --- Render
  for (const k of ["RENDER", "RENDER_SERVICE_NAME", "RENDER_INSTANCE_ID", "RENDER_SERVICE_TYPE"]) {
    if (env(k)) signals.push(k);
  }

  // --- AWS (Lambda / ECS / EKS / Elastic Beanstalk)
  for (const k of [
    "AWS_LAMBDA_FUNCTION_NAME",
    "AWS_EXECUTION_ENV",
    "ECS_CONTAINER_METADATA_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
    "EB_ENVIRONMENT_NAME",
    "AWS_APP_RUNNER_SERVICE_ARN",
  ]) {
    if (env(k)) signals.push(k);
  }

  // --- Google Cloud (Cloud Run / GAE / Knative)
  for (const k of ["K_SERVICE", "CLOUD_RUN_JOB", "GAE_SERVICE", "GAE_APPLICATION"]) {
    if (env(k)) signals.push(k);
  }

  // --- Cloudflare
  for (const k of ["CF_PAGES", "CF_PAGES_URL", "CF_WORKER"]) {
    if (env(k)) signals.push(k);
  }

  // --- Netlify
  for (const k of ["NETLIFY", "DEPLOY_PRIME_URL", "NETLIFY_BUILD_BASE"]) {
    if (env(k)) signals.push(k);
  }

  // --- Heroku
  for (const k of ["HEROKU_APP_NAME", "HEROKU_APP_ID", "DYNO", "HEROKU_SLUG_COMMIT"]) {
    if (env(k)) signals.push(k);
  }

  // --- Kubernetes-generic
  if (env("KUBERNETES_SERVICE_HOST")) signals.push("KUBERNETES_SERVICE_HOST");

  // --- Repository-supported "APP_RUNTIME_ENV" marker (server-only)
  const appRuntime = env("APP_RUNTIME_ENV").toLowerCase();
  if (["production", "preview", "staging"].includes(appRuntime)) {
    signals.push(`APP_RUNTIME_ENV=${appRuntime}`);
  }

  // --- Consultative signal only — NEXT_PUBLIC_APP_ENV is client-shipped
  //     and is NOT the boundary on its own. We only accept it as a signal
  //     that ADDS TO an existing deployed posture; it can never allow
  //     fixture into a deployed process by being present alone.
  const publicAppEnv = env("NEXT_PUBLIC_APP_ENV").toLowerCase();
  if (["production", "preview", "staging"].includes(publicAppEnv) && signals.length > 0) {
    signals.push(`NEXT_PUBLIC_APP_ENV=${publicAppEnv} (consultative)`);
  }

  // --- Last-resort NODE_ENV=production. Real prod always sets this;
  //     but so do prod-build CI runs, so this is one signal, not proof.
  if (env("NODE_ENV").toLowerCase() === "production") {
    signals.push("NODE_ENV=production");
  }

  return { isDeployed: signals.length > 0, signals };
}

/**
 * Convenience boolean. Prefer `detectDeploymentPosture()` when you need
 * to report the signals for audit.
 */
export function isDeployedRuntime(): boolean {
  return detectDeploymentPosture().isDeployed;
}
