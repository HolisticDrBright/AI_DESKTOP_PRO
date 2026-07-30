/**
 * The deterministic contract fixture is TEST INFRASTRUCTURE ONLY.
 *
 * Any recognizable deployed environment refuses fixture mode, and there is
 * deliberately NO override flag — an environment variable is never security
 * or compliance approval.
 */
import { SyncError } from "./errors.mjs";

const DEPLOYED_MARKERS = [
  "RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID",
  "FLY_APP_NAME", "FLY_MACHINE_ID",
  "VERCEL", "VERCEL_ENV", "NOW_REGION",
  "RENDER", "RENDER_SERVICE_ID",
  "HEROKU_APP_NAME", "DYNO",
  "K_SERVICE", "GAE_ENV", "AWS_EXECUTION_ENV", "ECS_CONTAINER_METADATA_URI",
  "AZURE_FUNCTIONS_ENVIRONMENT", "WEBSITE_INSTANCE_ID",
  "KUBERNETES_SERVICE_HOST",
  "DEPLOYMENT_ENV", "DEPLOY_ENV",
];

export function deployedMarker(env = process.env) {
  if (env.NODE_ENV === "production") return "NODE_ENV=production";
  for (const marker of DEPLOYED_MARKERS) {
    if (env[marker] !== undefined && env[marker] !== "") return marker;
  }
  return null;
}

/** Throws SyncError('security', 'fixture_refused_deployed') when deployed. */
export function assertFixtureAllowed(env = process.env) {
  const marker = deployedMarker(env);
  if (marker) {
    throw new SyncError(
      "security",
      "fixture_refused_deployed",
      `the deterministic contract fixture refuses to run in a deployed environment (${marker}); there is no override`,
    );
  }
  return true;
}
