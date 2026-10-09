import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertOperatorAssumedRole, profileForOperatorAccount } from "./operator-aws-principal";

describe("administrative operator AWS principal", () => {
  it("uses the named member and production role profiles, never the old root-resolving profile", () => {
    expect(profileForOperatorAccount("588966314750")).toBe("ai-synthetic-member");
    expect(profileForOperatorAccount("173535830222")).toBe("ai-production");
    expect(() => profileForOperatorAccount("111111111111")).toThrow("account_boundary_refused");
  });

  it("observes STS through the same fixed profile used for database credentials", () => {
    const runner = vi.fn(() => JSON.stringify({ Account: "588966314750",
      Arn: "arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional-session" }));
    expect(() => assertOperatorAssumedRole("ai-synthetic-member", "588966314750", "us-east-2", runner)).not.toThrow();
    expect(runner).toHaveBeenCalledWith("aws", ["sts", "get-caller-identity", "--profile", "ai-synthetic-member", "--region", "us-east-2", "--output", "json"]);
    for (const file of ["production-migration-operator.ts", "retention-service-release-operator.ts", "covered-entity-deletion-operator.ts", "model-vendor-authority-operator.ts"]) {
      const source = readFileSync(`src/server/clinical-core/${file}`, "utf8");
      expect(source).toContain("assertOperatorAssumedRole(profile, expectedAccountId, region)");
      expect(source).toContain("credentials: fromIni({ profile })");
    }
  });

  it("refuses root, IAM user, wrong account, missing ARN, malformed STS and mismatched profile before database access", () => {
    const account = "588966314750", profile = "ai-synthetic-member";
    for (const value of [
      { Account: account, Arn: `arn:aws:iam::${account}:root` },
      { Account: account, Arn: `arn:aws:iam::${account}:user/long-lived` },
      { Account: "173535830222", Arn: "arn:aws:sts::173535830222:assumed-role/Other/session" },
      { Account: account },
    ]) expect(() => assertOperatorAssumedRole(profile, account, "us-east-2", () => JSON.stringify(value))).toThrow("account_boundary_refused");
    expect(() => assertOperatorAssumedRole(profile, account, "us-east-2", () => "not-json")).toThrow("account_boundary_refused");
    const runner = vi.fn(() => "{}");
    expect(() => assertOperatorAssumedRole("ai-production", account, "us-east-2", runner)).toThrow("account_boundary_refused");
    expect(() => assertOperatorAssumedRole(profile, account, "us-west-2", runner)).toThrow("account_boundary_refused");
    expect(runner).not.toHaveBeenCalled();
  });
});
