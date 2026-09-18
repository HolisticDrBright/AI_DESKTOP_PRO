import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {createRecordingCleanupQueue,createRecordingCleanupRunner} from './recording-cleanup-queue';
import {createRecordingCleanupAuthority} from './recording-cleanup-authority';
import {createRecordingCleanupAttempts} from './recording-cleanup-attempts';
import {createRecordingCleanupWorker} from './recording-cleanup-worker';
import {createAwsRecordingCleanupStore} from './aws-recording-cleanup-store';
export function createRecordingCleanupExecutionRuntime(e:NodeJS.ProcessEnv){
  const database=createRdsDataClinicalCoreDatabase({clusterArn:e.CLINICAL_DATABASE_CLUSTER_ARN??'',
    secretArn:e.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:e.CLINICAL_DATABASE_NAME??'',region:e.AWS_REGION});
  return createRecordingCleanupRunner(createRecordingCleanupQueue(database),createRecordingCleanupWorker({
    authorize:createRecordingCleanupAuthority(database),attempts:createRecordingCleanupAttempts(database),
    storage:createAwsRecordingCleanupStore(),maximumMs:8000,
  }));
}
