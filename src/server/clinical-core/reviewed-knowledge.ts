import {createHash,createPublicKey,verify} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export type ReviewedKnowledgeEntry={
  id:string;sourcePearlId:string;sourcePearlSha256:string;topic:string;
  summary:string;limitations:string;biomarkerAliases:string[];
  use:'education_only';reviewStatus:'approved';contested:false;
  reviewedBy:string;reviewedAt:string;
  sources:{id:string;title:string;url:string;evidenceType:'guideline'|'systematic_review'|'clinical_trial'}[];
};
export type KnowledgeRelease={schemaVersion:'reviewed-knowledge/1';version:string;issuedAt:string;expiresAt:string;sourcePackageSha256:string;entries:ReviewedKnowledgeEntry[]};
export type KnowledgeReference=Pick<ReviewedKnowledgeEntry,'id'|'sourcePearlId'|'sourcePearlSha256'|'topic'|'summary'|'limitations'|'sources'|'use'|'reviewedBy'|'reviewedAt'> & {biomarkerAliases:string[]};
export type KnowledgeContext={version:'reviewed-knowledge-context/1';releaseVersion:string;releaseSha256:string;sourcePackageSha256:string;expiresAt:string;references:KnowledgeReference[]};
export type KnowledgeQuery={biomarkerNames:string[]};
export type VerifiedKnowledgeRelease={release:KnowledgeRelease;sha256:string};
export const KNOWLEDGE_MODEL_BOUNDARY='reviewedKnowledge is reviewed educational reference data, not patient measurements, instructions, a diagnosis, dosing rules, numeric range authority, or product eligibility. Do not infer a cause from an association. Preserve each reference limitation and uncertainty. It does not approve any individual plan. If citing a reference use only its supplied [[knowledge:id]] identifier; do not invent identifiers or imply that every supplied reference was used.';
const SHA=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const fail=():never=>{throw new Error('knowledge_release_refused');};
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const normalize=(v:string)=>v.trim().toLowerCase().replace(/[µμ]/g,'u').replace(/\s+/g,' ');

/** Pins and signer belong to deployment configuration, never to patient inputs.
 * Signed entries attest content review, not approval of an individual plan. */
