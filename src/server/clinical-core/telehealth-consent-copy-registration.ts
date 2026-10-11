if(typeof window!=='undefined')throw Error('telehealth-consent-copy-registration is server-only');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {clinicalUuid,type ClinicalCoreDatabase,type ClinicalCoreTransaction} from './database';
import type {ClinicalCoreMigration} from './migrations';
import type {QualificationUpgradeConfiguration} from './qualification-schema-upgrade';
import {CareConsentCopyError} from './care-consent-copy-registration';
import {FullscriptUpgradeError} from './fullscript-schema-upgrade';
import {CareConnectionsUpgradeError} from './care-connections-schema-upgrade';
import {FULLSCRIPT_CONSENT_SUCCESSOR} from './fullscript-migration-release';
import {assertTelehealthConsentUpgrade,verifyTelehealthConsentCopyRegistrationTarget} from './telehealth-consent-schema-upgrade';

const schema=z.object({contract:z.literal('telehealth-consent-copy/112'),artifactId:z.string().uuid(),organizationId:z.string().uuid(),
  scope:z.literal('telehealth_recording'),artifactVersion:z.string().min(1).max(64),contentSha256:z.string().regex(/^[a-f0-9]{64}$/),
  content:z.string().min(1).max(16000)}).strict();
export type TelehealthConsentCopy=z.infer<typeof schema>;
const fail=(category:ConstructorParameters<typeof CareConsentCopyError>[0]):never=>{throw new CareConsentCopyError(category);};
export function parseTelehealthConsentCopy(value:unknown):TelehealthConsentCopy {
  const parsed=schema.safeParse(value);if(!parsed.success)return fail('copy_invalid');const copy=parsed.data;
  if(!copy.content.trim()||copy.content.includes('\0')||Buffer.byteLength(copy.content,'utf8')>16000
    ||Buffer.from(copy.content,'utf8').toString('utf8')!==copy.content
    ||createHash('sha256').update(copy.content,'utf8').digest('hex')!==copy.contentSha256)fail('copy_invalid');
  return {...copy,artifactId:copy.artifactId.toLowerCase(),organizationId:copy.organizationId.toLowerCase()};
}
export type TelehealthConsentCopyMode='inventory'|'inspect'|'rehearse'|'register';
export type TelehealthConsentCopyReceipt={contract:'telehealth-consent-copy-registration/112';command:TelehealthConsentCopyMode;
  execution:'qualification';phiAllowed:false;activation:'blocked';migrationCount:112;migrationReleaseSha256:string;
  scope:'telehealth_recording';approvalsCreated:false;grantsCreated:false;copyInserted:boolean;copyPresent:boolean|null;
  artifactId:string|null;contentSha256:string|null;rolledBack:boolean;inventory?:{approvedArtifacts:number;registeredCopies:number}};
class Rollback extends Error {
  constructor(readonly receipt:TelehealthConsentCopyReceipt,readonly priorPresent:boolean){super('telehealth_copy_rehearsal');}
}
async function approvedCopy(tx:ClinicalCoreTransaction,copy:TelehealthConsentCopy,lock:boolean) {
  if(lock)await tx.query("select pg_advisory_xact_lock(hashtextextended('care-consent-release:'||$1::text||':'||$2,1))",
    [clinicalUuid(copy.organizationId),copy.scope]);
  const approved=(await tx.query<{id:string}>(`select a.id from clinical_core.consent_artifacts a
    join clinical_core.organizations o on o.id=a.organization_id and o.status='active'
    join clinical_core.identities i on i.person_id=a.approved_by_person_id and i.identity_pool='workforce' and i.status='active' and i.production_bound
    join clinical_core.persons p on p.id=i.person_id and p.status='active'
    join clinical_core.organization_memberships m on m.organization_id=a.organization_id and m.person_id=i.person_id
      and m.status='active' and m.role in ('owner','admin','practitioner')
    where a.id=$1 and a.organization_id=$2 and a.scope='telehealth_recording' and a.artifact_version=$3
      and a.content_sha256=$4 and a.status='approved' and a.approved_at<=clock_timestamp()
      and a.id=(select id from clinical_core.consent_artifacts where organization_id=$2 and scope='telehealth_recording' and status='approved'
        order by approved_at desc,created_at desc,id desc limit 1)${lock?' for share of a,o,i,p,m':''}`,
    [clinicalUuid(copy.artifactId),clinicalUuid(copy.organizationId),copy.artifactVersion,copy.contentSha256])).rows;
  if(approved.length!==1||approved[0].id!==copy.artifactId)fail('approval_required');
  const rows=(await tx.query<{organization_id:string;content:string;content_sha256:string}>(
    'select organization_id,content,content_sha256 from clinical_core.care_consent_texts where artifact_id=$1',[clinicalUuid(copy.artifactId)])).rows;
  if(rows.length>1||rows.some(r=>r.organization_id!==copy.organizationId||r.content!==copy.content||r.content_sha256!==copy.contentSha256))fail('copy_conflict');
  return rows.length===1;
}
/** Transaction engine only. AWS use requires a separately reviewed target and
 * native custody wrapper. Never creates approval or grants, or retries an
 * uncertain commit. Historical 105/106 registration remains unchanged. */
