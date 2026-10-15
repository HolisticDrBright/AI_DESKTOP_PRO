import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateGovernedCatalogApi } from "./check-aws-governed-catalog-api.mjs";

const foundation = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/template.json", import.meta.url), "utf8"));
const extension = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/catalog-api-extension.json", import.meta.url), "utf8"));

test("reviewed catalog alert is opt-in and passes the template gate", () => {
  assert.deepEqual(validateGovernedCatalogApi(foundation, extension), []);
});

test("catalog read allows the synthetic Aurora auto-resume to finish before the HTTP deadline", () => {
  assert.equal(extension.Resources.CatalogApiFunction.Properties.Timeout, 29);
  assert.equal(extension.Resources.CatalogApiIntegration.Properties.TimeoutInMillis, 30000);
});

for (const [name, mutate] of [
  ["topic default enabled", (copy) => { copy.Parameters.QualificationAlarmTopicArn.Default = "arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms"; }],
  ["topic target widened", (copy) => { copy.Parameters.QualificationAlarmTopicArn.AllowedPattern = ".*"; }],
  ["account fence removed", (copy) => { copy.Conditions.SyntheticQualificationAlerting["Fn::And"].splice(1, 1); }],
  ["production environment allowed", (copy) => { copy.Conditions.SyntheticQualificationAlerting["Fn::And"][0]["Fn::Equals"][1] = "production-clinical"; }],
  ["alarm action unconditional", (copy) => { copy.Resources.CatalogApiErrorAlarm.Properties.AlarmActions = [{ Ref: "QualificationAlarmTopicArn" }]; }],
  ["alarm name outside topic policy", (copy) => { copy.Resources.CatalogApiErrorAlarm.Properties.AlarmName["Fn::If"][1] = "synthetic-catalog-errors"; }],
  ["API 5xx alarm ungated", (copy) => { delete copy.Resources.SyntheticStagingApi5xxAlarm.Condition; }],
  ["API 5xx alarm replaced with Lambda errors", (copy) => { copy.Resources.SyntheticStagingApi5xxAlarm.Properties.MetricName = "Errors"; }],
  ["Lambda deadline too short for auto-resume", (copy) => { copy.Resources.CatalogApiFunction.Properties.Timeout = 15; }],
  ["HTTP deadline too short for auto-resume", (copy) => { copy.Resources.CatalogApiIntegration.Properties.TimeoutInMillis = 15000; }],
  ["production reference default enabled", (copy) => { copy.Parameters.ProductionReferenceRouteEnabled.Default = "true"; }],
  ["production reference account fence removed", (copy) => { copy.Conditions.ProductionReferenceRoute["Fn::And"].pop(); }],
  ["production reference condition removed", (copy) => { delete copy.Resources.WorkforceCatalogReferenceRoute.Condition; }],
  ["production reference consumer authorizer", (copy) => { copy.Resources.WorkforceCatalogReferenceRoute.Properties.AuthorizerId.Ref = "ConsumerCatalogJwtAuthorizer"; }],
]) {
  test(`catalog alert gate refuses ${name}`, () => {
    const copy = structuredClone(extension);
    mutate(copy);
    assert.notDeepEqual(validateGovernedCatalogApi(foundation, copy), []);
  });
}
