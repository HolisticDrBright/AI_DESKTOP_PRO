if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog-lambda is server-only.");
}

import { createAwsGovernedCatalogApiHandler } from "./aws-governed-catalog-api";
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

export const handler = createAwsGovernedCatalogApiHandler({
  database,
  configuration: {
    environment: required("CLINICAL_CATALOG_ENVIRONMENT") as "synthetic-staging" | "production-clinical",
    workforceIssuer: required("CLINICAL_WORKFORCE_ISSUER"),
    workforceAudience: required("CLINICAL_WORKFORCE_AUDIENCE"),
    consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"),
    consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
  },
});
