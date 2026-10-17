import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertProductionObserver, assessPoolEmailVerification,
  assessSourceTemplate, summarizePoolObservations } from "./check-aws-production-cognito-live.mjs";

const template = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/template.json", import.meta.url), "utf8"));
const consumerResource = { StackResourceDetail: {
  LogicalResourceId: "ConsumerUserPool", PhysicalResourceId: "us-east-2_kl37QO1DJ",
} };
const consumer = { Id: "us-east-2_kl37QO1DJ", AutoVerifiedAttributes: ["email"] };
const workforceResource = { StackResourceDetail: {
  LogicalResourceId: "WorkforceUserPool", PhysicalResourceId: "us-east-2_AZMa5gxSZ",
} };
const workforce = { Id: "us-east-2_AZMa5gxSZ", AutoVerifiedAttributes: ["email"] };

test("only the pinned production assumed-role account can observe", () => {
  assert.doesNotThrow(() => assertProductionObserver({ Account: "173535830222",
    Arn: "arn:aws:sts::173535830222:assumed-role/ProductionReview/session" }));
  for (const identity of [
    { Account: "588966314750", Arn: "arn:aws:sts::588966314750:assumed-role/Review/session" },
    { Account: "173535830222", Arn: "arn:aws:iam::173535830222:root" },
    { Account: "173535830222", Arn: "arn:aws:iam::173535830222:user/admin" },
  ]) assert.throws(() => assertProductionObserver(identity), /production_assumed_role_required/);
});

test("matching live auto-verification is a narrow configuration observation", () => {
  assert.deepEqual(assessPoolEmailVerification(template, consumerResource, consumer, "ConsumerUserPool"), {
    contract: "production-pool-email-verification-observation/3", account: "173535830222",
    region: "us-east-2", stack: "ai-longevity-production-clinical-foundation",
    resourceName: "ConsumerUserPool", poolId: "us-east-2_kl37QO1DJ", declared: ["email"], actual: ["email"],
    status: "matches", unmodeledLiveSettings: [], mismatchedLiveSettings: [], templateReapplyApproved: false,
    hostedRegistrationVerified: false, mutations: false,
  });
});

test("restoring email verification alone cannot green an unsafe older template", () => {
  const report = assessPoolEmailVerification(template, consumerResource, {
    ...consumer,
    EmailConfiguration: { EmailSendingAccount: "DEVELOPER", SourceArn: "arn:aws:ses:us-east-2:173535830222:identity/example.test" },
    UserPoolTier: "PLUS",
  }, "ConsumerUserPool");
  assert.equal(report.status, "review_required");
  assert.deepEqual(report.unmodeledLiveSettings, ["EmailConfiguration", "UserPoolTier"]);
  assert.deepEqual(report.mismatchedLiveSettings, []);
  assert.equal(report.templateReapplyApproved, false);
  assert.equal(report.hostedRegistrationVerified, false);
  assert.equal(summarizePoolObservations([
    report,
    { ...report, resourceName: "WorkforceUserPool" },
  ]), "review_required");
});

