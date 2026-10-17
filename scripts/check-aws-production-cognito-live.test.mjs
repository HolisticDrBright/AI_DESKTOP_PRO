import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertProductionObserver, assessConsumerEmailVerification } from "./check-aws-production-cognito-live.mjs";

const template = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/template.json", import.meta.url), "utf8"));
const stackResource = { StackResourceDetail: {
  LogicalResourceId: "ConsumerUserPool", PhysicalResourceId: "us-east-2_kl37QO1DJ",
} };
const pool = { Id: "us-east-2_kl37QO1DJ", AutoVerifiedAttributes: ["email"] };

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
  assert.deepEqual(assessConsumerEmailVerification(template, stackResource, pool), {
    contract: "production-consumer-email-verification-observation/1", account: "173535830222",
    region: "us-east-2", stack: "ai-longevity-production-clinical-foundation",
    poolId: "us-east-2_kl37QO1DJ", declared: ["email"], actual: ["email"],
    status: "matches", hostedRegistrationVerified: false, mutations: false,
  });
});

test("live missing auto-verification is drift, never a registration pass", () => {
  const report = assessConsumerEmailVerification(template, stackResource,
    { ...pool, AutoVerifiedAttributes: null });
  assert.equal(report.status, "drift");
  assert.equal(report.hostedRegistrationVerified, false);
  assert.deepEqual(report.actual, []);
  assert.equal(assessConsumerEmailVerification(template, stackResource,
    { ...pool, AutoVerifiedAttributes: ["phone_number"] }).status, "drift");
});

test("a changed template promise, wrong pool, or malformed response refuses", () => {
  const changed = structuredClone(template);
  changed.Resources.ConsumerUserPool.Properties.AutoVerifiedAttributes = [];
  assert.throws(() => assessConsumerEmailVerification(changed, stackResource, pool),
    /consumer_pool_template_email_verification_unreviewed/);
  assert.throws(() => assessConsumerEmailVerification(template, stackResource,
    { ...pool, Id: "us-east-2_other" }), /consumer_pool_identity_mismatch/);
  assert.throws(() => assessConsumerEmailVerification(template, stackResource,
    { ...pool, AutoVerifiedAttributes: "email" }), /consumer_pool_observation_invalid/);
});
