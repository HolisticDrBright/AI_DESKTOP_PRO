if (typeof window !== "undefined") throw new Error("clinical-core/operator-aws-principal is server-only.");

import { execFileSync } from "node:child_process";

export type OperatorProfile = "ai-synthetic-member" | "ai-production";
type Runner = (file: string, args: string[]) => string;

/** These administrative operators are scoped to the two reviewed AWS accounts, never an ambient profile. */
export function profileForOperatorAccount(account: string): OperatorProfile {
  if (account === "588966314750") return "ai-synthetic-member";
  if (account === "173535830222") return "ai-production";
  throw new Error("account_boundary_refused");
}

/** Observe the exact profile the SDK will use; an account match under root or an IAM user is insufficient. */
export function assertOperatorAssumedRole(profile: OperatorProfile, account: string, region: string,
  runner: Runner = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] })): void {
  if (profileForOperatorAccount(account) !== profile || region !== "us-east-2") throw new Error("account_boundary_refused");
  let identity: { Account?: unknown; Arn?: unknown };
  try { identity = JSON.parse(runner("aws", ["sts", "get-caller-identity", "--profile", profile, "--region", region, "--output", "json"])); }
  catch { throw new Error("account_boundary_refused"); }
  if (identity?.Account !== account || typeof identity.Arn !== "string"
    || !new RegExp(`^arn:aws:sts::${account}:assumed-role/[A-Za-z0-9_+=,.@/-]+$`).test(identity.Arn)) {
    throw new Error("account_boundary_refused");
  }
}
