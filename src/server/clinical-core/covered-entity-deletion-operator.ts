if (typeof window !== "undefined") {
  throw new Error("covered-entity-deletion-operator is server-only.");
}

import { readFileSync } from "node:fs";

import { errorCode } from "./log-safe-error";
import {
  CoveredEntityDeletionError,
  deleteCoveredEntityContent,
  inspectCoveredEntityContent,
  parseCoveredEntityCoverage,
} from "./covered-entity-deletion";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";

/**
 * Operator entry point for destroying one covered entity's information when its agreement ends.
 *
 * `inspect` is read-only: it reports what the organization still holds, table by table, how many stored objects hang
 * off it, and whether a legal hold is open. `destroy` removes it in one transaction and verifies that nothing is left.
 *
 * `destroy` refuses while any stored object is still registered. Objects live under versioning and object lock, and the
 * hold-aware recording cleanup path is what may remove them; this tool will not claim a destruction that only emptied
 * the database. Run that path first, then run this. Every command pins the AWS account through the cluster ARN and
 * requires the PHI posture to be stated.
 */
const CLUSTER_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;
const COVERAGE_PATH = "infra/aws-clinical-core/covered-entity-coverage.json";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function run() {
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
  const coverage = parseCoveredEntityCoverage(JSON.parse(readFileSync(process.env.COVERAGE_PATH?.trim() || COVERAGE_PATH, "utf8")));
  const database = createRdsDataAdministrativeDatabase(
    { clusterArn, secretArn, databaseName: required("CLINICAL_DATABASE_NAME"), region: required("AWS_REGION") },
    { purpose: "reviewed_covered_entity_termination" },
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
