import { createRecordingTranscriptionProcessor, createRecordingTranscriptionRepository } from './recording-transcription';
import { createAwsTranscriptionMediaStore, createAwsTranscriptionProvider } from './aws-recording-transcription-clients';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';

/** Loaded only after activation and identity checks; SDK clients reused across
 * warm invocations while every operation is authorized in the database. */
export function createRecordingTranscriptionRuntime(e: NodeJS.ProcessEnv) {
  const database = createRdsDataClinicalCoreDatabase({ clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '',
    secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '', databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION });
  return createRecordingTranscriptionProcessor({ repository: createRecordingTranscriptionRepository(database),
    media: createAwsTranscriptionMediaStore(), provider: createAwsTranscriptionProvider(), releaseId: e.RECORDING_TRANSCRIPTION_RELEASE_ID ?? '' });
}
