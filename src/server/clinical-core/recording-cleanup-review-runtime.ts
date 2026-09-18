import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {createRecordingCleanupQueue} from './recording-cleanup-queue';
export function createRecordingCleanupReviewRuntime(e:NodeJS.ProcessEnv){
  const queue=createRecordingCleanupQueue(createRdsDataClinicalCoreDatabase({clusterArn:e.CLINICAL_DATABASE_CLUSTER_ARN??'',
    secretArn:e.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:e.CLINICAL_DATABASE_NAME??'',region:e.AWS_REGION}));
  return {list:queue.list,history:queue.history};
}
