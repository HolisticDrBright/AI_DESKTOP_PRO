import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseOpenAISecret } from "./aws-lab-openai";
import {
  assertModelCallsPermitted,
  MODEL_VENDOR_AUTHORITY_RECORD,
  ModelVendorAuthorityRefusal,
  parseModelVendorAuthority,
  type ModelVendorAuthority,
} from "./model-vendor-authority";
import { describeAuthority, runModelVendorAuthorityOperator, withAuthority } from "./model-vendor-authority-secret";

const KEY = `sk-${"a".repeat(40)}`;
const ACTIVE: ModelVendorAuthority = {
  record: MODEL_VENDOR_AUTHORITY_RECORD,
  state: "active",
  retention: "modified_zero_retention",
  agreement: "vendor-baa/2026-09-17",
  effectiveAt: "2026-09-17",
};
const secretWith = (authority: unknown) => JSON.stringify({ OPENAI_API_KEY: KEY, authority });
const category = (call: () => unknown): string => {
  try { call(); } catch (error) { return error instanceof ModelVendorAuthorityRefusal ? error.category : `unexpected:${String(error)}`; }
  return "no_refusal";
};

describe("model vendor authority", () => {
  it("permits a call only while the recorded authority is active and in force", () => {
    expect(() => assertModelCallsPermitted({ authority: ACTIVE, phiAllowed: true, today: "2026-09-22" })).not.toThrow();
    expect(category(() => assertModelCallsPermitted({ authority: { ...ACTIVE, state: "suspended" }, phiAllowed: true, today: "2026-09-22" })))
      .toBe("model_vendor_authority_withdrawn");
    expect(category(() => assertModelCallsPermitted({ authority: { ...ACTIVE, state: "terminated" }, phiAllowed: false, today: "2026-09-22" })))
      .toBe("model_vendor_authority_withdrawn");
    expect(category(() => assertModelCallsPermitted({ authority: { ...ACTIVE, effectiveAt: "2026-10-01" }, phiAllowed: false, today: "2026-09-22" })))
      .toBe("model_vendor_authority_not_in_force");
  });

  it("refuses vendor-default retention once protected information is enabled", () => {
    const vendorDefault = { ...ACTIVE, retention: "vendor_default" as const };
    expect(() => assertModelCallsPermitted({ authority: vendorDefault, phiAllowed: false, today: "2026-09-22" })).not.toThrow();
    expect(category(() => assertModelCallsPermitted({ authority: vendorDefault, phiAllowed: true, today: "2026-09-22" })))
      .toBe("model_vendor_retention_unconfirmed");
  });

  it("treats an unrecorded authority as usable only where no protected information can be sent", () => {
    expect(() => assertModelCallsPermitted({ authority: null, phiAllowed: false })).not.toThrow();
    expect(category(() => assertModelCallsPermitted({ authority: null, phiAllowed: true }))).toBe("model_vendor_authority_missing");
  });

  it("reads an authority record strictly", () => {
    expect(parseModelVendorAuthority(ACTIVE)).toEqual(ACTIVE);
    for (const bad of [
      null, "active", { ...ACTIVE, record: "other/1" }, { ...ACTIVE, state: "paused" }, { ...ACTIVE, retention: "zero" },
      { ...ACTIVE, agreement: "" }, { ...ACTIVE, effectiveAt: "17/09/2026" }, { ...ACTIVE, extra: true },
    ]) expect(category(() => parseModelVendorAuthority(bad))).toBe("model_vendor_authority_malformed");
  });
});

describe("the key is unobtainable without the gate", () => {
  it("returns the key only when a call may be sent", () => {
    expect(parseOpenAISecret(secretWith(ACTIVE), true)).toBe(KEY);
    expect(parseOpenAISecret(KEY, false)).toBe(KEY);
    expect(category(() => parseOpenAISecret(KEY, true))).toBe("model_vendor_authority_missing");
    expect(category(() => parseOpenAISecret(secretWith({ ...ACTIVE, state: "terminated" }), false))).toBe("model_vendor_authority_withdrawn");
    expect(category(() => parseOpenAISecret(secretWith({ ...ACTIVE, state: "suspended" }), true))).toBe("model_vendor_authority_withdrawn");
    expect(category(() => parseOpenAISecret(secretWith({ state: "active" }), false))).toBe("model_vendor_authority_malformed");
  });

  it("is the only way a request path can hold the vendor key", () => {
    const directory = "src/server/clinical-core";
    const bypasses: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const source = readFileSync(join(directory, entry), "utf8");
      if (!source.includes("api.openai.com")) continue;
      // A module that sends to the vendor must take its key from the gated parser, and never from the operator rewriter.
      if (!/parseOpenAISecret/.test(source)) bypasses.push(`${entry}: no gated key`);
      if (/model-vendor-authority-secret/.test(source)) bypasses.push(`${entry}: operator rewriter imported by a request path`);
    }
    expect(bypasses).toEqual([]);
    expect(readdirSync(directory).filter((entry) => readFileSync(join(directory, entry), "utf8").includes("api.openai.com")).length)
      .toBeGreaterThanOrEqual(4);
  });
});

