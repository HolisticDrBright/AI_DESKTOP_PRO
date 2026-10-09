if (typeof window !== "undefined") {
  throw new Error("covered-entity-deletion-operator is server-only.");
}

import { createHash } from "node:crypto";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { RDSDataClient } from "@aws-sdk/client-rds-data";

import { errorCode } from "./log-safe-error";
import {
  CoveredEntityDeletionError,
  deleteCoveredEntityContent,
  inspectCoveredEntityContent,
  parseCoveredEntityCoverage,
} from "./covered-entity-deletion";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { assertOperatorAssumedRole, profileForOperatorAccount } from "./operator-aws-principal";

/**
 * Operator entry point for destroying one covered entity's information when its agreement ends.
 *
 * `inspect` is read-only: it reports what the organization still holds, table by table, how many stored objects hang
 * off it, and whether a legal hold is open. `destroy` refuses pending immutable disposition.
 * A coverage inventory is not disposition authority.
 *
 * `destroy` refuses while any stored object is still registered. Objects live under versioning and object lock, and the
 * hold-aware recording cleanup path is what may remove them; this tool will not claim a destruction that only emptied
 * the database. Do not run cleanup to bypass pending immutable disposition. Every command pins the AWS account through the cluster ARN and
 * requires the PHI posture to be stated.
 */
const CLUSTER_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;
declare const __COVERED_ENTITY_COVERAGE_BYTES__: string;
declare const __COVERED_ENTITY_COVERAGE_SHA256__: string;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function run() {
  if (process.env.COVERAGE_PATH !== undefined || process.argv.length !== 3) {
    throw new Error('covered_entity_coverage_override_refused');
  }
  if (typeof __COVERED_ENTITY_COVERAGE_BYTES__ !== 'string' || typeof __COVERED_ENTITY_COVERAGE_SHA256__ !== 'string'
    || createHash('sha256').update(__COVERED_ENTITY_COVERAGE_BYTES__).digest('hex') !== __COVERED_ENTITY_COVERAGE_SHA256__) {
    throw new Error('covered_entity_coverage_binding_refused');
  }
  const command = process.argv[2];
  if ((command !== "inspect" && command !== "destroy") || !["true", "false"].includes(required("PHI_ALLOWED"))) {
    throw new Error("covered_entity_command_refused");
  }
  const clusterArn = required("CLINICAL_DATABASE_CLUSTER_ARN");
  const secretArn = required("CLINICAL_DATABASE_SECRET_ARN");
  const match = clusterArn.match(CLUSTER_ARN);
  if (!match || match[2] !== required("EXPECTED_AWS_ACCOUNT_ID") || !SECRET_ARN.test(secretArn)) {
    throw new Error("account_boundary_refused");
  }
  const organizationId = required("ORGANIZATION_ID");
  const coverage = parseCoveredEntityCoverage(JSON.parse(__COVERED_ENTITY_COVERAGE_BYTES__));
  const expectedAccountId = required("EXPECTED_AWS_ACCOUNT_ID");
  const region = required("AWS_REGION");
  const profile = profileForOperatorAccount(expectedAccountId);
  assertOperatorAssumedRole(profile, expectedAccountId, region);
  const database = createRdsDataAdministrativeDatabase(
    { clusterArn, secretArn, databaseName: required("CLINICAL_DATABASE_NAME"), region },
    { purpose: "reviewed_covered_entity_termination" },
    new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 }),
  );

  const observed = await inspectCoveredEntityContent({ database, organizationId, coverage });
  if (command === "inspect") {
    console.log(JSON.stringify({
      mode: "covered_entity_content_inspection_read_only",
      phiAllowed: process.env.PHI_ALLOWED === "true",
      organizationId,
      tables: observed.rows.length,
      rows: observed.rows,
      storedObjects: observed.objects,
      legalHoldOpen: observed.holds,
      coverageSha256: __COVERED_ENTITY_COVERAGE_SHA256__,
      dispositionPending: coverage.tables.some(entry => entry.scope !== 'retained' && entry.appendOnly === true),
    }));
    return;
  }

  if (required("CONFIRM_COVERED_ENTITY_TERMINATION") !== "true") throw new Error("termination_unconfirmed");
  // The database is not the whole record. Objects are destroyed by the hold-aware cleanup path, never by this one.
  if (observed.objects > 0) throw new CoveredEntityDeletionError("objects_not_purged");
  const report = await deleteCoveredEntityContent({
    database,
    organizationId,
    coverage,
    termination: { terminationReference: required("COVERED_ENTITY_TERMINATION_REFERENCE"), confirmed: true },
  });
  console.log(JSON.stringify({ mode: "covered_entity_content_destroyed", phiAllowed: process.env.PHI_ALLOWED === "true", ...report }));
}

run().catch((error) => {
  console.error(error instanceof CoveredEntityDeletionError ? error.category : errorCode(error, "covered_entity_deletion_failed"));
  process.exitCode = 1;
});
