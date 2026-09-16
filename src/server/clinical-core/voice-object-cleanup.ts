import {DeleteObjectsCommand,ListObjectVersionsCommand,type S3Client} from '@aws-sdk/client-s3';
/** Purge only the two server-derived keys, including historical versions.
 * A marker-only delete is not physical erasure on a versioned bucket. */
export async function erasePersonalVoiceObjects(client:S3Client,bucket:string,job:{id:string;format:string}){
  if(!/^[a-f0-9]{64}$/.test(job.id)||!['wav','mp4'].includes(job.format))throw new Error('voice_cleanup_scope_invalid');
  const keys=[`personal-voice/input/${job.id}.${job.format}`,`personal-voice/output/${job.id}.json`];
  for(const key of keys){
    let emptied=false;
    for(let page=0;page<25;page++){
      const result=await client.send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:key,MaxKeys:1000}));
      const versions=[...(result.Versions??[]),...(result.DeleteMarkers??[])];
      if(versions.some(v=>v.Key!==key||typeof v.VersionId!=='string'||!v.VersionId))throw new Error('voice_cleanup_scope_invalid');
      if(!versions.length){if(result.IsTruncated)throw new Error('voice_cleanup_incomplete');emptied=true;break;}
      const deleted=await client.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:versions.map(v=>({Key:key,VersionId:v.VersionId!})),Quiet:true}}));
      if(deleted.Errors?.length)throw new Error('voice_cleanup_retry_required');
    }
    if(!emptied)throw new Error('voice_cleanup_incomplete');
  }
}
