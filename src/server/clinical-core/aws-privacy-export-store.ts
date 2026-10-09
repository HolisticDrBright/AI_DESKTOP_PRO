if(typeof window!=='undefined')throw new Error('aws-privacy-export-store is server-only');
import {AbortMultipartUploadCommand,CompleteMultipartUploadCommand,CreateMultipartUploadCommand,DeleteObjectCommand,GetObjectCommand,HeadObjectCommand,ListMultipartUploadsCommand,ListObjectVersionsCommand,PutObjectCommand,S3Client,UploadPartCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import type {PrivacyExportObjectStorage,PrivacyExportStore} from './owned-privacy-export-job';

/** Fixed regional endpoint, expected bucket owner on every call, SSE-KMS with the
 * reviewed key, full-object checksums, versioned deletes only. Listing is by one
 * job's key prefix under `personal-exports/`, used to prove nothing remains. */
export function createAwsPrivacyExportStore(clientForRegion=(region:string)=>new S3Client({region,endpoint:`https://s3.${region}.amazonaws.com`,followRegionRedirects:false,maxAttempts:2})):PrivacyExportStore{
  const clients=new Map<string,S3Client>();
  const client=(region:string)=>{let c=clients.get(region);if(!c){c=clientForRegion(region);clients.set(region,c);}return c;};
  const base=(s:PrivacyExportObjectStorage,key:string)=>({Bucket:s.bucket,Key:key,ExpectedBucketOwner:s.expectedBucketOwner});
  const b64=(hex:string)=>Buffer.from(hex,'hex').toString('base64');
  return {
    async createUpload(s,key,signal){
      const r=await client(s.region).send(new CreateMultipartUploadCommand({...base(s,key),ContentType:'application/json',ServerSideEncryption:'aws:kms',SSEKMSKeyId:s.kmsKeyArn,
        ChecksumAlgorithm:'SHA256',Metadata:{'export-kind':'personal-storage-copy'}}),{abortSignal:signal});
      if(!r.UploadId)throw new Error('privacy_export_upload_failed');return {uploadId:r.UploadId};
    },
    async uploadPart(s,key,uploadId,partNumber,body,sha256Hex,signal){
      const r=await client(s.region).send(new UploadPartCommand({...base(s,key),UploadId:uploadId,PartNumber:partNumber,Body:body,ContentLength:body.byteLength,
        ChecksumAlgorithm:'SHA256',ChecksumSHA256:b64(sha256Hex)}),{abortSignal:signal});
      if(!r.ETag)throw new Error('privacy_export_upload_failed');return {etag:r.ETag};
    },
    async completeUpload(s,key,uploadId,parts,signal){
      const r=await client(s.region).send(new CompleteMultipartUploadCommand({...base(s,key),UploadId:uploadId,
        MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.partNumber,ETag:p.etag,ChecksumSHA256:b64(p.sha256Hex)}))}}),{abortSignal:signal});
      if(!r.VersionId||!r.ChecksumSHA256)throw new Error('privacy_export_upload_failed');return {version:r.VersionId,checksum:r.ChecksumSHA256};
    },
    async abortUpload(s,key,uploadId,signal){await client(s.region).send(new AbortMultipartUploadCommand({...base(s,key),UploadId:uploadId}),{abortSignal:signal});},
    async put(s,key,body,sha256Hex,signal){
      const r=await client(s.region).send(new PutObjectCommand({...base(s,key),Body:body,ContentLength:body.byteLength,ContentType:'application/json',
        ChecksumAlgorithm:'SHA256',ChecksumSHA256:b64(sha256Hex),ServerSideEncryption:'aws:kms',SSEKMSKeyId:s.kmsKeyArn}),{abortSignal:signal});
      if(!r.VersionId)throw new Error('privacy_export_upload_failed');return {version:r.VersionId};
    },
    async get(s,key,version,maxBytes,signal){
      const r=await client(s.region).send(new GetObjectCommand({...base(s,key),VersionId:version}),{abortSignal:signal});
      if(r.ContentLength===undefined||r.ContentLength>maxBytes||!r.Body)throw new Error('privacy_export_staging_invalid');
      const bytes=await r.Body.transformToByteArray();if(bytes.byteLength!==r.ContentLength)throw new Error('privacy_export_staging_invalid');return bytes;
    },
    async head(s,key,version,signal,options){
      // The checksum of an SSE-KMS object is returned only with ChecksumMode and key access; cleanup never asks for it.
      try{
        const r=await client(s.region).send(new HeadObjectCommand({...base(s,key),VersionId:version,...(options?.checksum?{ChecksumMode:'ENABLED'}:{})}),{abortSignal:signal});
        return {exists:r.DeleteMarker!==true,bytes:r.ContentLength,encryption:r.ServerSideEncryption,kmsKeyArn:r.SSEKMSKeyId,...(options?.checksum?{checksum:r.ChecksumSHA256}:{})};
      }catch(error){
        const name=(error as {name?:string;$metadata?:{httpStatusCode?:number}})?.name,status=(error as {$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode;
        // Only an explicit 404 is absence. A 403 (no bucket-list permission, denied key) is not absence and is rethrown.
        if(name==='NotFound'||name==='NoSuchKey'||name==='NoSuchVersion'||status===404)return {exists:false};
        throw error;
      }
    },
    async deleteVersion(s,key,version,signal){await client(s.region).send(new DeleteObjectCommand({...base(s,key),VersionId:version}),{abortSignal:signal});},
    async listUploads(s,keyPrefix,signal){
      if(!keyPrefix.startsWith('personal-exports/'))throw new Error('privacy_export_prefix_invalid');
      const out:{key:string;uploadId:string}[]=[];let keyMarker:string|undefined,uploadIdMarker:string|undefined;
      for(let page=0;page<20;page++){
        const r=await client(s.region).send(new ListMultipartUploadsCommand({Bucket:s.bucket,ExpectedBucketOwner:s.expectedBucketOwner,Prefix:keyPrefix,MaxUploads:1000,
          KeyMarker:keyMarker,UploadIdMarker:uploadIdMarker}),{abortSignal:signal});
        for(const u of r.Uploads??[])if(typeof u.Key==='string'&&typeof u.UploadId==='string')out.push({key:u.Key,uploadId:u.UploadId});
        if(!r.IsTruncated)return out;
        keyMarker=r.NextKeyMarker;uploadIdMarker=r.NextUploadIdMarker;
        if(!keyMarker&&!uploadIdMarker)break;
      }
      throw new Error('privacy_export_listing_truncated');
    },
    async listVersions(s,keyPrefix,signal){
      if(!keyPrefix.startsWith('personal-exports/'))throw new Error('privacy_export_prefix_invalid');
      const out:{key:string;version:string;bytes:number|null;deleteMarker:boolean}[]=[];let keyMarker:string|undefined,versionIdMarker:string|undefined;
      for(let page=0;page<20;page++){
        const r=await client(s.region).send(new ListObjectVersionsCommand({Bucket:s.bucket,ExpectedBucketOwner:s.expectedBucketOwner,Prefix:keyPrefix,MaxKeys:1000,
          KeyMarker:keyMarker,VersionIdMarker:versionIdMarker}),{abortSignal:signal});
        for(const v of r.Versions??[])if(typeof v.Key==='string'&&typeof v.VersionId==='string')out.push({key:v.Key,version:v.VersionId,bytes:typeof v.Size==='number'?v.Size:null,deleteMarker:false});
        for(const m of r.DeleteMarkers??[])if(typeof m.Key==='string'&&typeof m.VersionId==='string')out.push({key:m.Key,version:m.VersionId,bytes:null,deleteMarker:true});
        if(!r.IsTruncated)return out;
        keyMarker=r.NextKeyMarker;versionIdMarker=r.NextVersionIdMarker;
        if(!keyMarker&&!versionIdMarker)break;
      }
      throw new Error('privacy_export_listing_truncated');
    },
    signDownload(s,key,version,seconds,fileName){
      return getSignedUrl(client(s.region),new GetObjectCommand({...base(s,key),VersionId:version,ResponseContentType:'application/json',ResponseCacheControl:'no-store',
        ResponseContentDisposition:`attachment; filename="${fileName}"`}),{expiresIn:seconds});
    },
  };
}
