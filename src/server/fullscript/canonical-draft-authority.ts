if (typeof window !== 'undefined') throw new Error('Fullscript authority is server-only.');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ClinicalCoreTransaction} from '../clinical-core/database';
import {parseProtocolCartResponse} from '../../contracts/protocolCarts';
import {compileFullscriptProtocolDraft} from './protocol-draft';
import {DraftDeliveryRefused,type DraftDeliveryAuthority,type DraftDeliveryBinding} from './draft-delivery';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';

const uuid=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/).refine(v=>v!=='0'.repeat(64));
const providerId=z.string().regex(/^[A-Za-z0-9-]{8,128}$/);
const actor=z.object({organizationId:uuid,personId:uuid,identitySubject:z.string().min(1).max(200),
 identityPool:z.enum(['consumer','workforce']),environment:z.literal('synthetic-staging'),phiAllowed:z.literal(false)}).strict();
const selector=z.object({manifestId:uuid,patientRecordId:uuid}).strict();
const release=z.object({id:uuid,sha256:hash,content:z.unknown()}).strict();
const snapshot=z.object({organizationId:uuid,consumerPersonId:uuid,patientRecordId:uuid,connectionId:uuid,
 connectionVersion:z.number().int().positive(),practitionerPersonId:uuid,enrollmentId:uuid,enrollmentVersion:z.number().int().positive(),
 manifest:z.unknown(),catalogSourceSha256:hash,
 scopeGrants:z.array(z.object({scope:z.enum(['programs','protocols_supplements']),grantId:uuid,
  version:z.number().int().positive(),artifactId:uuid}).strict()).length(2),
 provider:release,recipient:release,practitioner:release,mapping:release,externalConsent:release,
 externalGrantId:uuid,externalGrantRevision:z.number().int().positive(),
}).strict();
const provider=z.object({contract:z.literal('fullscript-sandbox-provider-release/1'),environment:z.literal('sandbox_us'),
 apiOrigin:z.literal('https://api-us-snd.fullscript.io/api'),clinicId:providerId,tokenBindingSha256:hash,
 scopes:z.array(z.enum(FULLSCRIPT_DRAFT_SCOPES)).length(FULLSCRIPT_DRAFT_SCOPES.length)}).strict();
const recipient=z.object({contract:z.literal('fullscript-recipient-binding/1'),patientRecordId:uuid,
 consumerPersonId:uuid,connectionId:uuid,providerReleaseId:uuid,fullscriptPatientId:providerId}).strict();
const practitioner=z.object({contract:z.literal('fullscript-practitioner-binding/1'),practitionerPersonId:uuid,
 providerReleaseId:uuid,fullscriptPractitionerId:providerId}).strict();
const mapping=z.object({contract:z.literal('fullscript-variant-mapping-release/1'),manifestId:uuid,
 manifestContentSha256:hash,catalogSourceSha256:hash,providerReleaseId:uuid,
 lines:z.array(z.object({phaseId:z.string().min(1).max(200),itemId:z.string().min(1).max(200),
  productId:z.string().min(1).max(200),variantId:providerId,unitsToPurchase:z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/)}).strict()).min(1).max(200),
}).strict();
const consent=z.object({contract:z.literal('fullscript-external-consent/1'),providerReleaseId:uuid,
 content:z.string().min(1).max(16000).refine(v=>v.trim().length>0),contentSha256:hash,
 jurisdiction:z.string().min(1).max(200).refine(v=>v.trim().length>0)}).strict();
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const decoded=(v:unknown)=>typeof v==='string'?JSON.parse(v):v;
function bindingFromSource(raw:unknown):DraftDeliveryBinding {
 const s=snapshot.parse(decoded(raw));
 const p=provider.parse(s.provider.content),r=recipient.parse(s.recipient.content),w=practitioner.parse(s.practitioner.content);
 const m=mapping.parse(s.mapping.content),c=consent.parse(s.externalConsent.content);
 const manifest=parseProtocolCartResponse({action:'read',manifestId:m.manifestId},s.manifest);
 if(manifest.action!=='read'||manifest.status!=='compiled'||new Set(p.scopes).size!==FULLSCRIPT_DRAFT_SCOPES.length
  ||new Set(s.scopeGrants.map(g=>g.scope)).size!==2
  ||r.patientRecordId!==s.patientRecordId||r.consumerPersonId!==s.consumerPersonId||r.connectionId!==s.connectionId
  ||w.practitionerPersonId!==s.practitionerPersonId
  ||[r.providerReleaseId,w.providerReleaseId,m.providerReleaseId,c.providerReleaseId].some(id=>id!==s.provider.id)
  ||m.catalogSourceSha256!==s.catalogSourceSha256||m.manifestContentSha256!==manifest.contentSha256
  ||createHash('sha256').update(c.content,'utf8').digest('hex')!==c.contentSha256)throw new DraftDeliveryRefused();
 const compiled=compileFullscriptProtocolDraft(manifest,{manifestId:m.manifestId,manifestContentSha256:m.manifestContentSha256,
  catalogReleaseSha256:s.catalogSourceSha256,mappingReleaseSha256:s.mapping.sha256,
  fullscriptPatientId:r.fullscriptPatientId,practitionerId:w.fullscriptPractitionerId,lines:m.lines});
 return {organizationId:s.organizationId,consumerPersonId:s.consumerPersonId,patientRecordId:s.patientRecordId,
  connectionId:s.connectionId,practitionerPersonId:s.practitionerPersonId,manifestId:manifest.manifestId,
  authoritySha256:digest(s),intentSha256:compiled.intentSha256,input:compiled.input,excludedCount:compiled.excludedCount};
}

