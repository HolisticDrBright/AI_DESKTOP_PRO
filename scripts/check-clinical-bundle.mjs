#!/usr/bin/env node
/**
 * CLINICAL BUNDLE GUARD.
 *
 * Inspects the built clinical artifacts for synthetic patient identities and
 * demo-only surfaces, and reports honestly on two different properties that are
 * easy to conflate:
 *
 *   REACHABILITY (enforced today) — can a fixture RENDER in the clinical
 *     edition? No. `src/adapters/index.ts` puts every unwired fixture namespace
 *     behind a barrier that throws `unavailable` when `IS_CLINICAL`, so the UI
 *     shows an honest unavailable state instead of synthetic data. This is
 *     proven at runtime by `src/adapters/clinical-fixture-barrier.test.ts`,
 *     which asserts each namespace refuses and that no fixture id or name
 *     escapes through the error path.
 *
 *   PRESENCE (known gap) — is fixture DATA absent from the shipped bundle?
 *     Not yet. Roughly 57 call sites (14 in the adapter facade, the rest in
 *     components) import `*.mock` modules statically, so the fixture datasets
 *     are code-split into the clinical client bundle as UNREACHABLE DEAD CODE.
 *     Eliminating them requires converting those imports to edition-gated lazy
 *     imports — a mechanical refactor deliberately not bundled into the edition
 *     split, so the split stays reviewable.
 *
 * Default run: fails on reachable demo surfaces, reports presence as a warning.
 * `--strict`: also fails on presence. Use it to track the refactor to done.
 *
 * Usage:
 *   APP_EDITION=clinical npm run build
 *   node scripts/check-clinical-bundle.mjs [--strict]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Strict is now the DEFAULT: the presence gap closed in clinical-runtime
// phase 1 (no production route imports *.mock, so nothing fixture-shaped is
// bundled). --advisory keeps the old warn-only behavior for archaeology.
const STRICT = !process.argv.includes("--advisory");
const CLIENT_CHUNK_DIR = ".next/static";

/** Synthetic identities from `src/adapters/*.mock.ts`. */
const FIXTURE_IDENTITIES = [
  "Alexandra Morgan",
  "Michael Johnson",
  "Priya Sharma",
  "Marcus Webb",
  "Nadia Hassan",
  "Hannah Kim",
  "p-78435",
  "p-64201",
  "p-59318",
];

/**
 * Demo-only copy (mock mutation labels, demo-mode refusals). Like the fixture
 * datasets, these are inert in a clinical build: the strings live inside code
 * paths the barrier never enters. They are counted as PRESENCE, not as
 * reachable UI — static string scanning cannot prove reachability either way,
 * which is exactly why the runtime barrier tests carry that burden.
 */
const DEMO_ONLY_COPY = [
  "(demo — not persisted)",
  "(demo — not submitted)",
  "Demo mode does not",
];

/**
 * SERVER-ONLY MARKERS (Phase 10B.1) — a HARD failure, never advisory.
 *
 * The fixture-presence gap above is dead code in the bundle. These are a
 * different class of problem: if any of them appears in a client chunk,
 * something that must never leave the server has been code-split into the
 * browser. There is no "unreachable dead code" reading that makes an AWS
 * Secrets Manager client or a system prompt acceptable to ship.
 *
 * Each entry is a marker that only the server-side modules produce:
 *   - `@aws-sdk/client-secrets-manager` and the SigV4 / Secrets Manager
 *     wire identifiers the SDK emits;
 *   - the secret-resolver's own category vocabulary, which appears nowhere
 *     else;
 *   - the copilot system prompt and provider auth-header construction.
 */
const SERVER_ONLY_MARKERS = [
  "@aws-sdk/client-secrets-manager",
  "GetSecretValueCommand",
  "SecretsManagerClient",
  "secretsmanager.amazonaws.com",
  "AWS4-HMAC-SHA256",
  "secret_reference_shape_invalid",
  "provider_credential_unavailable_or_denied",
  "You are a governed clinical copilot",
  "openai_transport_refused_by_default",
  "clinical-core/aws-identity-consent is server-only",
  "clinical_core.issue_connection_invitation",
  "clinical_private.set_request_context",
  "@aws-sdk/client-rds-data",
  "BeginTransactionCommand",
  "RDSDataClient",
  "clinical-core/rds-data-database is server-only",
  "clinical-core/aws-identity-api is server-only",
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

const chunks = walk(CLIENT_CHUNK_DIR);

if (chunks.length === 0) {
  console.error(
    `[clinical-bundle] no client chunks under ${CLIENT_CHUNK_DIR}. ` +
      `Run "APP_EDITION=clinical npm run build" first.`,
  );
  process.exit(1);
}

const presence = new Map();
/** marker -> [files]. Always fatal, never advisory. */
const serverOnly = new Map();

for (const file of chunks) {
  const source = readFileSync(file, "utf8");
  for (const needle of [...FIXTURE_IDENTITIES, ...DEMO_ONLY_COPY]) {
    if (source.includes(needle)) {
      presence.set(needle, (presence.get(needle) ?? 0) + 1);
    }
  }
  for (const needle of SERVER_ONLY_MARKERS) {
    if (source.includes(needle)) {
      serverOnly.set(needle, [...(serverOnly.get(needle) ?? []), file]);
    }
  }
}

if (serverOnly.size > 0) {
  console.error(
    `[clinical-bundle] FAIL — server-only code reached the CLIENT bundle. ` +
      `This is not a presence gap; it is a leak:`,
  );
  for (const [needle, files] of serverOnly) {
    console.error(`  ${JSON.stringify(needle)} in ${files.join(", ")}`);
  }
  console.error(
    `\nThe AWS Secrets Manager client, the secret resolver, the bounded HTTPS ` +
      `transport, and the copilot system prompt are all server-only and are ` +
      `guarded at module scope. A hit here means an import edge from a client ` +
      `component reached one of them — find the edge; do not add an exclusion.`,
  );
  process.exit(1);
}

if (presence.size === 0) {
  console.log(
    `[clinical-bundle] PASS — ${chunks.length} client chunks carry no synthetic ` +
      `identity, no demo-only copy, and none of the ${SERVER_ONLY_MARKERS.length} ` +
      `server-only markers (AWS SDK, secret resolver, transport, system prompt).`,
  );
  process.exit(0);
}

const total = [...presence.values()].reduce((a, b) => a + b, 0);
const log = STRICT ? console.error : console.warn;

log(
  `[clinical-bundle] ${STRICT ? "FAIL" : "KNOWN GAP"} — ${presence.size} synthetic ` +
    `reference(s) across ${total} chunk occurrence(s) in the clinical bundle:`,
);
for (const [needle, count] of [...presence].sort((a, b) => b[1] - a[1])) {
  log(`  ${JSON.stringify(needle)} × ${count}`);
}
log(
  `\nREACHABILITY (enforced): none of this can render. Every fixture namespace ` +
    `throws \`unavailable\` in the clinical edition — proven by ` +
    `src/adapters/clinical-fixture-barrier.test.ts, which also asserts no ` +
    `fixture id or name escapes through the error path.` +
    `\nPRESENCE (this gap): the datasets and demo copy are still code-split into ` +
    `the bundle as unreachable dead code, because ~57 sites import *.mock ` +
    `modules statically. Converting those to edition-gated lazy imports closes ` +
    `it; this run is advisory so the edition split stays reviewable.`,
);

if (STRICT) process.exit(1);
console.log(
  `[clinical-bundle] advisory only (exit 0). Run with --strict to enforce the ` +
    `presence target.`,
);
