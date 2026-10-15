if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-identity-lambda is server-only.");
}

import { createAwsIdentityApiHandler } from "./aws-identity-api";
import { createRdsDataClinicalCoreDatabase } from "./rds-data-database";
import { identityNotificationPortsFrom } from "../notifications/notification-runtime";

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
  // PATIENT_NOTICES_ENABLED / SMS_NOTICES_ENABLED and NOTIFICATION_PREFERENCES_ENABLED. The identity
  // template sets neither, so both ports stay unset and both settings routes answer 503.
  ...identityNotificationPortsFrom(process.env, database),
  configuration: {
    workforceIssuer: required("CLINICAL_WORKFORCE_ISSUER"),
    workforceAudience: required("CLINICAL_WORKFORCE_AUDIENCE"),
    consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"),
    consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"),
  },
});
