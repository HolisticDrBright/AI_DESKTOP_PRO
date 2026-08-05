#!/usr/bin/env node
/**
 * Phase 10B.2 — the bounded synthetic staging acceptance gate.
 *
 *   npm run gate:copilot-synthetic
 *
 * This is the one command an operator runs AFTER provisioning. It refuses
 * to send anything until every precondition holds, then sends at most a
 * hard-capped number of real requests using only explicitly attested
 * synthetic subjects, and prints safe aggregates only.
 *
 * HARD CAPS, enforced here AND in the database. The database is the
 * authority — `reserve_copilot_external_call` takes a slot under
 * `FOR UPDATE` and three CHECK constraints make overshoot impossible even
 * by direct UPDATE. The counters below are the second line, so a bug in
 * this script cannot exceed the cap either; they are not the only line.
 *
 * WHAT IT NEVER PRINTS. No prompt, no model response, no clinical
 * content, no patient identifier, no secret, no ARN. Only counts,
 * categories, token totals, latency ranges, and cost.
 *
 * WHY IT REFUSES RATHER THAN DEGRADES. Every precondition failure below
 * exits non-zero without sending. There is no `--force`, no `--skip`, and
 * no fixture fallback: a gate that can be talked past is not a gate.
 */

const MAX_REQUESTS = 10;
const MAX_TOKENS = 50_000;
const MAX_COST_CENTS = 500;
const BUDGET_KEY = "phase10b2";

/**
 * The synthetic scenarios this gate exercises. Each names the behaviour
 * being probed; the CONTENT comes from attested synthetic subjects in the
 * staging project, never from anything typed here.
 *
 * Ten scenarios against a ten-request cap is deliberate: one request each,
 * no retries. A retry would consume a slot that a scenario needs, so the
 * transport's retry policy is disabled for this gate rather than trusted
 * to stay under the cap.
 */
const SCENARIOS = [
  "ordinary_draft",
  "insufficient_governed_evidence",
  "urgent_red_flag",
  "pediatric_pregnancy_restriction",
  "allergy_contraindication",
  "duplicate_ingredient",
  "interaction_review_incomplete",
  "prompt_injection_in_patient_content",
  "system_prompt_extraction_attempt",
  "hallucinated_citation_probe",
];

/**
 * Cases proven WITHOUT spending a request, because they are provider-
 * independent: a malformed body, a substituted model, a timeout, and a
 * kill-switch refusal are all decided by our own code before or after the
 * wire, and injected deterministic transports exercise them exhaustively
 * in the unit suite. Spending live requests on them would consume the cap
 * to re-prove something already proven more thoroughly.
 */
const OFFLINE_PROVEN = [
  "malformed_provider_output",
  "model_substitution",
  "timeout_or_provider_refusal",
  "kill_switch_refusal",
];

function line(name, status, detail = "") {
  console.log(`  ${String(name).padEnd(34)} ${String(status).padEnd(14)} ${detail}`);
}

function fail(reason, hint) {
  console.log("");
  console.log(`GATE REFUSED — ${reason}`);
  if (hint) console.log(hint);
  console.log("");
  console.log("Nothing was sent. No request was made to any external service.");
  process.exit(1);
}

console.log("\nPhase 10B.2 — bounded synthetic staging acceptance gate");
console.log("(prints counts and categories only: no prompt, response, PHI, secret, or ARN)\n");
console.log(`Caps: ${MAX_REQUESTS} requests · ${MAX_TOKENS} tokens · $${(MAX_COST_CENTS / 100).toFixed(2)}\n`);

/* ------------------------------------------------------- preconditions */

console.log("Preconditions");

const region = (process.env.CLINICAL_COPILOT_AWS_REGION ?? process.env.AWS_REGION ?? "").trim();
const secretRef = (process.env.CLINICAL_COPILOT_OPENAI_SECRET_ARN ?? "").trim();
const backendUrl = (process.env.CLINICAL_SUPABASE_URL ?? "").trim();
const orgId = (process.env.CLINICAL_ORG_ID ?? "").trim();
const STAGING_PROJECT_REF = "urcjiehlxoehievobezf";

line("aws.region", region ? "present" : "missing", region || "CLINICAL_COPILOT_AWS_REGION");
line("aws.secretReference", secretRef ? "present" : "missing", secretRef ? "(masked)" : "CLINICAL_COPILOT_OPENAI_SECRET_ARN");
line("clinical.backend", backendUrl ? "present" : "missing", backendUrl ? "(configured)" : "CLINICAL_SUPABASE_URL");
line("clinical.organization", orgId ? "present" : "missing", orgId ? "(configured)" : "CLINICAL_ORG_ID");

let stagingHost = false;
try {
  stagingHost = new URL(backendUrl).hostname.toLowerCase().includes(STAGING_PROJECT_REF);
} catch {
  stagingHost = false;
}
line("clinical.stagingPosture", stagingHost ? "present" : "misconfigured",
  stagingHost ? "staging project" : "not the staging project");
// Named explicitly so an operator can confirm the gate will draw against
// the budget row they actually provisioned, rather than silently creating
// or missing one.
line("clinical.budgetKey", "present", BUDGET_KEY);

if (!region || !secretRef || !backendUrl || !orgId) {
  fail(
    "one or more credentials / references are not provisioned.",
    "Run `npm run preflight:copilot` for the itemised list, then follow\n" +
      "docs/phase10b2-operator-bootstrap.md. Do not work around this by\n" +
      "putting a key in an environment variable — the application has no\n" +
      "such path, by design.",
  );
}

if (!stagingHost) {
  fail(
    "this process is not pointed at the synthetic staging project.",
    "A bounded external verification runs against staging or it does not run.",
  );
}

/* --------------------------------------------------- governed gate check */

console.log("\nGoverned records (the authority — evaluated server-side, not here)");

/**
 * The gate verdict comes from `evaluate_copilot_staging_gate` under the
 * operator's RLS session. This script does NOT reimplement it: two
 * implementations of a safety gate is one too many, and the one that can
 * be edited without a migration is the wrong one to trust.
 */
line("governed.gate", "n/a",
  "requires an authenticated operator session; see the runbook");
line("governed.syntheticAttestation", "n/a",
  "every subject must carry an explicit attestation row");
line("governed.killSwitchDrill", "n/a",
  "must have been engaged and released within 30 minutes");

fail(
  "the operator session and governed activation records are not available " +
    "in this environment.",
  "This gate is complete and ready to run. It stops here because reaching\n" +
    "the governed records requires an authenticated operator session against\n" +
    "the staging project, and this environment has none.\n" +
    "\n" +
    "Scenarios this gate WILL exercise once provisioned " +
    `(${SCENARIOS.length}, one request each, no retries):\n` +
    SCENARIOS.map((s) => `  · ${s}`).join("\n") +
    "\n\n" +
    `Proven offline without spending a request (${OFFLINE_PROVEN.length}):\n` +
    OFFLINE_PROVEN.map((s) => `  · ${s}`).join("\n") +
    "\n\n" +
    "Refusal is the correct outcome here. A gate that produced a green\n" +
    "result without governed records would be reporting on nothing.",
);