export async function runTelehealthConsentCopyRegistration(database:ClinicalCoreDatabase,supplied:ClinicalCoreMigration[],
  configuration:QualificationUpgradeConfiguration,command:TelehealthConsentCopyMode,value?:unknown):Promise<TelehealthConsentCopyReceipt> {
  const m=supplied.map(r=>({...r})),c={...configuration};assertTelehealthConsentUpgrade(c,m);
  if(!['inventory','inspect','rehearse','register'].includes(command)||command==='inventory'&&value!==undefined)fail('copy_invalid');
  const copy=command==='inventory'?undefined:parseTelehealthConsentCopy(value),write=command==='rehearse'||command==='register';
  const base:TelehealthConsentCopyReceipt={contract:'telehealth-consent-copy-registration/112',command,execution:'qualification',phiAllowed:false,
    activation:'blocked',migrationCount:112,migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,scope:'telehealth_recording',
    approvalsCreated:false,grantsCreated:false,copyInserted:false,copyPresent:null,artifactId:copy?.artifactId??null,
    contentSha256:copy?.contentSha256??null,rolledBack:false};
  try{return await database.transaction(async tx=>{
    await tx.query(write?'set transaction isolation level read committed':'set transaction isolation level repeatable read read only');
    await tx.query("set local lock_timeout='5s'");await tx.query("set local statement_timeout='30s'");await tx.query('set local row_security=off');
    if(write){
      for(const key of ['ai-desktop-pro:production-clinical-core-migrations','ai-desktop-pro:qualification-fixtures'])
        if((await tx.query<{acquired:boolean}>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired',[key])).rows[0]?.acquired!==true)fail('target_refused');
      await tx.query('lock table clinical_core.care_consent_texts,clinical_core.schema_migrations in share row exclusive mode');
    }
    await verifyTelehealthConsentCopyRegistrationTarget(tx,m,c);
    if(!copy){
      const row=(await tx.query<{approved:number;copies:number}>(`select
        (select count(*)::int from clinical_core.consent_artifacts where scope='telehealth_recording' and status='approved') approved,
        (select count(*)::int from clinical_core.care_consent_texts t join clinical_core.consent_artifacts a on a.id=t.artifact_id
          where a.scope='telehealth_recording') copies`)).rows[0];
      if(!row||!Number.isSafeInteger(row.approved)||row.approved<0||!Number.isSafeInteger(row.copies)||row.copies<0)fail('verification_failed');
      return {...base,inventory:{approvedArtifacts:row.approved,registeredCopies:row.copies}};
    }
    const priorPresent=await approvedCopy(tx,copy,write);
    if(write&&!priorPresent){
      await tx.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)',
        [clinicalUuid(copy.artifactId),clinicalUuid(copy.organizationId),copy.content,copy.contentSha256]);
      if(!await approvedCopy(tx,copy,true))fail('verification_failed');
    }
    const receipt={...base,copyInserted:write&&!priorPresent,copyPresent:write||priorPresent};
    if(command==='rehearse')throw new Rollback(receipt,priorPresent);
    return receipt;
  });}catch(error){
    if(error instanceof Rollback){
      const inspected=await runTelehealthConsentCopyRegistration(database,m,c,'inspect',copy);
      if(inspected.copyPresent!==error.priorPresent)fail('verification_failed');
      return {...error.receipt,copyInserted:false,copyPresent:inspected.copyPresent,rolledBack:true};
    }
    if(error instanceof CareConsentCopyError||error instanceof FullscriptUpgradeError||error instanceof CareConnectionsUpgradeError)throw error;
    throw new CareConsentCopyError('operation_failed');
  }
}
