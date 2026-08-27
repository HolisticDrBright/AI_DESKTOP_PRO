import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const template = JSON.parse(readFileSync(resolve(process.argv[2] ?? "infra/aws-clinical-core/production-readiness-workload.json"), "utf8"));
const resources = template.Resources ?? {};
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };
const serialized = JSON.stringify(template);

assert(template.Metadata?.ClinicalCore?.Mode === "readiness_only", "workload mode must be readiness_only");
assert(template.Metadata?.ClinicalCore?.ContainsPhi === false, "workload must declare ContainsPhi=false");
assert(template.Metadata?.ClinicalCore?.PhiActivation === "blocked", "PHI activation must remain blocked");
assert(template.Outputs?.PhiAllowed?.Value === "false", "PhiAllowed output must be false");
assert(!/(supabase|fly\.io|fly\.dev|app.?runner)/i.test(serialized), "legacy providers and App Runner are forbidden");
assert(!/PHI_ACTIVATION|PRODUCTION_READINESS_EVIDENCE_SHA256/.test(serialized), "activation material is forbidden");
assert(!Object.values(resources).some((r) => ["AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::ApiGatewayV2::Api", "AWS::AppRunner::Service"].includes(r.Type)), "readiness workload must not be public");

for (const id of ["EcrApiEndpoint", "EcrDockerEndpoint", "LogsEndpoint", "S3Endpoint"]) {
  assert(resources[id]?.Type === "AWS::EC2::VPCEndpoint", `${id} is required`);
}
assert(resources.RuntimeLogGroup?.Properties?.RetentionInDays === 365, "runtime logs must retain 365 days");
assert(Boolean(resources.RuntimeLogGroup?.Properties?.KmsKeyId?.Ref), "runtime logs must use the clinical KMS key");
assert(resources.ReadinessTaskRole?.Properties?.Policies === undefined, "readiness task role must have no permissions");

const task = resources.ReadinessTaskDefinition;
assert(task?.Condition === "ShouldDeployService", "task definition must require explicit DeployService=true");
const container = task?.Properties?.ContainerDefinitions?.[0] ?? {};
const env = Object.fromEntries((container.Environment ?? []).map(({ Name, Value }) => [Name, Value]));
assert(env.PRODUCTION_WORKLOAD_MODE === "readiness_only", "container must be readiness_only");
assert(env.PHI_ALLOWED === "false", "container PHI_ALLOWED must be false");
assert(env.AWS_CLINICAL_ADAPTER_READY === "false", "incomplete adapter must remain false");
assert(container.ReadonlyRootFilesystem === true, "container root filesystem must be read-only");
assert(container.User === "65532", "container must run as distroless nonroot");
assert(container.LinuxParameters?.Capabilities?.Drop?.includes("ALL"), "container must drop all Linux capabilities");
assert(!container.Secrets, "readiness container must receive no secrets");
assert(JSON.stringify(container.HealthCheck?.Command ?? []).includes("/api/health"), "container health check must use the bounded health route");

const service = resources.ReadinessService;
assert(service?.Condition === "ShouldDeployService", "service must require explicit DeployService=true");
assert(service?.Properties?.DesiredCount === 1, "service must run exactly one readiness task");
assert(service?.Properties?.NetworkConfiguration?.AwsvpcConfiguration?.AssignPublicIp === "DISABLED", "public IPs must be disabled");
assert(service?.Properties?.EnableExecuteCommand === false, "ECS Exec must remain disabled");
assert(resources.ReadinessRunningTaskAlarm?.Condition === "ShouldDeployService", "running-task alarm is required");
assert(template.Outputs?.EndpointSecurityGroupId?.Value?.Ref === "EndpointSecurityGroup", "private endpoint security group output is required for the patient readiness task");

const buildspec = resources.ImageBuildProject?.Properties?.Source?.BuildSpec?.["Fn::Sub"] ?? "";
assert(buildspec.includes("git checkout --detach ${SourceVersion}"), "build must pin the exact source commit");
assert(buildspec.includes("Dockerfile.production"), "build must use the hardened production Dockerfile");
assert(buildspec.includes("PHI_ALLOWED=false"), "build smoke test must disable PHI");
assert(buildspec.includes("PRODUCTION_WORKLOAD_MODE=readiness_only"), "build smoke test must use readiness mode");
assert(buildspec.includes("production_not_activated"), "build smoke test must prove non-health routes refuse access");

const middleware = readFileSync(resolve("src/middleware.ts"), "utf8");
assert(middleware.includes('PRODUCTION_WORKLOAD_MODE === "readiness_only"'), "middleware readiness boundary is required");
assert(middleware.includes('error: "production_not_activated", phiAllowed: false'), "middleware must return the bounded refusal envelope");

if (errors.length) {
  for (const error of errors) console.error(`AWS production readiness workload check failed: ${error}`);
  process.exitCode = 1;
} else {
  console.log("AWS production readiness workload check passed: private, PHI-disabled, exact-image runtime boundary verified.");
}
