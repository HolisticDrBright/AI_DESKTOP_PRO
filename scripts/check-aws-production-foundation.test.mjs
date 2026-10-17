import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";
import { validateProductionFoundation } from "./check-aws-production-foundation.mjs";

const source = JSON.parse(readFileSync(resolve("infra/aws-clinical-core/template.json"), "utf8"));
const production = buildProductionFoundation(source);

assert.deepEqual(validateProductionFoundation(production), []);
for (const poolName of ["WorkforceUserPool", "ConsumerUserPool"]) {
  assert.equal(production.Resources[poolName].Properties.Schema.filter((attribute) => attribute.Name === "production_bound").length, 1,
    `${poolName} must declare the production-bound attribute exactly once`);
  const duplicate = structuredClone(production);
  duplicate.Resources[poolName].Properties.Schema.push(structuredClone(
    duplicate.Resources[poolName].Properties.Schema.find((attribute) => attribute.Name === "production_bound"),
  ));
  assert(validateProductionFoundation(duplicate).some((error) => error.includes(`${poolName} schema attributes must be unique`)));
}
for (const clientName of ["WorkforceUserPoolClient", "ConsumerUserPoolClient"]) {
  assert(!production.Resources[clientName].Properties.ReadAttributes.includes("custom:synthetic_attested"),
    `${clientName} must not read a synthetic-only attribute absent from its production pool`);
  const syntheticRead = structuredClone(production);
  syntheticRead.Resources[clientName].Properties.ReadAttributes.push("custom:synthetic_attested");
  assert(validateProductionFoundation(syntheticRead).some((error) => error.includes(`${clientName} must not read synthetic-only attributes`)));
}
const approvedCode = "Your AI Longevity Pro code is {####}. Enter it in the app to complete the request. Do not share this code.";
const approvedInvite = "Your sign-in username is {username} and your temporary password is {####}. Sign in and change the password when prompted.";
for (const poolName of ["WorkforceUserPool", "ConsumerUserPool"]) {
  const pool = production.Resources[poolName].Properties;
  assert.equal(pool.UserPoolTier, "PLUS", `${poolName} must preserve its observed Plus tier`);
  assert.deepEqual(pool.Policies?.SignInPolicy?.AllowedFirstAuthFactors, ["PASSWORD"],
    `${poolName} must preserve password-first sign-in`);
  assert.equal(pool.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays, 1,
    `${poolName} must preserve the one-day temporary password window`);
  assert.equal(pool.AdminCreateUserConfig?.UnusedAccountValidityDays, undefined,
    `${poolName} must not combine the obsolete validity field with the password policy`);
  assert.equal(pool.EmailConfiguration?.EmailSendingAccount, "DEVELOPER");
  assert.equal(pool.EmailConfiguration?.SourceArn?.["Fn::Sub"],
    "arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:identity/ailongevitypro.app");
  assert.equal(pool.EmailConfiguration?.From, "AI Longevity Pro <info@AILongevityPro.app>");
  assert.equal(pool.EmailConfiguration?.ReplyToEmailAddress, "info@AILongevityPro.app");
  assert.equal(pool.EmailConfiguration?.ConfigurationSet, "alp-transactional");
  assert.deepEqual(pool.VerificationMessageTemplate,
    { DefaultEmailOption: "CONFIRM_WITH_CODE", EmailMessage: approvedCode });
  assert.equal(pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly, false);
  const stale = structuredClone(production);
  stale.Resources[poolName].Properties.VerificationMessageTemplate.EmailMessage = "Outdated {####}";
  assert(validateProductionFoundation(stale).some((error) => error.includes(`${poolName} approved code message`)));
  for (const [change, expected] of [
    [draft => { delete draft.Resources[poolName].Properties.UserPoolTier; }, "Plus tier"],
    [draft => { delete draft.Resources[poolName].Properties.Policies.SignInPolicy; }, "password-first sign-in"],
    [draft => { draft.Resources[poolName].Properties.Policies.PasswordPolicy.TemporaryPasswordValidityDays = 7; }, "one-day temporary password"],
    [draft => { draft.Resources[poolName].Properties.AdminCreateUserConfig.UnusedAccountValidityDays = 1; }, "obsolete validity field"],
  ]) {
    const changed = structuredClone(production);
    change(changed);
    assert(validateProductionFoundation(changed).some(error => error.includes(`${poolName} ${expected}`)));
  }
}
assert.equal(production.Resources.WorkforceUserPool.Properties.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage, approvedInvite);
const staleInvite = structuredClone(production);
staleInvite.Resources.WorkforceUserPool.Properties.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage = "Outdated {####}";
assert(validateProductionFoundation(staleInvite).some((error) => error.includes("WorkforceUserPool approved invitation message")));

