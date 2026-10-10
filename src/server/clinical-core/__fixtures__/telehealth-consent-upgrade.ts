// Fictional command and custody observations only; never imported by runtime.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ClinicalCoreMigration } from '../migrations';
import type { TelehealthConsentUpgradeResult } from '../telehealth-consent-schema-upgrade';
import type { TelehealthConsentOperatorTarget } from '../telehealth-consent-upgrade-command';
import { FULLSCRIPT_UPGRADE, FULLSCRIPT_CONSENT_SUCCESSOR } from '../fullscript-migration-release';
import { configuration as oldConfiguration, caller, foundation, canonical, bytes, sha } from './fullscript-upgrade';
export { caller, foundation, canonical, bytes, sha };
export const configuration={...oldConfiguration,fromReleaseSha256:FULLSCRIPT_UPGRADE.successor111,toReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger};
export const build={sourceCommit:'a'.repeat(40),clean:true};
export const target:TelehealthConsentOperatorTarget={contract:'telehealth-consent-upgrade-target/1',execution:'qualification',account:'588966314750',region:'us-east-2',
  foundation:'ai-clinical-core-qualification-foundation',operatorRole:'OrganizationAccountAccessRole',clusterArn:configuration.clusterArn,secretArn:configuration.secretArn,
  qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',sourceCommit:build.sourceCommit,operatorSha256:sha('FICTIONAL operator'),
  phiAllowed:false,activation:'blocked',fromReleaseSha256:FULLSCRIPT_UPGRADE.successor111,toReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-01-01T00:00:00.000Z',scope:'fictional-schema-transition-only'}};
export function result(command:TelehealthConsentUpgradeResult['command'],count:111|112=command==='upgrade'?112:111):TelehealthConsentUpgradeResult {
  return {contract:'telehealth-consent-schema-upgrade/1',execution:'qualification',phiAllowed:false,activation:'blocked',observedMigrationCount:count,
    historicalTableCount:217,rowCount:8,dataSha256:'1'.repeat(64),historicalSchemaSha256:'2'.repeat(64),
    fromReleaseSha256:FULLSCRIPT_UPGRADE.successor111,toReleaseSha256:FULLSCRIPT_CONSENT_SUCCESSOR.ledger,
    command,applied:command==='upgrade',rolledBack:command==='rehearse',dataPreserved:true,historicalSchemaPreserved:true,
    newTableCount:0,newRows:0,newFunctionCount:count===112?1:0};
}
export function migrations():ClinicalCoreMigration[] {
  const a=JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
  return a.manifest.migrations.map((r:{version:string;file:string})=>({version:r.version,name:r.file.slice(15,-4),sql:a.files[r.file],sha256:createHash('sha256').update(a.files[r.file]).digest('hex')}));
}
