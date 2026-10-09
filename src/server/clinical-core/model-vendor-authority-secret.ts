import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import {
  MODEL_VENDOR_AUTHORITY_FIELD,
  MODEL_VENDOR_AUTHORITY_RECORD,
  MODEL_VENDOR_RETENTION_MODES,
  parseModelVendorAuthority,
  type ModelVendorAuthority,
  type ModelVendorRetentionMode,
} from "./model-vendor-authority";

/**
 * Operator entry point for the switch that stops every model call.
 *
 * `inspect` is read-only. `suspend` and `terminate` are the stopping direction and ask for nothing beyond the secret,
 * because a right that has ended must be revocable in one command by whoever is awake. `activate` is the permitting
 * direction and requires the operator to confirm that an agreement is executed, to name it, and to state the retention
 * mode that was actually provisioned — approval to sign is not an executed agreement, and an executed agreement is not
 * the separate act that turns off default retention. Every command pins the account through the secret ARN.
 *
 * The key never leaves this process: it is read only to be written back beside the authority, and no report includes it.
 */
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:(\d{12}):secret:[A-Za-z0-9/_+=.@!-]+$/;
const LEGACY_SECRET_FIELD = "ai-longevity-pro/synthetic-staging/openai";
const KEY_FIELDS = ["OPENAI_API_KEY", "apiKey", LEGACY_SECRET_FIELD] as const;

/** Rewrite the secret so it carries this authority beside the key it governs. Server-only; no request path may call it. */
export function withAuthority(secretString: string, authority: ModelVendorAuthority): string {
  const trimmed = secretString.trim();
  if (trimmed.startsWith("sk-") && trimmed.length >= 24) {
    return JSON.stringify({ OPENAI_API_KEY: trimmed, [MODEL_VENDOR_AUTHORITY_FIELD]: authority });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error("vendor_secret_malformed"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("vendor_secret_malformed");
  const record = parsed as Record<string, unknown>;
  const field = KEY_FIELDS.find((name) => typeof record[name] === "string");
  if (!field) throw new Error("vendor_secret_malformed");
  const key = record[field] as string;
  if (!key.startsWith("sk-") || key.length < 24) throw new Error("vendor_secret_malformed");
  return JSON.stringify({ [field]: key, [MODEL_VENDOR_AUTHORITY_FIELD]: authority });
}

/** What an operator may see: the authority and nothing else the secret holds. */
export function describeAuthority(secretString: string): { authority: ModelVendorAuthority | null; keyPresent: boolean } {
  const trimmed = secretString.trim();
  if (trimmed.startsWith("sk-") && trimmed.length >= 24) return { authority: null, keyPresent: true };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error("vendor_secret_malformed"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("vendor_secret_malformed");
  const record = parsed as Record<string, unknown>;
  const keyPresent = KEY_FIELDS.some((name) => typeof record[name] === "string");
  const authority = MODEL_VENDOR_AUTHORITY_FIELD in record ? parseModelVendorAuthority(record[MODEL_VENDOR_AUTHORITY_FIELD]) : null;
  return { authority, keyPresent };
}

export async function runModelVendorAuthorityOperator(input: {
  command: string;
  environment: NodeJS.ProcessEnv;
  secrets: Pick<SecretsManagerClient, "send">;
  today?: string;
}): Promise<Record<string, unknown>> {
  const { command, environment } = input;
  if (!["inspect", "activate", "suspend", "terminate"].includes(command)) throw new Error("model_vendor_command_refused");
  const secretArn = environment.MODEL_VENDOR_SECRET_ARN?.trim() ?? "";
  const expectedAccountId = environment.EXPECTED_AWS_ACCOUNT_ID?.trim() ?? "";
  const match = secretArn.match(SECRET_ARN);
  if (!match || !expectedAccountId || match[2] !== expectedAccountId) throw new Error("account_boundary_refused");

  const current = await input.secrets.send(new GetSecretValueCommand({ SecretId: secretArn }) as never) as { SecretString?: string };
  if (typeof current.SecretString !== "string") throw new Error("vendor_secret_malformed");
  const observed = describeAuthority(current.SecretString);

  if (command === "inspect") {
    return {
      mode: "model_vendor_authority_inspection_read_only",
      keyPresent: observed.keyPresent,
      state: observed.authority?.state ?? "unrecorded",
      retention: observed.authority?.retention ?? "unrecorded",
      agreement: observed.authority?.agreement ?? "unrecorded",
      effectiveAt: observed.authority?.effectiveAt ?? "unrecorded",
    };
  }

  const today = input.today ?? new Date().toISOString().slice(0, 10);
  let authority: ModelVendorAuthority;
  if (command === "activate") {
    if (environment.CONFIRM_MODEL_VENDOR_AGREEMENT_EXECUTED?.trim() !== "true") throw new Error("activation_boundary_refused");
    const retention = environment.MODEL_VENDOR_RETENTION_MODE?.trim() ?? "";
    if (!(MODEL_VENDOR_RETENTION_MODES as readonly string[]).includes(retention)) throw new Error("activation_boundary_refused");
    authority = parseModelVendorAuthority({
      record: MODEL_VENDOR_AUTHORITY_RECORD,
      state: "active",
      retention: retention as ModelVendorRetentionMode,
      agreement: environment.MODEL_VENDOR_AGREEMENT_REFERENCE?.trim() ?? "",
      effectiveAt: environment.MODEL_VENDOR_EFFECTIVE_AT?.trim() || today,
    });
  } else {
    // Stopping keeps whatever the record already said it rested on, so the report still names the agreement that ended.
    authority = parseModelVendorAuthority({
      record: MODEL_VENDOR_AUTHORITY_RECORD,
      state: command === "suspend" ? "suspended" : "terminated",
      retention: observed.authority?.retention ?? "vendor_default",
      agreement: observed.authority?.agreement ?? "unrecorded",
      effectiveAt: today,
    });
  }

  const next = withAuthority(current.SecretString, authority);
  const written = await input.secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: next }) as never) as { VersionId?: string };
  return {
    mode: "model_vendor_authority_written",
    command,
    state: authority.state,
    retention: authority.retention,
    agreement: authority.agreement,
    effectiveAt: authority.effectiveAt,
    previousState: observed.authority?.state ?? "unrecorded",
    versionId: written.VersionId ?? "unreported",
    // Nothing caches the key, so the next call reads this version.
    effect: authority.state === "active" ? "model_calls_permitted_subject_to_posture" : "model_calls_refused_on_next_call",
  };
}
