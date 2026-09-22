import {clinicalUuid,type ClinicalCoreDatabase} from './database';

/** Operator-side management of the retention service release row (migration
 * 20260920150000, `clinical_private.privacy_retention_service_releases`).
 *
 * The scheduled export retention sweep runs under an ordinary workforce identity.
 * The database accepts that identity as the retention service only while a live
 * release row names it: the row records which identity, which reviewed operating
 * policy (by evidence hash), who approved it and when. No row is seeded by any
 * migration; inserting one is the last activation step and is what this module
 * does, with the same boundary checks the sweep itself applies, so that a row can
 * never name an identity the sweep would then refuse. Revocation sets `revoked_at`
 * and the next sweep is refused (`retention_service_release_required`). The table
 * is closed to the API role, so this runs only through the administrative
 * database path used for reviewed migrations. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT=/^[A-Za-z0-9:_-]{8,128}$/,HASH=/^[a-f0-9]{64}$/,VERSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** The sweep runs under a named non-human service identity, never a person's credentials. The name says so on its face,
 * so an operator reading an audit row or an IAM trail can tell at a glance which it was. */
const SERVICE_SUBJECT=/^svc-[a-z0-9][a-z0-9-]{2,60}$/;
export type RetentionServiceReleaseInput={version:string;servicePersonId:string;serviceSubject:string;approvedByPersonId:string;evidenceSha256:string};
export type RetentionServiceRelease={version:string;servicePersonId:string;identitySubject:string;evidenceSha256:string;approvedBy:string;approvedAt:string;revokedAt:string|null;live:boolean};
export class RetentionServiceReleaseError extends Error{
  constructor(readonly code:'retention_release_invalid'|'retention_release_human_identity'|'retention_service_identity_required'|'retention_approver_required'
    |'retention_release_self_approval'|'retention_release_exists'|'retention_release_live'|'retention_release_not_live'){super(code);this.name='RetentionServiceReleaseError';}
}
const row=(r:Record<string,unknown>):RetentionServiceRelease=>({version:String(r.version),servicePersonId:String(r.service_person_id),identitySubject:String(r.identity_subject),
  evidenceSha256:String(r.evidence_sha256),approvedBy:String(r.approved_by),approvedAt:new Date(String(r.approved_at)).toISOString(),
  revokedAt:r.revoked_at==null?null:new Date(String(r.revoked_at)).toISOString(),live:r.revoked_at==null&&new Date(String(r.approved_at)).getTime()<=Date.now()});
const LIST=`select version,service_person_id::text service_person_id,identity_subject,evidence_sha256,approved_by::text approved_by,approved_at::text approved_at,revoked_at::text revoked_at
  from clinical_private.privacy_retention_service_releases order by approved_at,version`;
/** Read-only: every release row, live or revoked. Identities are opaque ids and subjects; no contact information exists here. */
export async function inspectRetentionServiceReleases(database:ClinicalCoreDatabase):Promise<{releases:RetentionServiceRelease[];live:number}>{
  return database.transaction(async tx=>{
    const releases=(await tx.query<Record<string,unknown>>(LIST)).rows.map(row);
    return {releases,live:releases.filter(r=>r.live).length};
  });
}
export function validateRetentionServiceReleaseInput(input:RetentionServiceReleaseInput):RetentionServiceReleaseInput{
  if(!VERSION.test(input.version??'')||!UUID.test(input.servicePersonId??'')||!SUBJECT.test(input.serviceSubject??'')||!UUID.test(input.approvedByPersonId??'')||!HASH.test(input.evidenceSha256??''))
    throw new RetentionServiceReleaseError('retention_release_invalid');
  if(input.servicePersonId.toLowerCase()===input.approvedByPersonId.toLowerCase())throw new RetentionServiceReleaseError('retention_release_self_approval');
  return {...input,servicePersonId:input.servicePersonId.toLowerCase(),approvedByPersonId:input.approvedByPersonId.toLowerCase()};
}
/** Inserts one live release after verifying, in the same transaction, exactly what `retention_sweep_actor()` will later require:
 * an active, production-bound workforce identity with that subject belonging to an active person; an active workforce approver
 * who is a different person; a version not yet used; and no other live release for the same identity. */
