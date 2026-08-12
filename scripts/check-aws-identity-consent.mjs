import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const migrationUrl = new URL(
  "infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql",
  root,
);
const manifestUrl = new URL("infra/aws-clinical-core/migrations/manifest.json", root);
const adapterUrl = new URL("src/server/clinical-core/aws-identity-consent.ts", root);
const runnerUrl = new URL("src/server/clinical-core/migrations.ts", root);

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateIdentityConsentBoundary({ migration, manifest, adapter, runner }) {
  const errors = [];
  const requiredTables = [
    "organizations",
    "persons",
    "identities",
    "organization_memberships",
    "patient_records",
    "patient_connections",
    "connection_invitations",
    "consent_artifacts",
    "consent_grants",
  ];
  for (const table of requiredTables) {
    assert(errors, migration.includes(`create table clinical_core.${table}`), `missing ${table} table`);
    assert(errors, migration.includes(`alter table clinical_core.${table} enable row level security`), `${table} must enable RLS`);
  }

  assert(errors, !/^\s*(email|phone|date_of_birth|dob|first_name|last_name)\s+(text|date)\b/im.test(
    migration.replace(/--.*$/gm, ""),
  ), "identity schema must not contain contact or demographic matching columns");
  assert(errors, migration.includes("check (data_classification = 'synthetic_only')"), "data must be locked to synthetic_only");
  assert(errors, migration.includes("check (contains_phi = false)"), "PHI must be structurally refused");
  assert(errors, migration.includes("token_hash text not null unique"), "only an invitation token hash may be stored");
  assert(errors, !/\btoken\s+text\b/i.test(migration), "plaintext invitation token column is forbidden");
  assert(errors, migration.includes("Deliberately no direct-read policy for connection_invitations"), "invitation hashes need deny-by-default reads");
  assert(errors, migration.includes("revoke all on clinical_core.connection_invitations from clinical_core_api"), "API role must have no invitation-table privileges");
  assert(errors, migration.includes("consent_grants_append_only"), "consent history must be append-only");
  assert(errors, migration.includes("audit_events_append_only"), "audit history must be append-only");
  assert(errors, migration.includes("security_invoker = true"), "current-consent view must preserve caller RLS");
  assert(errors, migration.includes("to clinical_core_migrator"), "migration role needs an explicit controlled grant");
  assert(errors, migration.includes("connection.invititation") === false, "audit action spelling drifted");
  assert(errors, migration.includes("connection.invitation_issued") && migration.includes("connection.invitation_claimed"), "invitation lifecycle must be audited");
  assert(errors, migration.includes("connection_not_invitable"), "verified connections must not receive a new claim invitation");
  assert(errors, migration.includes("consent.granted") && migration.includes("consent.revoked"), "consent lifecycle must be audited");
  assert(errors, migration.includes("consent_already_active"), "duplicate active consent must be refused");
  assert(errors, migration.includes("clinical_private.set_request_context"), "transaction-scoped request context is required");
  for (const claim of ["actor_person_id", "organization_id", "identity_pool", "identity_subject", "purpose", "environment", "data_classification"]) {
    assert(errors, migration.includes(`clinical.claim.${claim}`), `missing ${claim} request claim`);
  }
  assert(errors, migration.includes("identity_subject = _identity_subject"), "Cognito subject must bind to the internal person");
  assert(errors, migration.includes("synthetic_attested = true"), "identity must carry a synthetic attestation");
  assert(errors, (migration.match(/foreign key \(connection_id, organization_id, patient_record_id\)/g) ?? []).length === 2, "invitation and consent must enforce connection tenant agreement");
  assert(errors, migration.includes("where c.organization_id = consent_artifacts.organization_id"), "consumer artifact reads must require an organization connection");
  for (const index of [
    "patient_connections_consumer_idx",
    "connection_invitations_created_by_idx",
    "consent_artifacts_approved_by_idx",
    "consent_grants_artifact_idx",
    "consent_grants_recorded_by_idx",
  ]) {
    assert(errors, migration.includes(index), `missing foreign-key index ${index}`);
  }
  assert(errors, migration.includes("safe_metadata ?| array["), "audit metadata needs a denied-key guard");

  assert(errors, adapter.includes('throw new Error("clinical-core/aws-identity-consent is server-only.")'), "adapter needs a server-only guard");
  assert(errors, adapter.includes('randomBytes(32).toString("base64url")'), "invitation token must use 256 bits of randomness");
  assert(errors, adapter.includes("const tokenHash = sha256(token)"), "token must be hashed before persistence");
  assert(errors, adapter.includes("context.identitySubject"), "adapter must pass the verified identity subject");
  assert(errors, adapter.includes('environment: "synthetic-staging"'), "adapter context must be synthetic-only");
  assert(errors, adapter.includes("realPatientData: false"), "adapter must refuse real-patient mode");
  assert(errors, !/console\.(log|warn|error)|logger\./.test(adapter), "adapter must not log tokens or clinical identifiers");

  assert(errors, manifest.contract_version === "clinical-core-migrations/1", "migration manifest contract is invalid");
  assert(errors, Array.isArray(manifest.migrations) && manifest.migrations.length >= 1, "migration ledger must not be empty");
  assert(errors, new Set(manifest.migrations?.map((entry) => entry.version)).size === manifest.migrations?.length, "migration versions must be unique");
  assert(errors, runner.includes("pg_advisory_xact_lock"), "migration runner must serialize applies");
  assert(errors, runner.includes("history_mismatch"), "migration runner must refuse rewritten history");
  assert(errors, runner.includes("database.transaction"), "migration runner must apply atomically");
  return errors;
}

export function readAndValidateIdentityConsentBoundary() {
  return validateIdentityConsentBoundary({
    migration: readFileSync(migrationUrl, "utf8"),
    manifest: JSON.parse(readFileSync(manifestUrl, "utf8")),
    adapter: readFileSync(adapterUrl, "utf8"),
    runner: readFileSync(runnerUrl, "utf8"),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = readAndValidateIdentityConsentBoundary();
  if (errors.length) {
    for (const error of errors) console.error(`AWS identity/consent check failed: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("AWS identity/consent check passed: synthetic identities, hash-only invitations, append-only consent, RLS, and audit are enforced.");
  }
}
