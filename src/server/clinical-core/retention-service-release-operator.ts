if (typeof window !== "undefined") {
  throw new Error("retention-service-release-operator is server-only.");
}

import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { inspectRetentionServiceReleases, releaseRetentionService, revokeRetentionServiceRelease, RetentionServiceReleaseError } from "./retention-service-release";

/** Operator entry point for the retention service release row. `inspect` is read-only; `release` inserts the one live row
 * that lets the scheduled export retention sweep act; `revoke` ends it. Every command pins the AWS account through the
 * cluster ARN and requires the PHI posture to be stated explicitly. `release` and `revoke` additionally require the operator
 * to confirm that the retention operating policy was approved and to name its reviewed evidence hash, which must be the
 * same hash passed to the privacy-operations stack as `RetentionScheduleEvidenceSha256`. Nothing here reads export content,
 * and no identifier beyond opaque person ids and identity subjects is printed. */
const CLUSTER_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function run() {
  const command = process.argv[2];
  if ((command !== "inspect" && command !== "release" && command !== "revoke") || !["true", "false"].includes(required("PHI_ALLOWED"))) {
    throw new Error("activation_boundary_refused");
  }
  if (command !== "inspect" && required("CONFIRM_RETENTION_OPERATING_POLICY_APPROVED") !== "true") {
    throw new Error("activation_boundary_refused");
  }
  const clusterArn = required("CLINICAL_DATABASE_CLUSTER_ARN");
  const secretArn = required("CLINICAL_DATABASE_SECRET_ARN");
  const expectedAccountId = required("EXPECTED_AWS_ACCOUNT_ID");
  const match = clusterArn.match(CLUSTER_ARN);
  if (!match || match[2] !== expectedAccountId || !SECRET_ARN.test(secretArn)) {
    throw new Error("account_boundary_refused");
  }
  const database = createRdsDataAdministrativeDatabase(
    { clusterArn, secretArn, databaseName: required("CLINICAL_DATABASE_NAME"), region: required("AWS_REGION") },
    { purpose: "reviewed_retention_service_release" },
  );
  if (command === "inspect") {
    console.log(JSON.stringify({ mode: "retention_service_release_inspection_read_only", phiAllowed: process.env.PHI_ALLOWED === "true", ...(await inspectRetentionServiceReleases(database)) }));
    return;
  }
  const version = required("RETENTION_RELEASE_VERSION");
  if (command === "revoke") {
    const revoked = await revokeRetentionServiceRelease(database, version);
    console.log(JSON.stringify({ mode: "retention_service_release_revoked", release: revoked, nextSweep: "refused:retention_service_release_required" }));
    return;
  }
  const released = await releaseRetentionService(database, {
    version,
    servicePersonId: required("RETENTION_SERVICE_PERSON_ID"),
    serviceSubject: required("RETENTION_SERVICE_SUBJECT"),
    approvedByPersonId: required("RETENTION_APPROVED_BY_PERSON_ID"),
    evidenceSha256: required("RETENTION_POLICY_EVIDENCE_SHA256"),
  });
  console.log(JSON.stringify({
    mode: "retention_service_released",
    phiAllowed: process.env.PHI_ALLOWED === "true",
    release: released,
    // The schedule only exists and only runs while PHI is allowed on the privacy-operations stack; with PHI disabled this row
    // is inert until that separate activation, which is a human decision recorded elsewhere.
    sweepRuns: process.env.PHI_ALLOWED === "true" ? "on_next_schedule_if_RetentionScheduleActive" : "not_while_phi_disabled",
  }));
}

run().catch((error) => {
  const category = error instanceof RetentionServiceReleaseError ? error.code : error instanceof Error ? error.message : "retention_service_release_failed";
  console.error(/^[a-z_]+$/.test(category) ? category : "retention_service_release_failed");
  process.exitCode = 1;
});
