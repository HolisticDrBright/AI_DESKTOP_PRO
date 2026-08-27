if (typeof window !== "undefined") {
  throw new Error("aws-production-clinical-lambda is server-only.");
}

import { createAwsProductionIdentityApiHandler } from "./aws-identity-api";
import { createAwsProductionIdentityConsentAdapter } from "./aws-identity-consent";
import { createAwsProductionClinicalStateAdapter } from "./aws-clinical-state";
import { createAwsProductionConsumerClinicalRecordsAdapter } from "./aws-consumer-clinical-records";
import { createAwsProductionDesktopAdapter } from "./aws-production-desktop";
import { createRdsDataClinicalCoreDatabase } from "./rds-data-database";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("production_clinical_runtime_configuration_missing");
  return value;
}

const phiAllowed = required("PHI_ALLOWED") === "true";
const pilotScope = required("PILOT_SCOPE");
if (pilotScope !== "lab_intake_only") throw new Error("production_pilot_scope_invalid");
const database = createRdsDataClinicalCoreDatabase({
  clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
  secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
  databaseName: required("CLINICAL_DATABASE_NAME"),
  region: process.env.AWS_REGION,
});

export const handler = createAwsProductionIdentityApiHandler({
  adapter: createAwsProductionIdentityConsentAdapter(database),
  clinicalStateAdapter: createAwsProductionClinicalStateAdapter(database),
  clinicalRecordsAdapter: createAwsProductionConsumerClinicalRecordsAdapter(database),
  desktopCompatibilityAdapter: createAwsProductionDesktopAdapter(database),
  configuration: {
    workforceIssuer: required("CLINICAL_WORKFORCE_ISSUER"),
    workforceAudience: required("CLINICAL_WORKFORCE_AUDIENCE"),
    consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"),
    consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
    phiAllowed,
    activationState: required("ACTIVATION_STATE") === "approved" ? "approved" : "blocked",
    pilotScope,
    ...(process.env.PILOT_ORGANIZATION_ID?.trim()
      ? { pilotOrganizationId: process.env.PILOT_ORGANIZATION_ID.trim() }
      : {}),
    ...(process.env.ACTIVATION_EVIDENCE_SHA256
      ? { activationEvidenceSha256: process.env.ACTIVATION_EVIDENCE_SHA256 }
      : {}),
  },
});
