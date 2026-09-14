import {GetObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {verifyKnowledgeRelease,retrieveKnowledge,type KnowledgeQuery,type KnowledgeContext} from './reviewed-knowledge';
const s3=new S3Client({});
export type KnowledgeLoader=(query:KnowledgeQuery)=>Promise<KnowledgeContext|null>;
/** No cache: every read observes disabled configuration, revoked/deleted objects,
 * and expiry. The immutable version/hash and signer are deployment-owned. */
export const loadReviewedKnowledge:KnowledgeLoader=async query=>{
  const env=process.env;const mode=env.KNOWLEDGE_RELEASE_MODE??'disabled';
  if(mode==='disabled')return null;
  if(mode!=='reviewed_release')throw new Error('knowledge_release_refused');
  const bucket=env.KNOWLEDGE_RELEASE_BUCKET??'',key=env.KNOWLEDGE_RELEASE_KEY??'',version=env.KNOWLEDGE_RELEASE_OBJECT_VERSION??'';
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||!/^reviewed-knowledge\/[A-Za-z0-9_./-]+\.json$/.test(key)||!version||version==='null'||version.length>1024)throw new Error('knowledge_release_refused');
  try{
    const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key,VersionId:version}),{abortSignal:AbortSignal.timeout(10_000)});
    if(object.VersionId!==version||!object.Body||object.ContentLength===undefined||object.ContentLength>2_100_000)throw new Error();
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of object.Body as AsyncIterable<Uint8Array>){size+=chunk.byteLength;if(size>2_100_000)throw new Error();chunks.push(chunk);}
    const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return retrieveKnowledge(verifyKnowledgeRelease(envelope,{sha256:env.KNOWLEDGE_RELEASE_SHA256??'',publicKeyPem:env.KNOWLEDGE_SIGNER_PUBLIC_KEY_PEM??''}),query);
  }catch{throw new Error('knowledge_release_refused');}
};
