if(typeof window!=='undefined')throw new Error('aws-recording-cleanup-store is server-only');
import {S3Client,ListObjectVersionsCommand,HeadObjectCommand,DeleteObjectCommand,GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,GetObjectLegalHoldCommand,GetObjectRetentionCommand} from '@aws-sdk/client-s3';
import {RecordingCleanupError,type RecordingCleanupAdmission} from './recording-cleanup-authority';
import {cleanupVersionSchema,cleanupTarget,targetIds,type CleanupObjectVersion,type RecordingCleanupStore} from './recording-cleanup-worker';

/** No ambient/custom endpoint or region redirect. Only explicit version deletes;
 * no bucket-wide delete, unversioned delete, governance bypass or hold mutation. */
export function createAwsRecordingCleanupStore(clientForRegion=(region:string)=>new S3Client({region,
  endpoint:`https://s3.${region}.amazonaws.com`,followRegionRedirects:false,maxAttempts:1})):RecordingCleanupStore{
  const clients=new Map<string,S3Client>();
  const client=(region:string)=>{let c=clients.get(region);if(!c){c=clientForRegion(region);clients.set(region,c);}return c;};
  const bucket=(a:RecordingCleanupAdmission)=>({Bucket:a.storage.bucket,ExpectedBucketOwner:a.storage.expectedBucketOwner});
  const base=(a:RecordingCleanupAdmission,v:CleanupObjectVersion)=>{
    if(!cleanupVersionSchema.safeParse(v).success)throw new RecordingCleanupError('access_refused');
    cleanupTarget(a,v);
    return {...bucket(a),Key:v.key,VersionId:v.version};
  };
  const check=(signal:AbortSignal)=>{if(signal.aborted)throw new RecordingCleanupError('service_unavailable');};
  return {
    async list(a,signal){
      const c=client(a.storage.region);check(signal);
      const versioning=await c.send(new GetBucketVersioningCommand(bucket(a)),{abortSignal:signal});check(signal);
      if(versioning.Status!=='Enabled')throw new RecordingCleanupError('access_refused');
      const lock=await c.send(new GetObjectLockConfigurationCommand(bucket(a)),{abortSignal:signal});check(signal);
      if(lock.ObjectLockConfiguration?.ObjectLockEnabled!=='Enabled')throw new RecordingCleanupError('access_refused');
      const result=await c.send(new ListObjectVersionsCommand({...bucket(a),
        // The recording prefix covers the capture session's segments and every transcription job's objects.
        Prefix:`encounter-recordings/${a.organizationId}/${a.recordingId}/`,MaxKeys:100}),{abortSignal:signal});check(signal);
      if(typeof result.IsTruncated!=='boolean')throw new RecordingCleanupError('service_unavailable');
      return {versions:[...(result.Versions??[]).map(v=>cleanupVersionSchema.parse({key:v.Key,version:v.VersionId,kind:'object'})),
        ...(result.DeleteMarkers??[]).map(v=>cleanupVersionSchema.parse({key:v.Key,version:v.VersionId,kind:'delete_marker'}))],truncated:result.IsTruncated};
    },
    async inspect(a,v,signal){
      const c=client(a.storage.region),input=base(a,v);check(signal);
      const head=await c.send(new HeadObjectCommand({...input,ChecksumMode:'ENABLED'}),{abortSignal:signal});check(signal);
      // HEAD may omit lock headers when permission is missing. Explicit lock
      // reads must succeed; AccessDenied/missing state is never interpreted OFF.
      const hold=await c.send(new GetObjectLegalHoldCommand(input),{abortSignal:signal});check(signal);
      const retention=await c.send(new GetObjectRetentionCommand(input),{abortSignal:signal});check(signal);
      if(hold.LegalHold?.Status!=='ON'&&hold.LegalHold?.Status!=='OFF'||!retention.Retention)
        throw new RecordingCleanupError('service_unavailable');
      const r=retention.Retention;
      if(r.Mode!==undefined&&r.Mode!=='GOVERNANCE'&&r.Mode!=='COMPLIANCE'||r.Mode!==undefined&&!r.RetainUntilDate
        ||r.RetainUntilDate!==undefined&&(!(r.RetainUntilDate instanceof Date)||!Number.isFinite(r.RetainUntilDate.getTime())))
        throw new RecordingCleanupError('service_unavailable');
      return {version:head.VersionId,bytes:head.ContentLength,checksum:head.ChecksumSHA256,checksumType:head.ChecksumType,
        encryption:head.ServerSideEncryption,kmsKeyArn:head.SSEKMSKeyId,metadata:head.Metadata,deleteMarker:head.DeleteMarker,
        legalHold:hold.LegalHold.Status,retentionVerified:true,retainUntil:r.RetainUntilDate?.toISOString()};
    },
    async remove(a,v,signal){
      const input=base(a,v);check(signal);
      const ids=targetIds(cleanupTarget(a,v));
      if(!a.runId||!a.attempt||a.attempt.objectVersion!==v.version||a.attempt.kind!==v.kind
        ||ids.segmentId!==a.attempt.segmentId||ids.artifactId!==a.attempt.artifactId)throw new RecordingCleanupError('access_refused');
      const result=await client(a.storage.region).send(new DeleteObjectCommand(input),{abortSignal:signal});check(signal);
      return {version:result.VersionId,deleteMarker:result.DeleteMarker};
    },
  };
}
