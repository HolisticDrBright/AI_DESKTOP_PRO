import { createRecordingDraftingProcessor, createRecordingDraftingRepository } from './recording-drafting';
import { createAwsDraftingProvider } from './aws-recording-drafting-openai';
import { createAwsTranscriptionMediaStore } from './aws-recording-transcription-clients';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';

/** Loaded only after activation and identity checks; every operation is
 * authorized again in the database and the provider sees transcript text only. */
export function createRecordingDraftingRuntime(e: NodeJS.ProcessEnv) {
  const database = createRdsDataClinicalCoreDatabase({ clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '',
    secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '', databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION });
  return createRecordingDraftingProcessor({ repository: createRecordingDraftingRepository(database), media: createAwsTranscriptionMediaStore(),
    provider: createAwsDraftingProvider({ secretArn: e.RECORDING_DRAFTING_OPENAI_SECRET_ARN ?? '' }), releaseId: e.RECORDING_DRAFTING_RELEASE_ID ?? '' });
}
