#!/usr/bin/env node
/**
 * Phase 10B.2 — PHI-safe credential and infrastructure preflight.
 *
 *   npm run preflight:copilot
 *
 * Reports each precondition as exactly one of:
 *
 *   present       the thing exists and is usable
 *   missing       the thing is not configured at all
 *   denied        it exists but this identity may not use it
 *   expired       it existed and has lapsed
 *   misconfigured it exists but is wrong in a way that would fail later
 *   n/a           not checkable because a prior precondition is missing
 *
 * WHAT THIS NEVER PRINTS. No secret value, no bearer, no ARN, no account
 * id, no key material, no patient data, no prompt. It reads a secret only
 * to learn whether the read is PERMITTED, discards the value immediately,
 * and reports the category. Where an identifier would be useful for
 * support it is masked to its last four characters.
 *
 * Exit code is 0 when every REQUIRED check is `present`, 1 otherwise, so
 * this is usable as a gate in a script without parsing its output.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATUSES = ["present", "missing", "denied", "expired", "misconfigured", "n/a"];

const results = [];

/** Record a check. `required` false means it is reported but not gating. */
function report(id, status, detail, { required = true } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status ${status}`);
  results.push({ id, status, detail, required });
}

/**
 * Mask an identifier down to a support-usable tail. Never used on secret
 * material — only on ARNs and account ids, and only when a human needs to
 * confirm they are looking at the right resource.
 */
function mask(value) {
  const s = String(value ?? "");
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}

const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ARN_PATTERN = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_-]+$/;

/* ------------------------------------------------------------ AWS region */

const region =
  (process.env.CLINICAL_COPILOT_AWS_REGION ?? process.env.AWS_REGION ?? "").trim();

if (!region) {
  report("aws.region", "missing", "Set CLINICAL_COPILOT_AWS_REGION (or AWS_REGION). Not a secret.");
} else if (!REGION_PATTERN.test(region)) {
  report("aws.region", "misconfigured", `"${region}" is not an AWS region identifier.`);
} else {
  report("aws.region", "present", region);
}

/* ------------------------------------------------- AWS credential source */

/**
 * Presence of a credential SOURCE, by name only. This never reads a key —
 * it reports which chain link is configured, so an operator can see
 * whether they are on a static key (discouraged) or a role (preferred).
 */
const credentialSources = [
  ["static env key", !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY],
  ["named profile", !!process.env.AWS_PROFILE],
  ["shared config file", existsSync(join(homedir(), ".aws", "config"))],
  ["shared credentials file", existsSync(join(homedir(), ".aws", "credentials"))],
  ["web identity (IRSA)", !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE && !!process.env.AWS_ROLE_ARN],
  ["ECS task role", !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI],
  ["Lambda execution role", !!process.env.AWS_LAMBDA_FUNCTION_NAME],
];
const configuredSources = credentialSources.filter(([, ok]) => ok).map(([name]) => name);

if (configuredSources.length === 0) {
  report(
    "aws.credentialSource",
    "missing",
    "No credential source is configured. Preferred: an IAM role via the provider chain " +
      "(task role, IRSA, or SSO for local work) — not a static key.",
  );
} else {
  report("aws.credentialSource", "present", configuredSources.join(", "));
}

/* --------------------------------------------------------- secret handle */

const secretRef = (process.env.CLINICAL_COPILOT_OPENAI_SECRET_ARN ?? "").trim();
if (!secretRef) {
  report(
    "aws.secretReference",
    "missing",
    "Set CLINICAL_COPILOT_OPENAI_SECRET_ARN to the secret's ARN. The ARN, never the value.",
  );
} else if (!ARN_PATTERN.test(secretRef)) {
  report("aws.secretReference", "misconfigured", "Not a Secrets Manager ARN.");
} else if (/^(sk-|Bearer )/.test(secretRef)) {
  // Defensive: if someone pastes a key where an ARN belongs, say so
  // WITHOUT echoing any part of it.
  report("aws.secretReference", "misconfigured", "A key was supplied where an ARN belongs.");
} else {
  report("aws.secretReference", "present", mask(secretRef));
}

/* ------------------------------------------------- live AWS reachability */

const canTryAws =
  region && REGION_PATTERN.test(region) && configuredSources.length > 0;

/** Map an AWS error to one of our categories, reading the TYPE only. */
function categorizeAwsError(err) {
  const name = String(err?.name ?? "");
  const status = Number(err?.$metadata?.httpStatusCode ?? 0);
  if (/ResourceNotFoundException/.test(name)) return "missing";
  if (/AccessDenied|UnrecognizedClient|InvalidSignature|NotAuthorized/i.test(name)) return "denied";
  if (/CredentialsProviderError|CredentialsError/i.test(name)) return "missing";
  if (/ExpiredToken|TokenRefreshRequired/i.test(name)) return "expired";
  if (/InvalidRequestException/.test(name)) return "expired";
  if (/DecryptionFailure|InvalidParameter|Serialization/i.test(name)) return "misconfigured";
  if (status === 403) return "denied";
  if (status === 404) return "missing";
  return "misconfigured";
}

if (!canTryAws) {
  report("aws.callerIdentity", "n/a", "Requires a region and a credential source.");
  report("aws.secretReadable", "n/a", "Requires a region, a credential source, and an ARN.");
  report("aws.listSecretsDenied", "n/a", "Requires a region and a credential source.", {
    required: false,
  });
} else {
  // The SDK is imported lazily here for the same reason it is lazy in
  // `secrets.aws.ts`: nothing should pull it into a process that is not
  // about to use it.
  let sts, sm;
  try {
    sts = await import("@aws-sdk/client-sts");
  } catch {
    sts = null;
  }
  try {
    sm = await import("@aws-sdk/client-secrets-manager");
  } catch {
    sm = null;
  }

  if (!sts) {
    report("aws.callerIdentity", "n/a", "@aws-sdk/client-sts is not installed (optional check).", {
      required: false,
    });
  } else {
    try {
      const client = new sts.STSClient({ region, maxAttempts: 2 });
      const who = await client.send(new sts.GetCallerIdentityCommand({}));
      // Masked. An account id is not a credential, but it is also not
      // something a log needs in full.
      report("aws.callerIdentity", "present", `account ${mask(who.Account)}`);
    } catch (err) {
      report("aws.callerIdentity", categorizeAwsError(err), "STS GetCallerIdentity failed.");
    }
  }

  if (!sm) {
    report("aws.secretReadable", "misconfigured", "@aws-sdk/client-secrets-manager is not installed.");
    report("aws.listSecretsDenied", "n/a", "SDK unavailable.", { required: false });
  } else if (!secretRef || !ARN_PATTERN.test(secretRef)) {
    report("aws.secretReadable", "n/a", "Requires a valid secret ARN.");
    report("aws.listSecretsDenied", "n/a", "Requires a valid secret ARN.", { required: false });
  } else {
    const client = new sm.SecretsManagerClient({
      region,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 },
    });

    // Read to learn whether the read is PERMITTED. The value is bound to a
    // local, never inspected beyond its type, and goes out of scope
    // immediately. Nothing derived from it is printed.
    try {
      const out = await client.send(new sm.GetSecretValueCommand({ SecretId: secretRef }));
      const usable = typeof out?.SecretString === "string" && out.SecretString.length >= 20;
      report(
        "aws.secretReadable",
        usable ? "present" : "misconfigured",
        usable
          ? "readable, and the payload has a plausible shape"
          : "readable, but the payload is empty, binary-only, or too short to be a bearer",
      );
    } catch (err) {
      report("aws.secretReadable", categorizeAwsError(err), "GetSecretValue failed.");
    }

    // A POSITIVE security property: the identity must NOT be able to
    // enumerate secrets. `denied` is the passing result here, which is why
    // this check is reported inverted.
    try {
      await client.send(new sm.ListSecretsCommand({ MaxResults: 1 }));
      report(
        "aws.listSecretsDenied",
        "misconfigured",
        "This identity CAN list all secrets. The policy is too broad — scope it to one ARN.",
        { required: false },
      );
    } catch (err) {
      const cat = categorizeAwsError(err);
      report(
        "aws.listSecretsDenied",
        cat === "denied" ? "present" : cat,
        cat === "denied"
          ? "ListSecrets is denied, as it should be"
          : "ListSecrets failed for a reason other than denial",
        { required: false },
      );
    }
  }
}

/* -------------------------------------------------- clinical backend side */

const backendUrl = (process.env.CLINICAL_SUPABASE_URL ?? "").trim();
const STAGING_PROJECT_REF = "urcjiehlxoehievobezf";
if (!backendUrl) {
  report("clinical.backend", "missing", "CLINICAL_SUPABASE_URL is not set.");
  report("clinical.stagingPosture", "n/a", "Requires a configured backend.");
} else {
  let host = "";
  try {
    host = new URL(backendUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (!host) {
    report("clinical.backend", "misconfigured", "CLINICAL_SUPABASE_URL is not a valid URL.");
    report("clinical.stagingPosture", "n/a", "Requires a valid backend URL.");
  } else {
    report("clinical.backend", "present", host.includes("supabase") ? "hosted" : "local");
    report(
      "clinical.stagingPosture",
      host.includes(STAGING_PROJECT_REF) ? "present" : "misconfigured",
      host.includes(STAGING_PROJECT_REF)
        ? "pointed at the synthetic staging project"
        : "NOT pointed at the staging project — a bounded external verification runs there or nowhere",
    );
  }
}

/* -------------------------------------------------------- build contract */

report("build.governedModel", "present", "gpt-5.6-sol", { required: false });
report("build.requestContract", "present", "10b2.responses.v1", { required: false });
report("build.outputSchema", "present", "copilot_output_v1", { required: false });

/* ----------------------------------------------------- governed records */

/**
 * The registry row, activation scope, posture, budget, and both kill
 * switches live in the database behind RLS. They are checked by
 * `evaluate_copilot_staging_gate`, which is the authority — this preflight
 * deliberately does NOT reimplement that logic, because two
 * implementations of a safety gate is one too many.
 */
report(
  "governed.gate",
  canTryAws && backendUrl ? "n/a" : "n/a",
  "Evaluated by evaluate_copilot_staging_gate under the operator's RLS session, " +
    "not by this script. Run `npm run gate:copilot-synthetic` after provisioning.",
  { required: false },
);

/* ------------------------------------------------------------- reporting */

const pad = (s, n) => String(s).padEnd(n);
const width = Math.max(...results.map((r) => r.id.length)) + 2;

console.log("\nPhase 10B.2 — copilot credential & infrastructure preflight");
console.log("(no secret value, ARN, account id, or patient data is printed)\n");

for (const r of results) {
  const flag = r.required ? " " : "·";
  console.log(`${flag} ${pad(r.id, width)} ${pad(r.status, 14)} ${r.detail}`);
}

const blocking = results.filter((r) => r.required && r.status !== "present");
console.log("");
if (blocking.length === 0) {
  console.log("PREFLIGHT PASS — every required precondition is present.");
  console.log("Next: npm run gate:copilot-synthetic");
  process.exit(0);
}
console.log(`PREFLIGHT BLOCKED — ${blocking.length} required precondition(s) not present:`);
for (const b of blocking) console.log(`  ${b.id}: ${b.status} — ${b.detail}`);
console.log("\nSee docs/phase10b2-operator-bootstrap.md for the provisioning steps.");
console.log("Do not work around this by putting a key in an environment variable.");
process.exit(1);
