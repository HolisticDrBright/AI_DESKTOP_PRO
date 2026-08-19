if (typeof window !== "undefined") {
  throw new Error("server/runtime/awsProductionGate is server-only.");
}

const PRODUCTION_RUNTIME = "production-clinical";
const PRODUCTION_DATA_PLANE = "aws_production";

const required = [
  "CLINICAL_AWS_REGION",
  "CLINICAL_AWS_API_ORIGIN",
  "CLINICAL_AWS_ALLOWED_API_HOSTS",
  "CLINICAL_AWS_WORKFORCE_USER_POOL_ID",
  "CLINICAL_AWS_WORKFORCE_CLIENT_ID",
  "CLINICAL_AWS_CONSUMER_USER_POOL_ID",
  "CLINICAL_AWS_CONSUMER_CLIENT_ID",
  "AWS_CLINICAL_ADAPTER_READY",
  "PHI_ALLOWED",
] as const;

const forbidden = [
  "CLINICAL_SUPABASE_URL",
  "CLINICAL_SUPABASE_ANON_KEY",
  "CLINICAL_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SYNC_SUPABASE_URL",
  "SYNC_SUPABASE_SERVICE_ROLE_KEY",
  "SYNC_WORKER_SUPABASE_URL",
  "SYNC_WORKER_SERVICE_ROLE_KEY",
  "CLINICAL_CONTRACT_FIXTURE",
  "CLINICAL_DEMO_EMAIL",
  "CLINICAL_DEMO_PASSWORD",
  "FLY_APP_NAME",
  "FLY_REGION",
  "AWS_APPRUNNER_SERVICE_ARN",
] as const;

export type AwsProductionRuntimeReport = {
  active: boolean;
  ready: boolean;
  phiAllowed: boolean;
  blockers: string[];
};

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function value(env: RuntimeEnvironment, name: string): string {
  return String(env[name] ?? "").trim();
}

export function inspectAwsProductionRuntime(env: RuntimeEnvironment = process.env): AwsProductionRuntimeReport {
  const active = value(env, "APP_RUNTIME_ENV") === PRODUCTION_RUNTIME
    || value(env, "CLINICAL_DATA_PLANE") === PRODUCTION_DATA_PLANE;
  if (!active) return { active: false, ready: true, phiAllowed: false, blockers: [] };

  const blockers = [];
  if (value(env, "APP_RUNTIME_ENV") !== PRODUCTION_RUNTIME) blockers.push("APP_RUNTIME_ENV");
  if (value(env, "CLINICAL_DATA_PLANE") !== PRODUCTION_DATA_PLANE) blockers.push("CLINICAL_DATA_PLANE");
  if (value(env, "CLINICAL_COMPUTE") !== "ecs_fargate") blockers.push("CLINICAL_COMPUTE");
  for (const name of required) if (!value(env, name)) blockers.push(name);
  for (const name of forbidden) if (value(env, name)) blockers.push(`forbidden:${name}`);

  const apiOrigin = value(env, "CLINICAL_AWS_API_ORIGIN");
  const allowedHosts = value(env, "CLINICAL_AWS_ALLOWED_API_HOSTS")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  try {
    const api = new URL(apiOrigin);
    if (api.protocol !== "https:" || !allowedHosts.includes(api.hostname.toLowerCase())) {
      blockers.push("CLINICAL_AWS_API_ORIGIN_ALLOWLIST");
    }
  } catch {
    blockers.push("CLINICAL_AWS_API_ORIGIN_ALLOWLIST");
  }

  if (value(env, "AWS_CLINICAL_ADAPTER_READY") !== "true") blockers.push("AWS_CLINICAL_ADAPTER_READY");
  const phi = value(env, "PHI_ALLOWED");
  if (phi !== "false" && phi !== "true") blockers.push("PHI_ALLOWED");
  const phiAllowed = phi === "true";
  if (phiAllowed) {
    if (value(env, "PHI_ACTIVATION") !== "approved") blockers.push("PHI_ACTIVATION");
    if (!/^[a-f0-9]{64}$/i.test(value(env, "PRODUCTION_READINESS_EVIDENCE_SHA256"))) {
      blockers.push("PRODUCTION_READINESS_EVIDENCE_SHA256");
    }
  }

  return { active, ready: blockers.length === 0, phiAllowed, blockers: [...new Set(blockers)] };
}

export function assertAwsProductionRuntime(env: RuntimeEnvironment = process.env): void {
  const report = inspectAwsProductionRuntime(env);
  if (!report.ready) {
    throw new Error(`AWS production runtime refused. Open blockers: ${report.blockers.join(", ")}`);
  }
}