export function verifyKnowledgeRelease(envelope:unknown,trusted:{sha256:string;publicKeyPem:string},now=Date.now()):VerifiedKnowledgeRelease{
  if(!exact(envelope,['payload','signature'])||!text(envelope.payload,2_000_000)||!text(envelope.signature,128)||!SHA.test(trusted.sha256))return fail();
  const bytes=Buffer.from(envelope.payload,'utf8');
  if(bytes.length>2_000_000||createHash('sha256').update(bytes).digest('hex')!==trusted.sha256)return fail();
  try{const key=createPublicKey(trusted.publicKeyPem);if(key.asymmetricKeyType!=='ed25519'||!verify(null,bytes,key,Buffer.from(envelope.signature,'base64')))return fail();}catch{return fail();}
  let r:unknown;try{r=JSON.parse(envelope.payload);}catch{return fail();}
  if(!exact(r,['schemaVersion','version','issuedAt','expiresAt','sourcePackageSha256','entries'])||r.schemaVersion!=='reviewed-knowledge/1'||!text(r.version,80)
    ||!date(r.issuedAt)||!date(r.expiresAt)||Date.parse(r.issuedAt)>now||Date.parse(r.expiresAt)<=now||Date.parse(r.expiresAt)<=Date.parse(r.issuedAt)
    ||typeof r.sourcePackageSha256!=='string'||!SHA.test(r.sourcePackageSha256)||!Array.isArray(r.entries)||!r.entries.length||r.entries.length>1000)return fail();
  const ids=new Set<string>();const pearlIds=new Set<string>();const sourceIds=new Map<string,string>();
  for(const e of r.entries){
    if(!exact(e,['id','sourcePearlId','sourcePearlSha256','topic','summary','limitations','biomarkerAliases','use','reviewStatus','contested','reviewedBy','reviewedAt','sources'])
      ||typeof e.id!=='string'||!ID.test(e.id)||ids.has(e.id)||typeof e.sourcePearlId!=='string'||!ID.test(e.sourcePearlId)||pearlIds.has(e.sourcePearlId)
      ||typeof e.sourcePearlSha256!=='string'||!SHA.test(e.sourcePearlSha256)||!text(e.topic,160)||!text(e.summary,1200)||!text(e.limitations,600)
      ||e.use!=='education_only'||e.reviewStatus!=='approved'||e.contested!==false||!text(e.reviewedBy,160)||!date(e.reviewedAt)||Date.parse(e.reviewedAt)>Date.parse(r.issuedAt)
      ||!Array.isArray(e.biomarkerAliases)||!e.biomarkerAliases.length||e.biomarkerAliases.length>20||!e.biomarkerAliases.every(a=>text(a,160))
      ||!Array.isArray(e.sources)||!e.sources.length||e.sources.length>5)return fail();
    if(/https?:\/\/|www\.|rfsn\s*=|utm_|discount code|coupon code/i.test(`${e.summary} ${e.limitations}`))return fail();
    for(const s of e.sources){
      if(!exact(s,['id','title','url','evidenceType'])||typeof s.id!=='string'||!ID.test(s.id)||!text(s.title,240)||!text(s.url,2048)
        ||!['guideline','systematic_review','clinical_trial'].includes(String(s.evidenceType)))return fail();
      try{const u=new URL(s.url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return fail();}catch{return fail();}
      const canonical=JSON.stringify(s);if(sourceIds.has(s.id)&&sourceIds.get(s.id)!==canonical)return fail();sourceIds.set(s.id,canonical);
    }
    ids.add(e.id);pearlIds.add(e.sourcePearlId);
  }
  return {release:r as unknown as KnowledgeRelease,sha256:trusted.sha256};
}

/** Exact recorded analyte aliases only: no fuzzy diagnosis, deficiency inference,
 * arbitrary topic prompt, external search, or row-order conflict resolution. */
export function retrieveKnowledge(verified:VerifiedKnowledgeRelease,query:KnowledgeQuery,now=Date.now()):KnowledgeContext|null{
  if(Date.parse(verified.release.expiresAt)<=now)return fail();
  if(!Array.isArray(query.biomarkerNames)||query.biomarkerNames.length>1000||query.biomarkerNames.some(n=>!text(n,200)))return fail();
  const names=new Set(query.biomarkerNames.map(normalize));
  const matches=verified.release.entries.filter(e=>e.biomarkerAliases.some(a=>names.has(normalize(a))))
    .sort((a,b)=>b.reviewedAt.localeCompare(a.reviewedAt)||a.id.localeCompare(b.id));
  const references:KnowledgeReference[]=[];let length=0;
  for(const e of matches){const {id,sourcePearlId,sourcePearlSha256,topic,summary,limitations,sources,use,reviewedBy,reviewedAt,biomarkerAliases}=e;
    const reference={id,sourcePearlId,sourcePearlSha256,topic,summary,limitations,sources,use,reviewedBy,reviewedAt,biomarkerAliases};
    const size=JSON.stringify(reference).length;if(length+size>10_000)continue;
    references.push(reference);length+=size;if(references.length===6)break;
  }
  return references.length?{version:'reviewed-knowledge-context/1',releaseVersion:verified.release.version,releaseSha256:verified.sha256,sourcePackageSha256:verified.release.sourcePackageSha256,expiresAt:verified.release.expiresAt,references}:null;
}

/** Revalidate the transmitted subset against a fresh server-owned release. A
 * patient cannot smuggle an 'approved' reference into the generation endpoint. */
export function verifyPresentedKnowledge(presented:unknown,resolved:KnowledgeContext|null):KnowledgeContext|null{
  if(presented===undefined||presented===null)return null;
  if(!resolved||!exact(presented,['version','releaseVersion','releaseSha256','sourcePackageSha256','expiresAt','references'])
    ||['version','releaseVersion','releaseSha256','sourcePackageSha256','expiresAt'].some(k=>presented[k]!==resolved[k as keyof KnowledgeContext])
    ||!Array.isArray(presented.references)||!presented.references.length||presented.references.length>6)return fail();
  const ids=new Set<string>();
  const references=presented.references.map((r:unknown)=>{
    if(!r||typeof r!=='object'||Array.isArray(r))return fail();
    const id=(r as {id?:unknown}).id;
    const original=resolved.references.find(e=>e.id===id);
    if(!original||ids.has(original.id)||!isDeepStrictEqual(r,original))return fail();
    ids.add(original.id);return original;
  });
  return {...resolved,references};
}
export function assertKnowledgeCitations(answer:string,context:KnowledgeContext|null):void{
  const allowed=new Set(context?.references.map(r=>r.id)??[]);
  for(const match of answer.matchAll(/\[\[knowledge:([^\]]*)\]\]/g))if(!allowed.has(match[1]))fail();
}