describe("the operator switch", () => {
  const secretArn = "arn:aws:secretsmanager:us-east-2:588966314750:secret:vendor-key-AbC123";
  const environment = { MODEL_VENDOR_SECRET_ARN: secretArn, EXPECTED_AWS_ACCOUNT_ID: "588966314750" } as NodeJS.ProcessEnv;
  const client = (secretString: string) => {
    const writes: string[] = [];
    return {
      writes,
      secrets: {
        send: async (command: { input?: Record<string, unknown>; constructor: { name: string } }) => {
          if (command.constructor.name === "PutSecretValueCommand") {
            writes.push(String(command.input?.SecretString));
            return { VersionId: "v2" };
          }
          return { SecretString: secretString };
        },
      },
    };
  };

  it("stops every path on one command and says so without printing the key", async () => {
    const { secrets, writes } = client(secretWith(ACTIVE));
    const report = await runModelVendorAuthorityOperator({ command: "suspend", environment, secrets: secrets as never, today: "2026-09-22" });
    expect(report.state).toBe("suspended");
    expect(report.previousState).toBe("active");
    expect(report.effect).toBe("model_calls_refused_on_next_call");
    expect(report.agreement).toBe("vendor-baa/2026-09-17");
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(writes).toHaveLength(1);
    expect(category(() => parseOpenAISecret(writes[0], false))).toBe("model_vendor_authority_withdrawn");
  });

  it("will not permit again without an executed agreement and a stated retention mode", async () => {
    const { secrets, writes } = client(secretWith({ ...ACTIVE, state: "terminated" }));
    await expect(runModelVendorAuthorityOperator({ command: "activate", environment, secrets: secrets as never, today: "2026-09-22" }))
      .rejects.toThrow("activation_boundary_refused");
    await expect(runModelVendorAuthorityOperator({
      command: "activate",
      environment: { ...environment, CONFIRM_MODEL_VENDOR_AGREEMENT_EXECUTED: "true", MODEL_VENDOR_AGREEMENT_REFERENCE: "vendor-baa/2026-09-17" },
      secrets: secrets as never, today: "2026-09-22",
    })).rejects.toThrow("activation_boundary_refused");
    expect(writes).toEqual([]);

    const report = await runModelVendorAuthorityOperator({
      command: "activate",
      environment: {
        ...environment, CONFIRM_MODEL_VENDOR_AGREEMENT_EXECUTED: "true",
        MODEL_VENDOR_AGREEMENT_REFERENCE: "vendor-baa/2026-09-17", MODEL_VENDOR_RETENTION_MODE: "modified_zero_retention",
      },
      secrets: secrets as never, today: "2026-09-22",
    });
    expect(report.state).toBe("active");
    expect(report.effectiveAt).toBe("2026-09-22");
    expect(parseOpenAISecret(writes[0], true)).toBe(KEY);
  });

  it("refuses a secret in another account and an unknown command", async () => {
    const { secrets } = client(secretWith(ACTIVE));
    await expect(runModelVendorAuthorityOperator({ command: "suspend", environment: { ...environment, EXPECTED_AWS_ACCOUNT_ID: "173535830222" }, secrets: secrets as never }))
      .rejects.toThrow("account_boundary_refused");
    await expect(runModelVendorAuthorityOperator({ command: "rotate", environment, secrets: secrets as never }))
      .rejects.toThrow("model_vendor_command_refused");
  });

  it("reports the recorded authority read-only, and writes nothing", async () => {
    const { secrets, writes } = client(secretWith(ACTIVE));
    const report = await runModelVendorAuthorityOperator({ command: "inspect", environment, secrets: secrets as never });
    expect(report).toEqual({
      mode: "model_vendor_authority_inspection_read_only", keyPresent: true, state: "active",
      retention: "modified_zero_retention", agreement: "vendor-baa/2026-09-17", effectiveAt: "2026-09-17",
    });
    expect(writes).toEqual([]);
  });

  it("carries a bare key into the recorded shape and keeps only the key it governs", () => {
    expect(describeAuthority(KEY)).toEqual({ authority: null, keyPresent: true });
    const next = withAuthority(KEY, ACTIVE);
    expect(JSON.parse(next)).toEqual({ OPENAI_API_KEY: KEY, authority: ACTIVE });
    expect(() => withAuthority("not-a-secret", ACTIVE)).toThrow("vendor_secret_malformed");
  });
});
