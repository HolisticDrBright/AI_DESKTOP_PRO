import { createRecordingLifecycleRepository } from './recording-lifecycle';
import { createRecordingSegmentRepository, createRecordingSegmentUploader } from './recording-segments';
import { createAwsRecordingSegmentStore } from './aws-recording-segment-store';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';

/** Loaded only after activation, identity and request checks. Reuse SDK clients
 * across warm invocations; database authorization still runs on every operation. */
export function createRecordingCaptureRuntime(e: NodeJS.ProcessEnv) {
  const database = createRdsDataClinicalCoreDatabase({ clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '',
    secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '', databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION });
  return { lifecycle: createRecordingLifecycleRepository(database),
    upload: createRecordingSegmentUploader(createRecordingSegmentRepository(database), createAwsRecordingSegmentStore()) };
}
