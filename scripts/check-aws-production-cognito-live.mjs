import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PRODUCTION_COGNITO_TARGET = Object.freeze({
  account: "173535830222",
  region: "us-east-2",
  stack: "ai-longevity-production-clinical-foundation",
  resources: ["ConsumerUserPool", "WorkforceUserPool"],
});

export function assertProductionObserver(identity) {
  if (identity?.Account !== PRODUCTION_COGNITO_TARGET.account
    || typeof identity?.Arn !== "string"
    || !/^arn:aws:sts::173535830222:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(identity.Arn)) {
    throw new Error("production_assumed_role_required");
  }
}

/** A narrow, read-only check of the deployed template's consumer email-verification promise.
 * Do not mistake this for a full Cognito drift scan or a registration-delivery test. */
export function assessPoolEmailVerification(template, stackResource, pool, resourceName) {
  if (!PRODUCTION_COGNITO_TARGET.resources.includes(resourceName)) throw new Error("pool_resource_unreviewed");
  const resource = template?.Resources?.[resourceName];
  if (resource?.Type !== "AWS::Cognito::UserPool") throw new Error("pool_template_missing");
  const declared = resource.Properties?.AutoVerifiedAttributes;
  if (!Array.isArray(declared) || declared.length !== 1 || declared[0] !== "email") {
    throw new Error("pool_template_email_verification_unreviewed");
  }
  const physicalId = stackResource?.StackResourceDetail?.PhysicalResourceId;
  if (typeof physicalId !== "string" || !/^us-east-2_[A-Za-z0-9]+$/.test(physicalId)
    || stackResource.StackResourceDetail.LogicalResourceId !== resourceName
    || pool?.Id !== physicalId) throw new Error("pool_identity_mismatch");
  const actual = pool.AutoVerifiedAttributes ?? [];
  if (!Array.isArray(actual) || actual.some(value => typeof value !== "string")) {
    throw new Error("pool_observation_invalid");
  }
  return {
    contract: "production-pool-email-verification-observation/1",
    account: PRODUCTION_COGNITO_TARGET.account,
    region: PRODUCTION_COGNITO_TARGET.region,
    stack: PRODUCTION_COGNITO_TARGET.stack,
    resourceName,
    poolId: physicalId,
    declared: ["email"],
    actual,
    status: actual.length === 1 && actual[0] === "email" ? "matches" : "drift",
    hostedRegistrationVerified: false,
    mutations: false,
  };
}

function observe(profile) {
  const aws = (...args) => JSON.parse(execFileSync("aws", [...args, "--profile", profile,
    "--region", PRODUCTION_COGNITO_TARGET.region, "--output", "json"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }));
  assertProductionObserver(aws("sts", "get-caller-identity"));
  const templateResponse = aws("cloudformation", "get-template", "--stack-name", PRODUCTION_COGNITO_TARGET.stack);
  const template = typeof templateResponse.TemplateBody === "string"
    ? JSON.parse(templateResponse.TemplateBody) : templateResponse.TemplateBody;
  const pools = PRODUCTION_COGNITO_TARGET.resources.map(resourceName => {
    const stackResource = aws("cloudformation", "describe-stack-resource", "--stack-name",
      PRODUCTION_COGNITO_TARGET.stack, "--logical-resource-id", resourceName);
    const physicalId = stackResource?.StackResourceDetail?.PhysicalResourceId;
    if (typeof physicalId !== "string" || !/^us-east-2_[A-Za-z0-9]+$/.test(physicalId)) {
      throw new Error("pool_identity_mismatch");
    }
    const pool = aws("cognito-idp", "describe-user-pool", "--user-pool-id", physicalId).UserPool;
    return assessPoolEmailVerification(template, stackResource, pool, resourceName);
  });
  return { contract: "production-email-verification-observation/2", account: PRODUCTION_COGNITO_TARGET.account,
    region: PRODUCTION_COGNITO_TARGET.region, stack: PRODUCTION_COGNITO_TARGET.stack,
    status: pools.every(pool => pool.status === "matches") ? "matches" : "drift", pools,
    hostedRegistrationVerified: false, mutations: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--profile" || !/^[A-Za-z0-9_-]{1,64}$/.test(process.argv[3])) {
    console.error("usage: node scripts/check-aws-production-cognito-live.mjs --profile <assumed-role-profile>");
    process.exitCode = 2;
  } else {
    try {
      const report = observe(process.argv[3]);
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "matches") process.exitCode = 1;
    } catch (error) {
      // AWS stderr can include account data. Emit only a bounded local refusal name.
      const allowed = new Set(["production_assumed_role_required", "pool_resource_unreviewed",
        "pool_template_missing", "pool_template_email_verification_unreviewed", "pool_identity_mismatch",
        "pool_observation_invalid"]);
      console.error(allowed.has(error?.message) ? error.message : "production_cognito_observation_failed");
      process.exitCode = 1;
    }
  }
}