const enabled = structuredClone(production);
enabled.Outputs.PhiAllowed.Value = "true";
assert(validateProductionFoundation(enabled).some((error) => error.includes("PhiAllowed")));

const appRunner = structuredClone(production);
appRunner.Resources.ForbiddenRuntime = { Type: "AWS::AppRunner::Service", Properties: {} };
assert(validateProductionFoundation(appRunner).some((error) => error.includes("App Runner")));

const supabase = structuredClone(production);
supabase.Parameters.LegacyUrl = { Type: "String", Default: "https://example.supabase.co" };
assert(validateProductionFoundation(supabase).some((error) => error.includes("Supabase")));

const missingLogsKeyPolicy = structuredClone(production);
missingLogsKeyPolicy.Resources.ClinicalCoreKey.Properties.KeyPolicy.Statement = missingLogsKeyPolicy.Resources.ClinicalCoreKey.Properties.KeyPolicy.Statement.filter((statement) => statement.Sid !== "CloudWatchLogsEncryption");
assert(validateProductionFoundation(missingLogsKeyPolicy).some((error) => error.includes("CloudWatch Logs")));

const missingLogDependency = structuredClone(production);
delete missingLogDependency.Resources.ClinicalApiStage.DependsOn;
assert(validateProductionFoundation(missingLogDependency).some((error) => error.includes("access log destination")));

const objectLockedConfigBucket = structuredClone(production);
objectLockedConfigBucket.Resources.ConfigDeliveryBucket.Properties.ObjectLockEnabled = true;
assert(validateProductionFoundation(objectLockedConfigBucket).some((error) => error.includes("must not enable Object Lock")));

const missingConfigKms = structuredClone(production);
delete missingConfigKms.Resources.ConfigDeliveryChannel.Properties.S3KmsKeyArn;
assert(validateProductionFoundation(missingConfigKms).some((error) => error.includes("delivery must use AuditKey")));

const missingGuardDutyRds = structuredClone(production);
missingGuardDutyRds.Resources.GuardDutyDetector.Properties.Features = missingGuardDutyRds.Resources.GuardDutyDetector.Properties.Features
  .filter((feature) => feature.Name !== "RDS_LOGIN_EVENTS");
assert(validateProductionFoundation(missingGuardDutyRds).some((error) => error.includes("six reviewed production protection plans")));

const conflictingGuardDutyRuntime = structuredClone(production);
conflictingGuardDutyRuntime.Resources.GuardDutyDetector.Properties.Features.push({
  Name: "EKS_RUNTIME_MONITORING", Status: "DISABLED",
});
assert(validateProductionFoundation(conflictingGuardDutyRuntime).some((error) => error.includes("alongside Runtime Monitoring")));

const stalePostureVersion = structuredClone(production);
stalePostureVersion.Resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_CONTRACT_VERSION = "clinical-core/1";
assert(validateProductionFoundation(stalePostureVersion).some((error) => error.includes("posture endpoint must report clinical-core/2")));

const broadBillingPermission = structuredClone(production);
broadBillingPermission.Resources.DesktopProductionTaskRole.Properties.Policies[0].PolicyDocument.Statement[0].Action = ["dynamodb:*"];
assert(validateProductionFoundation(broadBillingPermission).some((error) => error.includes("only write billing ledger")));

const unprotectedBillingLedger = structuredClone(production);
unprotectedBillingLedger.Resources.BillingLedger.Properties.DeletionProtectionEnabled = false;
assert(validateProductionFoundation(unprotectedBillingLedger).some((error) => error.includes("deletion protection")));

console.log("AWS production foundation fail-closed checks passed.");
