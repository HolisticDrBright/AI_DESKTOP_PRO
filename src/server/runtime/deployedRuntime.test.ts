import { afterEach, describe, expect, test } from "vitest";
import { detectDeploymentPosture, isDeployedRuntime } from "./deployedRuntime";

const KEYS = [
  "VERCEL_ENV",
  "VERCEL",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_SERVICE_NAME",
  "RAILWAY_STATIC_URL",
  "RAILWAY_PROJECT_ID",
  "FLY_APP_NAME",
  "FLY_MACHINE_ID",
  "FLY_ALLOC_ID",
  "FLY_REGION",
  "RENDER",
  "RENDER_SERVICE_NAME",
  "RENDER_INSTANCE_ID",
  "RENDER_SERVICE_TYPE",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_EXECUTION_ENV",
  "ECS_CONTAINER_METADATA_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
  "EB_ENVIRONMENT_NAME",
  "AWS_APP_RUNNER_SERVICE_ARN",
  "K_SERVICE",
  "CLOUD_RUN_JOB",
  "GAE_SERVICE",
  "GAE_APPLICATION",
  "CF_PAGES",
  "CF_PAGES_URL",
  "CF_WORKER",
  "NETLIFY",
  "DEPLOY_PRIME_URL",
  "NETLIFY_BUILD_BASE",
  "HEROKU_APP_NAME",
  "HEROKU_APP_ID",
  "DYNO",
  "HEROKU_SLUG_COMMIT",
  "KUBERNETES_SERVICE_HOST",
  "APP_RUNTIME_ENV",
  "NEXT_PUBLIC_APP_ENV",
  "NODE_ENV",
];

function clearAll() {
  for (const k of KEYS) delete process.env[k];
}

describe("deployedRuntime posture", () => {
  afterEach(() => clearAll());

  test("empty env is not deployed", () => {
    clearAll();
    expect(isDeployedRuntime()).toBe(false);
    expect(detectDeploymentPosture()).toEqual({ isDeployed: false, signals: [] });
  });

  test.each([
    ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
    ["VERCEL_ENV=preview", { VERCEL_ENV: "preview" }],
    ["RAILWAY_SERVICE_NAME", { RAILWAY_SERVICE_NAME: "app" }],
    ["FLY_APP_NAME", { FLY_APP_NAME: "clinical-app" }],
    ["FLY_MACHINE_ID", { FLY_MACHINE_ID: "m-123" }],
    ["RENDER=true", { RENDER: "true" }],
    ["AWS_LAMBDA_FUNCTION_NAME", { AWS_LAMBDA_FUNCTION_NAME: "fn" }],
    ["AWS_EXECUTION_ENV", { AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" }],
    ["ECS_CONTAINER_METADATA_URI", { ECS_CONTAINER_METADATA_URI: "http://169.254.170.2/v3/xxx" }],
    ["K_SERVICE (Cloud Run)", { K_SERVICE: "clinical" }],
    ["CF_PAGES", { CF_PAGES: "1" }],
    ["NETLIFY", { NETLIFY: "true" }],
    ["HEROKU_APP_NAME", { HEROKU_APP_NAME: "app" }],
    ["DYNO", { DYNO: "web.1" }],
    ["KUBERNETES_SERVICE_HOST", { KUBERNETES_SERVICE_HOST: "10.0.0.1" }],
    ["APP_RUNTIME_ENV=production", { APP_RUNTIME_ENV: "production" }],
    ["APP_RUNTIME_ENV=preview", { APP_RUNTIME_ENV: "preview" }],
    ["APP_RUNTIME_ENV=staging", { APP_RUNTIME_ENV: "staging" }],
    ["NODE_ENV=production", { NODE_ENV: "production" }],
  ])("detects deployed: %s", (_label, envs) => {
    clearAll();
    for (const [k, v] of Object.entries(envs)) process.env[k] = v;
    const p = detectDeploymentPosture();
    expect(p.isDeployed).toBe(true);
    expect(p.signals.length).toBeGreaterThan(0);
  });

  test("NEXT_PUBLIC_APP_ENV alone is NOT deployed (client-shipped signal, not the boundary)", () => {
    clearAll();
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    expect(isDeployedRuntime()).toBe(false);
  });

  test("APP_RUNTIME_ENV=development is not deployed", () => {
    clearAll();
    process.env.APP_RUNTIME_ENV = "development";
    expect(isDeployedRuntime()).toBe(false);
  });

  test("VERCEL_ENV=development is not deployed", () => {
    clearAll();
    process.env.VERCEL_ENV = "development";
    expect(isDeployedRuntime()).toBe(false);
  });
});