export async function releaseRetentionService(database:ClinicalCoreDatabase,rawInput:RetentionServiceReleaseInput):Promise<RetentionServiceRelease>{
  const input=validateRetentionServiceReleaseInput(rawInput);
  return database.transaction(async tx=>{
    await tx.query('lock table clinical_private.privacy_retention_service_releases in share row exclusive mode');
    const service=await tx.query<{ok:boolean}>(`select exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=$1 and i.identity_pool='workforce' and i.identity_subject=$2 and i.status='active' and i.production_bound=true and p.status='active') ok`,
      [clinicalUuid(input.servicePersonId),input.serviceSubject]);
    if(!service.rows[0]?.ok)throw new RetentionServiceReleaseError('retention_service_identity_required');
    // The identity exists and is a production-bound workforce identity. It must also be a named service identity: the
    // sweep runs under no person's credentials, and the name is what says so to anyone reading an audit row later.
    if(!SERVICE_SUBJECT.test(input.serviceSubject))throw new RetentionServiceReleaseError('retention_release_human_identity');
    const approver=await tx.query<{ok:boolean}>(`select exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=$1 and i.identity_pool='workforce' and i.status='active' and p.status='active') ok`,[clinicalUuid(input.approvedByPersonId)]);
    if(!approver.rows[0]?.ok)throw new RetentionServiceReleaseError('retention_approver_required');
    const existing=await tx.query<{version:string;live:boolean}>(`select version,(revoked_at is null) live from clinical_private.privacy_retention_service_releases
      where version=$1 or (revoked_at is null and (service_person_id=$2 or identity_subject=$3))`,[input.version,clinicalUuid(input.servicePersonId),input.serviceSubject]);
    if(existing.rows.some(r=>r.version===input.version))throw new RetentionServiceReleaseError('retention_release_exists');
    if(existing.rows.some(r=>r.live))throw new RetentionServiceReleaseError('retention_release_live');
    const inserted=await tx.query<Record<string,unknown>>(`insert into clinical_private.privacy_retention_service_releases(version,service_person_id,identity_subject,evidence_sha256,approved_by,approved_at)
      values($1,$2,$3,$4,$5,clock_timestamp())
      returning version,service_person_id::text service_person_id,identity_subject,evidence_sha256,approved_by::text approved_by,approved_at::text approved_at,revoked_at::text revoked_at`,
      [input.version,clinicalUuid(input.servicePersonId),input.serviceSubject,input.evidenceSha256,clinicalUuid(input.approvedByPersonId)]);
    return row(inserted.rows[0]);
  });
}
/** Revokes a live release; the next sweep is refused. Revoking again is refused rather than silently succeeding, so an operator
 * sees that nothing was live. Rows are never deleted: the release history is part of the retention evidence. */
export async function revokeRetentionServiceRelease(database:ClinicalCoreDatabase,version:string):Promise<RetentionServiceRelease>{
  if(!VERSION.test(version??''))throw new RetentionServiceReleaseError('retention_release_invalid');
  return database.transaction(async tx=>{
    const updated=await tx.query<Record<string,unknown>>(`update clinical_private.privacy_retention_service_releases set revoked_at=clock_timestamp() where version=$1 and revoked_at is null
      returning version,service_person_id::text service_person_id,identity_subject,evidence_sha256,approved_by::text approved_by,approved_at::text approved_at,revoked_at::text revoked_at`,[version]);
    if(!updated.rows[0])throw new RetentionServiceReleaseError('retention_release_not_live');
    return row(updated.rows[0]);
  });
}