test("approved live copy and enforced advanced security also require preserving review", () => {
  const live = { ...consumer, VerificationMessageTemplate: {
    EmailMessage: "Your approved code is {####}.", DefaultEmailOption: "CONFIRM_WITH_CODE",
  }, AdminCreateUserConfig: { AllowAdminCreateUserOnly: false, UnusedAccountValidityDays: 1 },
  UserPoolAddOns: { AdvancedSecurityMode: "ENFORCED" },
  Policies: { SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD"] } } };
  const missing = assessPoolEmailVerification(template, consumerResource, live, "ConsumerUserPool");
  assert.equal(missing.status, "review_required");
  assert.deepEqual(missing.unmodeledLiveSettings,
    ["VerificationMessageTemplate", "AdminCreateUserConfig", "UserPoolAddOns", "Policies.SignInPolicy"]);
  const wrong = structuredClone(template);
  wrong.Resources.ConsumerUserPool.Properties.VerificationMessageTemplate = { EmailMessage: "Changed code" };
  wrong.Resources.ConsumerUserPool.Properties.UserPoolAddOns = { AdvancedSecurityMode: "OFF" };
  const mismatched = assessPoolEmailVerification(wrong, consumerResource, live, "ConsumerUserPool");
  assert.equal(mismatched.status, "review_required");
  assert.deepEqual(mismatched.mismatchedLiveSettings, ["VerificationMessageTemplate", "UserPoolAddOns"]);
});

test("overall observer refuses incomplete evidence and preserves the strongest hold", () => {
  const consumerReport = assessPoolEmailVerification(template, consumerResource, consumer, "ConsumerUserPool");
  const workforceReport = assessPoolEmailVerification(template, workforceResource, workforce, "WorkforceUserPool");
  assert.equal(summarizePoolObservations([consumerReport, workforceReport]), "matches");
  assert.equal(summarizePoolObservations([{ ...consumerReport, status: "drift" }, workforceReport]), "drift");
  assert.throws(() => summarizePoolObservations([consumerReport]), /pool_observation_invalid/);
  assert.throws(() => summarizePoolObservations([workforceReport, consumerReport]), /pool_observation_invalid/);
});

test("the older repository template cannot be mistaken for the deployed template", () => {
  const equivalent = structuredClone(template);
  equivalent.Resources = Object.fromEntries(Object.entries(equivalent.Resources).reverse());
  assert.equal(assessSourceTemplate(template, equivalent).status, "matches");
  const deployed = structuredClone(template);
  deployed.Resources.ConsumerUserPool.Properties.UserPoolAddOns = { AdvancedSecurityMode: "ENFORCED" };
  const result = assessSourceTemplate(template, deployed);
  assert.equal(result.status, "drift");
  assert.match(result.localSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(result.localSha256, result.deployedSha256);
  assert.throws(() => assessSourceTemplate({}, deployed), /pool_template_missing/);
});

test("live missing auto-verification is drift, never a registration pass", () => {
  const report = assessPoolEmailVerification(template, consumerResource,
    { ...consumer, AutoVerifiedAttributes: null }, "ConsumerUserPool");
  assert.equal(report.status, "drift");
  assert.equal(report.hostedRegistrationVerified, false);
  assert.deepEqual(report.actual, []);
  assert.equal(assessPoolEmailVerification(template, consumerResource,
    { ...consumer, AutoVerifiedAttributes: ["phone_number"] }, "ConsumerUserPool").status, "drift");
});

test("workforce sign-up email verification is independently checked", () => {
  assert.equal(assessPoolEmailVerification(template, workforceResource,
    { ...workforce, AutoVerifiedAttributes: null }, "WorkforceUserPool").status, "drift");
  assert.equal(assessPoolEmailVerification(template, workforceResource,
    workforce, "WorkforceUserPool").status, "matches");
});

test("a changed template promise, wrong pool, or malformed response refuses", () => {
  const changed = structuredClone(template);
  changed.Resources.ConsumerUserPool.Properties.AutoVerifiedAttributes = [];
  assert.throws(() => assessPoolEmailVerification(changed, consumerResource, consumer, "ConsumerUserPool"),
    /pool_template_email_verification_unreviewed/);
  assert.throws(() => assessPoolEmailVerification(template, consumerResource,
    { ...consumer, Id: "us-east-2_other" }, "ConsumerUserPool"), /pool_identity_mismatch/);
  assert.throws(() => assessPoolEmailVerification(template, consumerResource,
    { ...consumer, AutoVerifiedAttributes: "email" }, "ConsumerUserPool"), /pool_observation_invalid/);
  assert.throws(() => assessPoolEmailVerification(template, consumerResource, consumer, "OtherPool"),
    /pool_resource_unreviewed/);
});