/** Source-only qualification adapter, not installed in an API. SQL obtains all
 * releases, consent, enrollment, identity, catalog and manifest from the SAME
 * transaction/target. No caller can supply release bodies or assert approval.
 * Production construction is refused. This declared configuration still needs
 * independent account/target/artifact/MFA observation in a future handler.
 * Expected SQL denials return NULL/false, then throw here without poisoning the
 * transaction: the delivery ledger can commit a withheld late receipt.
 * This does NOT verify OAuth credentials against tokenBindingSha256 or decode
 * real provider replies. Those remain the provider adapter's launch gates. */
export function createCanonicalDraftAuthority(rawConfiguration:unknown):DraftDeliveryAuthority {
 if(!z.object({execution:z.literal('qualification'),account:z.literal('588966314750'),phiAllowed:z.literal(false)})
  .strict().safeParse(rawConfiguration).success)throw new DraftDeliveryRefused();
 const source=async(tx:ClinicalCoreTransaction,sql:string,args:unknown[])=>{
  const raw=(await tx.query<{data:unknown}>(sql,args)).rows[0]?.data;
  return bindingFromSource(raw);
 };
 const guard=async<T>(work:()=>Promise<T>)=>{try{return await work();}catch{throw new DraftDeliveryRefused();}};
 return {
  resolve:(tx,rawActor,rawSelector)=>guard(async()=>{
   const a=actor.parse(rawActor),q=selector.parse(rawSelector);
   if(a.identityPool!=='workforce')throw new DraftDeliveryRefused();
   const b=await source(tx,'select fullscript_delivery.authority_source($1::jsonb,$2::uuid,$3::uuid) as data',
    [JSON.stringify(a),q.manifestId,q.patientRecordId]);
   if(b.organizationId!==a.organizationId||b.practitionerPersonId!==a.personId||b.manifestId!==q.manifestId
    ||b.patientRecordId!==q.patientRecordId)throw new DraftDeliveryRefused();
   return b;
  }),
  assertAccess:(tx,rawActor,b)=>guard(async()=>{
   const a=actor.parse(rawActor);
   const result=await tx.query<{allowed:boolean}>('select fullscript_delivery.actor_access($1::jsonb,$2::jsonb) as allowed',
    [JSON.stringify(a),JSON.stringify(b)]);
   if(result.rows[0]?.allowed!==true)throw new DraftDeliveryRefused();
  }),
  assertCurrent:(tx,b)=>guard(async()=>{
   const current=await source(tx,'select fullscript_delivery.current_authority_source($1::jsonb) as data',[JSON.stringify(b)]);
   if(canonical(current)!==canonical(b))throw new DraftDeliveryRefused();
  }),
 };
}
