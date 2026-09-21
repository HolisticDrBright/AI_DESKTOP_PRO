import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANDIDATES, loadTemplate, qualificationParameters, QUALIFICATION_ACCOUNT_ID, QUALIFICATION_DATABASE_NAME } from "../../../scripts/build-aws-qualification-parameters.mjs";

// The copy-and-fill parameter files for deploying each candidate with the qualification execution profile: each must name
// exactly its template's parameters, satisfy every pattern, hold the fixed synthetic posture, and make the template's
// Qualification condition true (and Active false) in the synthetic account, so a filled file cannot silently deploy inert.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Template = { Parameters: Record<string, { Default?: Json; AllowedPattern?: string; AllowedValues?: string[]; Type?: string }>; Conditions: Record<string, Json> };
function evaluate(t: Template, v: Json, p: Record<string, string>): unknown {
  if (v === null || typeof v !== "object") return v; if (Array.isArray(v)) return v.map((x) => evaluate(t, x, p));
  if (typeof v.Ref === "string") return p[v.Ref] ?? "";
  if (v["Fn::Equals"]) { const a = evaluate(t, v["Fn::Equals"], p) as unknown[]; return a[0] === a[1]; }
  if (v["Fn::Not"]) return !(evaluate(t, v["Fn::Not"], p) as unknown[])[0];
  if (v["Fn::And"]) return (evaluate(t, v["Fn::And"], p) as unknown[]).every(Boolean);
  if (v["Fn::Or"]) return (evaluate(t, v["Fn::Or"], p) as unknown[]).some(Boolean);
  if (typeof v.Condition === "string") return evaluate(t, t.Conditions[v.Condition], p);
  throw new Error("unsupported_condition");
}
describe("qualification parameter examples", () => {
  for (const candidate of Object.keys(CANDIDATES)) {
    it(`${candidate}: matches its template, satisfies every constraint, and enables qualification without production activation`, () => {
      const template = loadTemplate(candidate) as Template;
      const generated = qualificationParameters(candidate, template) as Array<{ ParameterKey: string; ParameterValue: string }>;
      const committed = JSON.parse(readFileSync(`infra/aws-clinical-core/qualification-parameters/${candidate}.example.json`, "utf8"));
      expect(committed).toEqual(generated);
      expect(generated.map((p) => p.ParameterKey)).toEqual(Object.keys(template.Parameters));
      const values = Object.fromEntries(generated.map((p) => [p.ParameterKey, p.ParameterValue]));
      for (const [name, definition] of Object.entries(template.Parameters)) {
        const value = values[name];
        expect(typeof value, name).toBe("string");
        if (definition.AllowedPattern) expect(new RegExp(definition.AllowedPattern).test(value), `${name}=${value}`).toBe(true);
        if (definition.AllowedValues) expect(definition.AllowedValues, name).toContain(value);
        if (definition.Type === "Number") expect(Number.isFinite(Number(value)), name).toBe(true);
      }
      expect(values).toMatchObject({ PhiAllowed: "false", Activation: "blocked", ActivationEvidenceSha256: "", QualificationExecution: "enabled",
        QualificationAccountId: QUALIFICATION_ACCOUNT_ID, DatabaseName: QUALIFICATION_DATABASE_NAME });
      expect(values.DatabaseClusterArn).toContain(`:${QUALIFICATION_ACCOUNT_ID}:`);
      expect(JSON.stringify(values)).not.toContain("173535830222");
      const inAccount = { ...values, "AWS::AccountId": QUALIFICATION_ACCOUNT_ID };
      expect(evaluate(template, template.Conditions.Qualification, inAccount)).toBe(true);
      expect(evaluate(template, template.Conditions.Enabled, inAccount)).toBe(true);
      expect(evaluate(template, template.Conditions.Active, inAccount)).toBe(false);
      // The same file deployed into any other account, including production, enables nothing.
      expect(evaluate(template, template.Conditions.Qualification, { ...values, "AWS::AccountId": "173535830222" })).toBe(false);
      expect(evaluate(template, template.Conditions.Qualification, { ...values, "AWS::AccountId": "123456789012" })).toBe(false);
    });
  }
});
