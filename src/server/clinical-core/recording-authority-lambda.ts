import type { ApiGatewayV2Event } from "./aws-identity-api";
import { qualificationActivation, qualificationFrom } from './qualification-execution';
import { createRecordingAuthorityApi } from "./recording-authority-api";
import { createEncounterRecordingOperations } from "./encounter-recording-operations";
import { createRdsDataClinicalCoreDatabase } from "./rds-data-database";

let cached: ReturnType<typeof createRecordingAuthorityApi> | undefined;
export async function handler(event: ApiGatewayV2Event) {
  if (!cached) {
    const e = process.env;
    cached = createRecordingAuthorityApi({ configuration: {
      workforceIssuer: e.WORKFORCE_ISSUER ?? "", workforceAudience: e.WORKFORCE_AUDIENCE ?? "",
      organizationId: e.RECORDING_ORGANIZATION_ID ?? "", phiAllowed: e.PHI_ALLOWED === "true",
      activation: qualificationActivation(e.RECORDING_AUTHORITY_ACTIVATION), ...qualificationFrom(e, e.RECORDING_AUTHORITY_ACTIVATION),
      activationEvidenceSha256: e.RECORDING_AUTHORITY_EVIDENCE_SHA256,
      mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256, databaseReviewSha256: e.DATABASE_REVIEW_SHA256,
    }, operations: () => createEncounterRecordingOperations(createRdsDataClinicalCoreDatabase({
      clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? "", secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? "",
      databaseName: e.CLINICAL_DATABASE_NAME ?? "", region: e.AWS_REGION,
    })) });
  }
  return cached(event);
}
