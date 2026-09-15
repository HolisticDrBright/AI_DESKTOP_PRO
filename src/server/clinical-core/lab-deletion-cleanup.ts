import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';

export const LAB_CLEANUP_VERSION = 'lab-deletion-cleanup/1';
export const LAB_CLEANUP_INDEX = 'LabCleanupDue';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const subject = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = {ownerSub:string;organizationId:string;personId:string};
type Cleanup = Scope & {pk:string;contractVersion:string;requestedAt:string;cleanupPartition:'pending'|'watching';cleanupDue:string;lastVerifiedAt?:string};
type Dependencies = {db:DynamoDBDocumentClient;s3:S3Client;table:string;bucket:string;now?:()=>number};
const invalid = ():never => {throw new Error('lab_cleanup_invalid');};
const sameOwner = (a:Scope,b:Scope) => a.ownerSub===b.ownerSub && a.organizationId===b.organizationId && a.personId===b.personId;
function validateScope(scope:Scope,jobId:string) {
  if(!uuid.test(jobId)||!subject.test(scope.ownerSub)||!uuid.test(scope.organizationId)||!uuid.test(scope.personId))invalid();
}
function validDate(value:unknown) {return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function validateCleanup(value:Record<string,unknown>,jobId:string):Cleanup {
  const allowed=['pk','contractVersion','ownerSub','organizationId','personId','requestedAt','cleanupPartition','cleanupDue','lastVerifiedAt'];
  if(Object.keys(value).some(key=>!allowed.includes(key)) || value.pk!=='cleanup#'+jobId
    || value.contractVersion!==LAB_CLEANUP_VERSION || !['pending','watching'].includes(String(value.cleanupPartition))
    || !validDate(value.requestedAt)||!validDate(value.cleanupDue)
    || value.lastVerifiedAt!==undefined&&!validDate(value.lastVerifiedAt))invalid();
  const row=value as Cleanup;validateScope(row,jobId);return row;
}
async function readCleanup(deps:Dependencies,jobId:string) {
  if(!uuid.test(jobId))invalid();
  const result=await deps.db.send(new GetCommand({TableName:deps.table,Key:{pk:'cleanup#'+jobId},ConsistentRead:true}));
  return result.Item?validateCleanup(result.Item,jobId):null;
}
/** Atomically fences processing and persists a minimal outbox before any purge.
 * No health values, file names, credentials or automatic tombstone TTL. */
export async function claimLabDeletion(deps:Dependencies,scope:Scope,jobId:string) {
  validateScope(scope,jobId);
  const now=(deps.now??Date.now)(),iso=new Date(now).toISOString();
  await deps.db.send(new TransactWriteCommand({TransactItems:[
    {Update:{TableName:deps.table,Key:{pk:'job#'+jobId},
      UpdateExpression:'SET #state = :deleting, updatedAt = :now',
      ConditionExpression:'ownerSub = :owner AND organizationId = :org AND personId = :person AND #state IN (:awaiting, :completed, :review, :failed, :deleting) AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :epoch)',
      ExpressionAttributeNames:{'#state':'state'},ExpressionAttributeValues:{':owner':scope.ownerSub,':org':scope.organizationId,':person':scope.personId,
        ':awaiting':'awaiting_upload',':completed':'completed',':review':'needs_review',':failed':'failed',':deleting':'deleting',':now':iso,':epoch':now}}},
    {Update:{TableName:deps.table,Key:{pk:'cleanup#'+jobId},
      UpdateExpression:'SET contractVersion = :version, ownerSub = :owner, organizationId = :org, personId = :person, requestedAt = if_not_exists(requestedAt, :now), cleanupPartition = :pending, cleanupDue = :now',
      ConditionExpression:'attribute_not_exists(pk) OR (ownerSub = :owner AND organizationId = :org AND personId = :person AND contractVersion = :version)',
      ExpressionAttributeValues:{':version':LAB_CLEANUP_VERSION,':owner':scope.ownerSub,':org':scope.organizationId,':person':scope.personId,':now':iso,':pending':'pending'}}},
  ]}));
}
async function purge(deps:Dependencies,prefix:string) {
  // Re-list from the beginning after deleting each page. Retry is safe after
  // partial failure; never skip versions using a marker we just deleted.
  for(let page=0;page<32;page++){
    const result=await deps.s3.send(new ListObjectVersionsCommand({Bucket:deps.bucket,Prefix:prefix,MaxKeys:1000}));
    const entries=[...(result.Versions??[]),...(result.DeleteMarkers??[])];
    if(entries.some(item=>typeof item.Key!=='string'||!item.Key.startsWith(prefix)||typeof item.VersionId!=='string'||!item.VersionId))invalid();
    if(!entries.length){if(result.IsTruncated)invalid();return;}
    const removed=await deps.s3.send(new DeleteObjectsCommand({Bucket:deps.bucket,
      Delete:{Objects:entries.map(item=>({Key:item.Key!,VersionId:item.VersionId!})),Quiet:true}}));
    if(removed.Errors?.length)throw new Error('lab_cleanup_retry_required');
  }
  throw new Error('lab_cleanup_retry_required');
}
/** Called by the owned API, retry sweep and late-object notification. Events
 * alone never authorize deletion: the durable outbox and current job do. */
export async function reconcileLabDeletion(deps:Dependencies,jobId:string,expected?:Scope,objectKey?:string) {
  const record=await readCleanup(deps,jobId);
  if(!record)return null;
  if(expected&&!sameOwner(record,expected))invalid();
  const sourcePrefix=`synthetic-labs/${record.organizationId}/${record.ownerSub}/${jobId}/`;
  const artifactPrefix=`synthetic-labs/artifacts/${jobId}/`;
  if(objectKey!==undefined&&!objectKey.startsWith(sourcePrefix)&&!objectKey.startsWith(artifactPrefix))invalid();
  const current=await deps.db.send(new GetCommand({TableName:deps.table,Key:{pk:'job#'+jobId},ConsistentRead:true}));
  if(current.Item&&(!sameOwner(current.Item as Scope,record)||current.Item.state!=='deleting'
    ||Number(current.Item.leaseUntil??0)>(deps.now??Date.now)()))throw new Error('lab_cleanup_state_conflict');
  await purge(deps,sourcePrefix);await purge(deps,artifactPrefix);
  await deps.db.send(new DeleteCommand({TableName:deps.table,Key:{pk:'job#'+jobId},
    ConditionExpression:'attribute_not_exists(pk) OR (ownerSub = :owner AND organizationId = :org AND personId = :person AND #state = :deleting AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :epoch))',
    ExpressionAttributeNames:{'#state':'state'},ExpressionAttributeValues:{':owner':record.ownerSub,':org':record.organizationId,':person':record.personId,
      ':deleting':'deleting',':epoch':(deps.now??Date.now)()}}));
  const now=(deps.now??Date.now)(),lastVerifiedAt=new Date(now).toISOString();
  await deps.db.send(new UpdateCommand({TableName:deps.table,Key:{pk:record.pk},
    UpdateExpression:'SET cleanupPartition = :watching, cleanupDue = :next, lastVerifiedAt = :now',
    ConditionExpression:'ownerSub = :owner AND organizationId = :org AND personId = :person AND requestedAt = :requested AND contractVersion = :version',
    ExpressionAttributeValues:{':owner':record.ownerSub,':org':record.organizationId,':person':record.personId,':requested':record.requestedAt,
      ':version':LAB_CLEANUP_VERSION,':watching':'watching',
      ':next':new Date(now+(now-Date.parse(record.requestedAt)<60*60*1000?5*60*1000:24*60*60*1000)).toISOString(),':now':lastVerifiedAt}}));
  return {cleanupVersion:LAB_CLEANUP_VERSION,cleanupStatus:'late_upload_watch' as const,lastVerifiedAt};
}
export async function sweepLabDeletions(deps:Dependencies) {
  let checked=0,failed=0;
  for(const partition of ['pending','watching']){
    // Bound each invocation, but continue past failed rows instead of letting
    // one poison item starve the entire first page.
    let after:Record<string,unknown>|undefined;
    for(let batch=0;batch<4;batch++){
      const page=await deps.db.send(new QueryCommand({TableName:deps.table,IndexName:LAB_CLEANUP_INDEX,
        KeyConditionExpression:'cleanupPartition = :partition AND cleanupDue <= :now',
        ExpressionAttributeValues:{':partition':partition,':now':new Date((deps.now??Date.now)()).toISOString()},
        Limit:20,ScanIndexForward:true,...(after?{ExclusiveStartKey:after}:{})}));
      for(const row of page.Items??[]){
        try{
          if(typeof row.pk!=='string'||!row.pk.startsWith('cleanup#'))invalid();
          await reconcileLabDeletion(deps,row.pk.slice(8));checked++;
        }catch{failed++;}
      }
      after=page.LastEvaluatedKey;
      if(!after)break;
      if(Object.keys(after).sort().join(',')!=='cleanupDue,cleanupPartition,pk'||after.cleanupPartition!==partition
        ||!validDate(after.cleanupDue)||typeof after.pk!=='string'||!after.pk.startsWith('cleanup#')||!uuid.test(after.pk.slice(8)))invalid();
    }
  }
  if(failed)throw new Error('lab_cleanup_retry_required');
  return {checked};
}
/** Reject arbitrary bucket/key paths. Do not URL-decode EventBridge object keys:
 * they are supplied as keys, not form-encoded S3 notification keys. */
export function cleanupJobFromObjectKey(key:unknown) {
  if(typeof key!=='string'||key.length>1024)return null;
  const parts=key.split('/');
  if(parts[0]!=='synthetic-labs')return null;
  if(parts[1]==='artifacts')return uuid.test(parts[2]??'')&&parts.length>3?parts[2]:null;
  if(!uuid.test(parts[1]??'')||!subject.test(parts[2]??'')||!uuid.test(parts[3]??'')||parts.length<6)return null;
  return parts[3];
}
