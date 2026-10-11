if(typeof window!=='undefined')throw Error('telehealth-consent-copy-retained is server-only');
import {clinicalUuid,type ClinicalCoreDatabase} from './database';
import type {ClinicalCoreMigration} from './migrations';
import type {QualificationUpgradeConfiguration} from './qualification-schema-upgrade';
import {CareConsentCopyError} from './care-consent-copy-registration';
import {FullscriptUpgradeError} from './fullscript-schema-upgrade';
import {CareConnectionsUpgradeError} from './care-connections-schema-upgrade';
import {FULLSCRIPT_CONSENT_SUCCESSOR} from './fullscript-migration-release';
import {parseTelehealthConsentCopy} from './telehealth-consent-copy-registration';
import {assertTelehealthConsentUpgrade,verifyTelehealthConsentCopyRegistrationTarget} from './telehealth-consent-schema-upgrade';

export type RetainedTelehealthCopyObservation={
  contract:'telehealth-consent-copy-retained-observation/112';execution:'qualification';
  phiAllowed:false;activation:'blocked';migrationCount:112;migrationReleaseSha256:string;
  artifactId:string;organizationId:string;artifactVersion:string;contentSha256:string;
  scope:'telehealth_recording';copyPresent:boolean;approvalAuthorityCertified:false;
  databaseMutationPerformed:false;retryPerformed:false;deletionCertified:false;
};
/** Administrative recovery observation only, not patient-copy delivery or
 * registration authority. A separate native command must bind original
 * custody, exact copy/target, stopped writer and database fence. Revoked or
 * superseded approval cannot make retained immutable bytes "disappear".
 * No public API imports this function and no patient fallback is authorized. */
export async function inspectRetainedTelehealthConsentCopy(database:ClinicalCoreDatabase,
  supplied:ClinicalCoreMigration[],configuration:QualificationUpgradeConfiguration,
  value:unknown):Promise<RetainedTelehealthCopyObservation>{
  const m=supplied.map(r=>({...r})),c={...configuration};assertTelehealthConsentUpgrade(c,m);
  const copy=parseTelehealthConsentCopy(value);
  try{return await database.transaction(async tx=>{
    await tx.query('set transaction isolation level repeatable read read only');
    await tx.query("set local lock_timeout='5s'");await tx.query("set local statement_timeout='30s'");
    await tx.query('set local row_security=off');
    await verifyTelehealthConsentCopyRegistrationTarget(tx,m,c);
    const rows=(await tx.query<{organization_id:string;scope:string;artifact_version:string;artifact_hash:string;
      copy_artifact_id:string|null;copy_organization_id:string|null;copy_content:string|null;copy_hash:string|null}>(`
      select a.organization_id,a.scope,a.artifact_version,a.content_sha256 artifact_hash,
        t.artifact_id copy_artifact_id,t.organization_id copy_organization_id,
        t.content copy_content,t.content_sha256 copy_hash
      from clinical_core.consent_artifacts a
      left join clinical_core.care_consent_texts t on t.artifact_id=a.id
      where a.id=$1`,[clinicalUuid(copy.artifactId)])).rows;
    const row=rows[0];
    if(rows.length!==1||row.organization_id!==copy.organizationId||row.scope!==copy.scope
      ||row.artifact_version!==copy.artifactVersion||row.artifact_hash!==copy.contentSha256
      ||row.copy_artifact_id!==null&&(row.copy_artifact_id!==copy.artifactId
        ||row.copy_organization_id!==copy.organizationId||row.copy_content!==copy.content||row.copy_hash!==copy.contentSha256)
      ||row.copy_artifact_id===null&&(row.copy_organization_id!==null||row.copy_content!==null||row.copy_hash!==null))
      throw new CareConsentCopyError('copy_conflict');
    return {contract:'telehealth-consent-copy-retained-observation/112',execution:'qualification',phiAllowed:false,
      activation:'blocked',migrationCount:112,migrationReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,
      artifactId:copy.artifactId,organizationId:copy.organizationId,artifactVersion:copy.artifactVersion,
      contentSha256:copy.contentSha256,scope:'telehealth_recording',copyPresent:row.copy_artifact_id!==null,
      approvalAuthorityCertified:false,databaseMutationPerformed:false,retryPerformed:false,deletionCertified:false};
  });}catch(error){
    if(error instanceof CareConsentCopyError||error instanceof FullscriptUpgradeError||error instanceof CareConnectionsUpgradeError)throw error;
    throw new CareConsentCopyError('operation_failed');
  }
}
