import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import { stopLabExecutions } from './lab-execution-stop';
import { cleanupJobFromObjectKey, reconcileLabDeletion, sweepLabDeletions } from './lab-deletion-cleanup';

const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
const s3=new S3Client({});
const sfn=new SFNClient({});
function required(name:string){const value=process.env[name];if(!value)throw new Error('lab_cleanup_configuration_missing');return value;}
export async function labCleanupHandler(event:unknown) {
  try{
    if(process.env.PHI_ALLOWED!=='false'||process.env.DATA_CLASSIFICATION!=='synthetic_only')throw new Error('lab_cleanup_posture_invalid');
    const deps={db,s3,table:required('LAB_JOB_TABLE'),bucket:required('LAB_DOCUMENT_BUCKET'),
      stopExecutions:(id:string)=>stopLabExecutions(sfn,required('LAB_STATE_MACHINE_ARN'),id)};
    const value=event as Record<string,unknown>;
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('lab_cleanup_event_invalid');
    if(value.kind==='sweep' && Object.keys(value).length===1)return await sweepLabDeletions(deps);
    // EventBridge input transformer strips unrelated fields before Lambda
    // invocation. EventBridge's own delivery DLQ can retain the original event;
    // treat that encrypted queue as restricted operational metadata.
    if(Object.keys(value).sort().join(',')!=='bucket,key,kind'||value.kind!=='created'||value.bucket!==deps.bucket)
      throw new Error('lab_cleanup_event_invalid');
    const jobId=cleanupJobFromObjectKey(value.key);
    if(!jobId)throw new Error('lab_cleanup_event_invalid');
    const result=await reconcileLabDeletion(deps,jobId,undefined,value.key as string);
    return {checked:result?1:0};
  }catch{
    // Never serialize an SDK error, event, key, identity or clinical payload.
    console.error('lab_cleanup_failed');
    throw new Error('lab_cleanup_retry_required');
  }
}
