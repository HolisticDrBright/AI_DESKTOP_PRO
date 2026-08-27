if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-identity-lambda is server-only.");
}

import { createAwsIdentityApiHandler } from "./aws-identity-api";
import { createRdsDataClinicalCoreDatabase } from "./rds-data-database";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("clinical_core_runtime_configuration_missing");
  return value;
}

const database = createRdsDataClinicalCoreDatabase({
  clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
  secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
  databaseName: required("CLINICAL_DATABASE_NAME"),
  region: process.env.AWS_REGION,
});

export const handler = createAwsIdentityApiHandler({
  database,
  configuration: {
    workforceIssuer: required("CLINICAL_WORKFORCE_ISSUER"),
    workforceAudience: required("CLINICAL_WORKFORCE_AUDIENCE"),
    consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"),
    consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
  },
});
