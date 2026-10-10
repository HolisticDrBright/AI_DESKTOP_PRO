// Fictional command/file-custody observations only; never imported by runtime.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ClinicalCoreMigration } from '../migrations';
import type { QualificationUpgradeConfiguration } from '../qualification-schema-upgrade';
import { FULLSCRIPT_UPGRADE, fullscriptConsentConstraintSha256, type FullscriptUpgradeResult } from '../fullscript-schema-upgrade';
import type { FullscriptOperatorTarget } from '../fullscript-upgrade-command';
export const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?
  '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export const bytes=(v:unknown)=>Buffer.from(canonical(v)+'\n');
export const configuration:QualificationUpgradeConfiguration={expectedAccountId:'588966314750',region:'us-east-2',phiAllowed:false,activation:'blocked',
  qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',
  clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  fromReleaseSha256:FULLSCRIPT_UPGRADE.parent107,toReleaseSha256:FULLSCRIPT_UPGRADE.successor111};
export const build={sourceCommit:'a'.repeat(40),clean:true};
export const target:FullscriptOperatorTarget={contract:'fullscript-upgrade-target/1',execution:'qualification',account:'588966314750',region:'us-east-2',
  foundation:'ai-clinical-core-qualification-foundation',operatorRole:'OrganizationAccountAccessRole',clusterArn:configuration.clusterArn,secretArn:configuration.secretArn,
  qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',sourceCommit:build.sourceCommit,operatorSha256:sha('FICTIONAL operator'),
  phiAllowed:false,activation:'blocked',fromReleaseSha256:FULLSCRIPT_UPGRADE.parent107,toReleaseSha256:FULLSCRIPT_UPGRADE.successor111,
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-01-01T00:00:00.000Z',scope:'fictional-schema-transition-only'}};
export const caller={Account:'588966314750',Arn:'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/FICTIONAL_TEST'};
export const foundation={Stacks:[{StackId:'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/FICTIONAL',
  StackStatus:'CREATE_COMPLETE',Outputs:Object.entries({PhiAllowed:'false',Activation:'blocked',QualificationExecution:'disabled',
    DatabaseName:'clinical_core_qualification',DatabaseClusterArn:configuration.clusterArn,DatabaseSecretArn:configuration.secretArn})
    .map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]};
export function result(command:FullscriptUpgradeResult['command'],count:107|108|111=command==='upgrade'?111:107,
  from:string=FULLSCRIPT_UPGRADE.parent107):FullscriptUpgradeResult {
  return {contract:'fullscript-schema-upgrade/1',execution:'qualification',phiAllowed:false,activation:'blocked',observedMigrationCount:count,
    historicalTableCount:209,rowCount:3,dataSha256:'1'.repeat(64),historicalSchemaSha256:'2'.repeat(64),
    consentConstraintSha256:fullscriptConsentConstraintSha256(count),fromReleaseSha256:from,toReleaseSha256:FULLSCRIPT_UPGRADE.successor111,
    command,applied:command==='upgrade',rolledBack:command==='rehearse',dataPreserved:true,historicalSchemaPreserved:true,newTableCount:count===111?8:0,newRows:0};
}
export function migrations():ClinicalCoreMigration[] {
  const a=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000}));
  return a.manifest.migrations.map((r:{version:string;file:string})=>({version:r.version,name:r.file.slice(15,-4),sql:a.files[r.file],sha256:sha(a.files[r.file])}));
}
