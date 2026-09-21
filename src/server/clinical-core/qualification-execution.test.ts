import { describe, expect, test } from "vitest";
import { assertQualificationConfiguration, markQualificationResponse, qualificationAdmits, resolveQualificationExecution } from "./qualification-execution";

// The policy that lets a candidate serve designated fictional identities with PHI disabled, and nothing else.
const env = {
  QUALIFICATION_EXECUTION: "enabled", QUALIFICATION_REVIEW_SHA256: "a".repeat(64), QUALIFICATION_ACCOUNT_ID: "588966314750",
  QUALIFICATION_IDENTITY_SUBJECTS: "consumer-sub-00000001, workforce-sub-00000001",
  PHI_ALLOWED: "false", CLINICAL_DATABASE_NAME: "clinical_core_qualification", CLINICAL_DATABASE_CLUSTER_ARN: "arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic",
};
describe("qualification execution policy", () => {
  test("is absent by default and resolves only with every boundary in place", () => {
    expect(resolveQualificationExecution({}, "blocked")).toBeUndefined();
    expect(resolveQualificationExecution({ ...env, QUALIFICATION_EXECUTION: "disabled" }, "blocked")).toBeUndefined();
    expect(resolveQualificationExecution(env, "blocked")).toEqual({ reviewSha256: "a".repeat(64), accountId: "588966314750", databaseName: "clinical_core_qualification", identitySubjects: ["consumer-sub-00000001", "workforce-sub-00000001"] });
  });
  test("refuses PHI allowed, an approved activation, the production account, a foreign cluster, a non-qualification database and bad subjects", () => {
    const cases: Array<[Partial<typeof env>, string]> = [
      [{ PHI_ALLOWED: "true" }, "blocked"], [{}, "approved"], [{}, "draining"], [{ QUALIFICATION_EXECUTION: "yes" }, "blocked"],
      [{ QUALIFICATION_ACCOUNT_ID: "173535830222", CLINICAL_DATABASE_CLUSTER_ARN: "arn:aws:rds:us-east-2:173535830222:cluster:x" }, "blocked"],
      [{ CLINICAL_DATABASE_CLUSTER_ARN: "arn:aws:rds:us-east-2:123456789012:cluster:x" }, "blocked"],
      [{ CLINICAL_DATABASE_NAME: "clinical_core" }, "blocked"], [{ CLINICAL_DATABASE_NAME: "postgres" }, "blocked"], [{ CLINICAL_DATABASE_NAME: "clinical_core_staging" }, "blocked"],
      [{ QUALIFICATION_REVIEW_SHA256: "short" }, "blocked"], [{ QUALIFICATION_IDENTITY_SUBJECTS: "" }, "blocked"], [{ QUALIFICATION_IDENTITY_SUBJECTS: "a,b" }, "blocked"],
      [{ QUALIFICATION_IDENTITY_SUBJECTS: "consumer-sub-00000001,consumer-sub-00000001" }, "blocked"],
      [{ QUALIFICATION_IDENTITY_SUBJECTS: Array.from({ length: 17 }, (_, i) => `subject-${String(i).padStart(8, "0")}`).join(",") }, "blocked"],
    ];
    for (const [patch, activation] of cases) expect(() => resolveQualificationExecution({ ...env, ...patch }, activation), JSON.stringify(patch)).toThrow("qualification_execution_invalid");
  });
  test("a configuration may carry the policy only while PHI is disabled and activation is blocked", () => {
    const q = resolveQualificationExecution(env, "blocked")!;
    expect(assertQualificationConfiguration({ phiAllowed: false, activation: "blocked", qualification: q })).toEqual(q);
    expect(assertQualificationConfiguration({ phiAllowed: false, activation: "blocked" })).toBeUndefined();
    expect(() => assertQualificationConfiguration({ phiAllowed: true, activation: "blocked", qualification: q })).toThrow("qualification_execution_invalid");
    expect(() => assertQualificationConfiguration({ phiAllowed: false, activation: "approved", qualification: q })).toThrow("qualification_execution_invalid");
    expect(() => assertQualificationConfiguration({ phiAllowed: false, activation: "blocked", qualification: { ...q, accountId: "173535830222" } })).toThrow("qualification_execution_invalid");
    expect(() => assertQualificationConfiguration({ phiAllowed: false, activation: "blocked", qualification: { ...q, databaseName: "clinical_core" } })).toThrow("qualification_execution_invalid");
  });
  test("admits only the designated subjects and marks every response it produces", () => {
    const q = resolveQualificationExecution(env, "blocked");
    expect(qualificationAdmits(q, "consumer-sub-00000001")).toBe(true);
    expect(qualificationAdmits(q, "consumer-sub-00000002")).toBe(false);
    expect(qualificationAdmits(undefined, "consumer-sub-00000001")).toBe(false);
    expect(markQualificationResponse(q, { statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" })).toEqual({ statusCode: 200, headers: { "content-type": "application/json", "x-clinical-execution": "qualification" }, body: "{}" });
    expect(markQualificationResponse(undefined, { statusCode: 200, body: "{}" })).toEqual({ statusCode: 200, body: "{}" });
  });
});
