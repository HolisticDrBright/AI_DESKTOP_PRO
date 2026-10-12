import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateGovernedCatalogApi } from "./check-aws-governed-catalog-api.mjs";

const foundation = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/template.json", import.meta.url), "utf8"));
const extension = JSON.parse(readFileSync(new URL("../infra/aws-clinical-core/catalog-api-extension.json", import.meta.url), "utf8"));

test("reviewed catalog alert is opt-in and passes the template gate", () => {
  assert.deepEqual(validateGovernedCatalogApi(foundation, extension), []);
});

for (const [name, mutate] of [
  ["topic default enabled", (copy) => { copy.Parameters.QualificationAlarmTopicArn.Default = "arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms"; }],
  ["topic target widened", (copy) => { copy.Parameters.QualificationAlarmTopicArn.AllowedPattern = ".*"; }],
  ["account fence removed", (copy) => { copy.Conditions.SyntheticQualificationAlerting["Fn::And"].splice(1, 1); }],
  ["production environment allowed", (copy) => { copy.Conditions.SyntheticQualificationAlerting["Fn::And"][0]["Fn::Equals"][1] = "production-clinical"; }],
  ["alarm action unconditional", (copy) => { copy.Resources.CatalogApiErrorAlarm.Properties.AlarmActions = [{ Ref: "QualificationAlarmTopicArn" }]; }],
  ["alarm name outside topic policy", (copy) => { copy.Resources.CatalogApiErrorAlarm.Properties.AlarmName["Fn::If"][1] = "synthetic-catalog-errors"; }],
]) {
  test(`catalog alert gate refuses ${name}`, () => {
    const copy = structuredClone(extension);
    mutate(copy);
    assert.notDeepEqual(validateGovernedCatalogApi(foundation, copy), []);
  });
}
