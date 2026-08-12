import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Phase 10B.2 — structural assertions on the operator bootstrap package.
 *
 * These properties are about the SHAPE of files an operator runs against
 * a real AWS account with a real credential in hand. None of them can be
 * observed by calling the code — a script that leaks a key leaks it on the
 * operator's terminal, once, and there is no return value to assert on.
 * So they are asserted on the text, which is the only place the property
 * actually lives.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * These assertions must scan CODE, not prose.
 *
 * The first draft did not strip comments, and three of its checks failed
 * against files that were entirely correct — the bootstrap script's
 * documentation explains *why* it avoids `--secret-string` and `file://`,
 * and the template's comment explains *why* it has no
 * `GenerateSecretString`. A structural test that a correct explanation can
 * trip is worse than no test: the obvious fix is to delete the
 * explanation, which makes the file harder to understand while changing
 * nothing about its safety.
 */
function stripPowerShellComments(src: string): string {
  return src
    .replace(/<#[\s\S]*?#>/g, "")   // block help
    .replace(/^\s*#.*$/gm, "");     // line comments
}

function stripYamlComments(src: string): string {
  return src.replace(/^\s*#.*$/gm, "");
}

function stripJsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const BOOTSTRAP_PS1 = "scripts/bootstrap-copilot-secret.ps1";
const ROLLBACK_PS1 = "scripts/copilot-rollback.ps1";
const PREFLIGHT = "scripts/copilot-preflight.mjs";
const GATE = "scripts/copilot-synthetic-gate.mjs";
const TEMPLATE = "infra/aws/copilot-staging-secret.yaml";

describe("the bootstrap script cannot take a key as an argument", () => {
  const src = read(BOOTSTRAP_PS1);

  test("no parameter is named for a key, token, or secret value", () => {
    // The param block is the whole attack surface here. A -ApiKey
    // parameter would put the key in argv, readable by every other
    // process on the host and by PSReadLine history on disk.
    //
    // Bounded at the block's own closing `)` at column 0, not at the first
    // `)` in the text — the first one closes `[Parameter(Mandatory=$true)`
    // and yields a two-line slice that vacuously passes everything.
    const code = stripPowerShellComments(src);
    const start = code.indexOf("param(");
    expect(start, "a param block must exist").toBeGreaterThan(-1);
    const end = code.indexOf("\n)", start);
    expect(end, "the param block must be closed at column 0").toBeGreaterThan(start);
    const paramBlock = code.slice(start, end);

    for (const forbidden of ["ApiKey", "Key", "Token", "SecretString", "SecretValue", "Password", "Bearer"]) {
      expect(paramBlock, `-${forbidden} must not be a parameter`).not.toMatch(
        new RegExp(`\\$${forbidden}\\b`, "i"),
      );
    }
    // Identifiers ARE expected — they are not values.
    expect(paramBlock).toMatch(/\$SecretId\b/);
    expect(paramBlock).toMatch(/\$Region\b/);
  });

  test("the value is read interactively as a SecureString", () => {
    expect(src).toMatch(/Read-Host[^\n]*-AsSecureString/);
  });

  test("it refuses a key-shaped value passed as any argument", () => {
    expect(src).toMatch(/PSBoundParameters/);
    expect(src).toMatch(/\^\(sk-\|Bearer/);
  });

  test("the value never reaches argv, a file, or an environment variable", () => {
    // Scanned against CODE only. The documentation legitimately names
    // `--secret-string` and `file://` while explaining why it avoids them.
    const code = stripPowerShellComments(src);
    expect(code, "must not shell out to the aws CLI with the value").not.toMatch(
      /--secret-string/,
    );
    expect(code, "must not write the value to disk").not.toMatch(/file:\/\//);
    expect(code, "must not stage the value in an env var").not.toMatch(
      /\$env:[A-Z_]*(KEY|SECRET|TOKEN)/i,
    );
  });

  test("the in-process SDK path is used and the value is scrubbed after", () => {
    expect(src).toMatch(/Set-SECSecretValue/);
    expect(src).toMatch(/ZeroFreeBSTR/);
    expect(src).toMatch(/\$secure\.Dispose\(\)/);
  });

  test("nothing prints the value or a substring of it", () => {
    // Every Write-Host in the file is checked for interpolation of the
    // variables that hold key material.
    const writes = src.match(/Write-(Host|Output|Status)[^\n]*/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w, `must not print key material: ${w}`).not.toMatch(/\$plain|\$body|\$secure/);
    }
  });

  test("check mode reports a category and a length, never content", () => {
    expect(src).toMatch(/-Check/);
    expect(src).toMatch(/opaque bearer|json envelope/);
    expect(src).not.toMatch(/Substring\(/);
  });
});

describe("the AWS template is least-privilege and idempotent", () => {
  const tpl = read(TEMPLATE);

  test("no Allow statement uses a wildcard resource", () => {
    // Parsed structurally rather than by eyeballing: split into
    // statements and check each Allow for Resource: "*".
    const statements = tpl.split(/- Sid: /).slice(1);
    expect(statements.length).toBeGreaterThan(4);
    for (const s of statements) {
      const isAllow = /Effect: Allow/.test(s);
      const wildcardResource = /Resource: "\*"/.test(s);
      if (isAllow && wildcardResource) {
        // The KMS key policy's account-root and Secrets-Manager-service
        // statements are the documented exceptions: a key policy's
        // Resource refers to the key itself and cannot be an ARN.
        expect(
          /Principal:\s*\n\s*(AWS: !Sub "arn:aws:iam::\$\{AWS::AccountId\}:root"|Service: secretsmanager\.amazonaws\.com)/.test(s),
          `Allow with Resource "*" outside the key policy:\n${s.slice(0, 200)}`,
        ).toBe(true);
      }
    }
  });

  test("enumeration is DENIED explicitly, not merely unlisted", () => {
    // Unlisted is not enough: a broad managed policy attached later would
    // re-grant it. An explicit Deny cannot be overridden.
    expect(tpl).toMatch(/Sid: NeverEnumerateSecrets/);
    expect(tpl).toMatch(/secretsmanager:ListSecrets/);
    expect(tpl).toMatch(/secretsmanager:BatchGetSecretValue/);
  });

  test("every write action is denied", () => {
    for (const action of [
      "PutSecretValue", "UpdateSecret", "DeleteSecret", "CreateSecret",
    ]) {
      expect(tpl, `${action} must be denied`).toMatch(new RegExp(`secretsmanager:${action}`));
    }
    expect(tpl).toMatch(/Sid: NeverWriteOrDeleteAnySecret/);
  });

  test("the only Allow on the reader role is GetSecretValue plus a conditioned Decrypt", () => {
    const policy = tpl.slice(tpl.indexOf("read-one-copilot-secret"));
    expect(policy).toMatch(/secretsmanager:GetSecretValue/);
    expect(policy).toMatch(/kms:Decrypt/);
    expect(policy).toMatch(/kms:ViaService/);
    expect(policy, "no blanket secretsmanager grant").not.toMatch(/secretsmanager:\*/);
    expect(policy, "no blanket kms grant").not.toMatch(/kms:\*[\s\S]{0,40}Effect: Allow/);
  });

  test("it creates no secret VALUE and no generated placeholder", () => {
    // A placeholder passes every presence check and fails only at the
    // provider, which is the worst place to discover it. Scanned against
    // the YAML body; the template's comment says the word while
    // explaining the absence.
    const code = stripYamlComments(tpl);
    expect(code).not.toMatch(/GenerateSecretString/);
    expect(code).not.toMatch(/^\s+SecretString:/m);
  });

  test("`production` is not an allowed environment value", () => {
    expect(tpl).toMatch(/AllowedValues: \[staging\]/);
    expect(tpl).not.toMatch(/AllowedValues: \[staging, production\]/);
  });

  test("the key and the secret survive a stack teardown", () => {
    const retains = tpl.match(/DeletionPolicy: Retain/g) ?? [];
    expect(retains.length).toBeGreaterThanOrEqual(2);
  });

  test("rotation is enabled on the key and recorded on the secret", () => {
    expect(tpl).toMatch(/EnableKeyRotation: true/);
    expect(tpl).toMatch(/RotationWindowDays/);
    expect(tpl).toMatch(/RotationOwner/);
  });

  test("no literal account id, key, or ARN is baked in", () => {
    expect(tpl).not.toMatch(/\b\d{12}\b/);
    expect(tpl).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
    expect(tpl).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
  });
});

describe("the preflight and gate print no secret material", () => {
  const preflight = read(PREFLIGHT);
  const gate = read(GATE);

  test("the preflight declares exactly the five operator categories", () => {
    for (const s of ["present", "missing", "denied", "expired", "misconfigured"]) {
      expect(preflight).toMatch(new RegExp(`"${s}"`));
    }
  });

  test("the preflight masks identifiers and never logs a resolved value", () => {
    expect(preflight).toMatch(/function mask\(/);
    // The secret is read to test PERMISSION; the value must not be logged.
    const logs = preflight.match(/console\.log\([^\n]*/g) ?? [];
    for (const l of logs) {
      expect(l, `must not log secret material: ${l}`).not.toMatch(/SecretString|secretRef\b(?!\))/);
    }
  });

  test("the preflight treats ListSecrets being ALLOWED as a misconfiguration", () => {
    // Inverted on purpose: `denied` is the passing result.
    expect(preflight).toMatch(/listSecretsDenied/);
    expect(preflight).toMatch(/CAN list all secrets/);
  });

  test("the gate has no force, skip, or fixture-fallback escape", () => {
    // Code only: the gate's own prose explains that it HAS no fixture
    // fallback, which is the opposite of having one.
    const code = stripJsComments(gate);
    for (const escape of ["--force", "--skip", "SKIP_", "FORCE_", "fallback"]) {
      expect(code, `${escape} must not exist`).not.toMatch(new RegExp(escape, "i"));
    }
  });

  test("the gate's caps match the phase and are stated as constants", () => {
    expect(gate).toMatch(/MAX_REQUESTS = 10\b/);
    expect(gate).toMatch(/MAX_TOKENS = 50_000\b/);
    expect(gate).toMatch(/MAX_COST_CENTS = 500\b/);
  });

  test("the gate exits non-zero without sending when a precondition fails", () => {
    expect(gate).toMatch(/Nothing was sent\./);
    expect(gate).toMatch(/process\.exit\(1\)/);
  });
});

describe("the rollback preserves the audit record", () => {
  const src = read(ROLLBACK_PS1);

  test("it issues no DELETE against runs, telemetry, or history", () => {
    expect(src).not.toMatch(/delete\s+from\s+public\.clinical_copilot/i);
    expect(src).not.toMatch(/truncate/i);
    expect(src).not.toMatch(/drop\s+table/i);
  });

  test("it requires a reason", () => {
    expect(src).toMatch(/Mandatory = \$true\)\]\[string\]\$Reason/);
    expect(src).toMatch(/at least 3 characters/);
  });

  test("the kill switch is step 1, because it is the fastest", () => {
    expect(src.indexOf("STEP 1")).toBeLessThan(src.indexOf("STEP 2"));
    expect(src.slice(src.indexOf("STEP 1"), src.indexOf("STEP 2"))).toMatch(/set_copilot_kill_switch/);
  });

  test("it warns against irreversible KMS key deletion", () => {
    expect(src).toMatch(/Do NOT schedule key deletion/);
    expect(src).toMatch(/disable-key/);
  });

  test("it holds no database credential of its own", () => {
    expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE|service_role_key|psql\s+-/i);
    expect(src).toMatch(/does not hold a database credential/);
  });
});
