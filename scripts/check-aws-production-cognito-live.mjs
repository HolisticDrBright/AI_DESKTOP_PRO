import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

/** A narrow, read-only check of the deployed template's email-verification promise
 * and known live settings a repair must preserve. This is not a full Cognito drift
 * scan, a safe-to-reapply verdict or a registration-delivery test. */
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
  // This is not a general CloudFormation drift check. In particular, do not return
  // an overall green observation while the deployed template omits intentional
  // live email delivery or pool-tier settings that a repair must preserve.
  const unmodeledLiveSettings = [], mismatchedLiveSettings = [];
  const review = (name, liveIsMaterial, modeled, matches) => {
    if (!liveIsMaterial) return;
    if (modeled === undefined) unmodeledLiveSettings.push(name);
    else if (!matches(modeled)) mismatchedLiveSettings.push(name);
  };
  review("EmailConfiguration", pool.EmailConfiguration?.EmailSendingAccount === "DEVELOPER",
    resource.Properties?.EmailConfiguration,
    value => value.EmailSendingAccount === pool.EmailConfiguration.EmailSendingAccount
      && value.SourceArn === pool.EmailConfiguration.SourceArn
      && value.From === pool.EmailConfiguration.From);
  review("UserPoolTier", pool.UserPoolTier === "PLUS", resource.Properties?.UserPoolTier,
    value => value === pool.UserPoolTier);
  review("VerificationMessageTemplate", typeof pool.VerificationMessageTemplate?.EmailMessage === "string",
    resource.Properties?.VerificationMessageTemplate,
    value => value.EmailMessage === pool.VerificationMessageTemplate.EmailMessage
      && value.DefaultEmailOption === pool.VerificationMessageTemplate.DefaultEmailOption);
  review("AdminCreateUserConfig", !!pool.AdminCreateUserConfig,
    resource.Properties?.AdminCreateUserConfig,
    value => value.AllowAdminCreateUserOnly === pool.AdminCreateUserConfig.AllowAdminCreateUserOnly
      && value.UnusedAccountValidityDays === pool.AdminCreateUserConfig.UnusedAccountValidityDays
      && value.InviteMessageTemplate?.EmailMessage === pool.AdminCreateUserConfig.InviteMessageTemplate?.EmailMessage);
  review("UserPoolAddOns", pool.UserPoolAddOns?.AdvancedSecurityMode === "ENFORCED",
    resource.Properties?.UserPoolAddOns,
    value => value.AdvancedSecurityMode === "ENFORCED");
  review("Policies.SignInPolicy", Array.isArray(pool.Policies?.SignInPolicy?.AllowedFirstAuthFactors),
    resource.Properties?.Policies?.SignInPolicy,
    value => JSON.stringify(value.AllowedFirstAuthFactors) === JSON.stringify(pool.Policies.SignInPolicy.AllowedFirstAuthFactors));
  const emailVerificationMatches = actual.length === 1 && actual[0] === "email";
  return {
    contract: "production-pool-email-verification-observation/3",
    account: PRODUCTION_COGNITO_TARGET.account,
    region: PRODUCTION_COGNITO_TARGET.region,
    stack: PRODUCTION_COGNITO_TARGET.stack,
    resourceName,
    poolId: physicalId,
    declared: ["email"],
    actual,
    status: !emailVerificationMatches ? "drift"
      : unmodeledLiveSettings.length > 0 || mismatchedLiveSettings.length > 0 ? "review_required" : "matches",
    unmodeledLiveSettings,
    mismatchedLiveSettings,
    templateReapplyApproved: false,
    hostedRegistrationVerified: false,
    mutations: false,
  };
}

export function summarizePoolObservations(pools) {
  if (!Array.isArray(pools) || pools.length !== PRODUCTION_COGNITO_TARGET.resources.length
    || pools.some((pool, index) => pool?.resourceName !== PRODUCTION_COGNITO_TARGET.resources[index]
      || !["matches", "drift", "review_required"].includes(pool.status))) {
    throw new Error("pool_observation_invalid");
  }
  return pools.some(pool => pool.status === "drift") ? "drift"
    : pools.some(pool => pool.status === "review_required") ? "review_required" : "matches";
}

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** A source template is not the deployed template merely because their resource names match. */
export function assessSourceTemplate(localTemplate, deployedTemplate) {
  for (const name of PRODUCTION_COGNITO_TARGET.resources) {
    if (localTemplate?.Resources?.[name]?.Type !== "AWS::Cognito::UserPool"
      || deployedTemplate?.Resources?.[name]?.Type !== "AWS::Cognito::UserPool") {
      throw new Error("pool_template_missing");
    }
  }
  const sha = template => createHash("sha256").update(JSON.stringify(canonical(template))).digest("hex");
  const localSha256 = sha(localTemplate), deployedSha256 = sha(deployedTemplate);
  return { localSha256, deployedSha256, status: localSha256 === deployedSha256 ? "matches" : "drift" };
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
  const localTemplate = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/template.json", import.meta.url), "utf8"));
  const sourceTemplate = assessSourceTemplate(localTemplate, template);
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
  return { contract: "production-email-verification-observation/4", account: PRODUCTION_COGNITO_TARGET.account,
    region: PRODUCTION_COGNITO_TARGET.region, stack: PRODUCTION_COGNITO_TARGET.stack,
    status: summarizePoolObservations(pools) === "matches" && sourceTemplate.status === "drift"
      ? "review_required" : summarizePoolObservations(pools), pools, sourceTemplate,
    templateReapplyApproved: false,
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
