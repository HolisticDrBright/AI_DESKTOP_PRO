import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {parseCoveredEntityCoverage,planCoveredEntityDeletion,type CoveredEntityCoverageEntry} from './covered-entity-deletion';
let directory:string;
type Manifest={contract:string;status:string;deployable:boolean;sourceCommit:string;sourceDirty:boolean;
  predecessor:{migrationCount:number;ledgerReleaseSha256:string};overlay:{file:string;sha256:string;bytes:number;canonical:boolean;hostedVerified:boolean};
  libraries:{file:string;sha256:string}[];functions:{name:string;bodySha256:string;apiExecute:boolean}[];
  dependencyFunctions:{name:string;bodySha256:string;apiExecute:boolean}[];proposedRoutes:string[];
  deploymentIntegration:{status:string;builder:string;inspector:string;targetContract:string;claimRecoveryDefault:boolean;
    independentReviewRequired:boolean;additionalReservedConcurrency:number;deploymentPerformed:boolean;hostedAcceptance:boolean};
  preparedTransition:{status:string;canonical:boolean;qualificationOnly:boolean;operatorReleased:boolean;fromLedgerSha256:string;
    toLedgerSha256:string;migrationCount:number;tableCountBefore:number;tableCountAfter:number;mandatoryRollbackRehearsal:boolean;
    manifest:{file:string;sha256:string};operator:{file:string;sha256:string;scope:string;embeddedMigrations:boolean;
      observedTarget:boolean;postRehearsalTargetRecheck:boolean;migrationPerformed:boolean}};
  proposedCoveredEntityMapping:(CoveredEntityCoverageEntry & {status:string})[];reviewRequired:string;
  activation:string;phiAllowed:boolean;seededApprovals:boolean;seededIdentities:boolean;seededConsents:boolean;remaining:string[]};
let manifest:Manifest;
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
beforeAll(()=>{
  directory=mkdtempSync(join(tmpdir(),'care-claim-recovery-source-'));
  execFileSync(process.execPath,['scripts/build-care-claim-recovery-source-candidate.mjs',`--out-dir=${directory}`],{encoding:'utf8',timeout:30000});
  manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
},35000);
afterAll(()=>{
  if(!directory)return;const target=resolve(directory);
  if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('care-claim-recovery-source-'))throw new Error('temporary_cleanup_boundary_refused');
  rmSync(target,{recursive:true,force:true});
});
describe('unreleased claim recovery mapping',()=>{
  it('pins the original 105 predecessor and registered 106 without claiming deployment',()=>{
    expect(manifest).toMatchObject({contract:'care-claim-recovery-source-candidate/1',status:'unreleased',deployable:false,
      predecessor:{migrationCount:105,ledgerReleaseSha256:'7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743'},
      overlay:{canonical:true,hostedVerified:false},activation:'blocked',phiAllowed:false,seededApprovals:false,seededIdentities:false,seededConsents:false});
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);expect(typeof manifest.sourceDirty).toBe('boolean');
    expect(manifest).not.toHaveProperty('migrationReleaseSha256');
  });
  it('hashes real emitted bytes, dependencies and libraries',()=>{
    const sql=readFileSync(join(directory,manifest.overlay.file),'utf8');expect(sql).not.toContain('\r');
    expect(manifest.overlay.sha256).toBe(sha(sql));expect(manifest.overlay.bytes).toBe(Buffer.byteLength(sql));
    const functions=[...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([,name,body])=>({name,bodySha256:sha(body),apiExecute:name.startsWith('clinical_core.')}));
    expect(manifest.functions).toEqual(functions);expect(functions).toHaveLength(2);expect(manifest.dependencyFunctions).toHaveLength(7);
    expect(manifest.libraries.map(l=>l.file)).toEqual(['api-library.cjs','service-library.cjs','database-binding-library.cjs','schema-upgrade-library.cjs']);
    for(const l of manifest.libraries)expect(l.sha256).toBe(sha(readFileSync(join(directory,l.file))));
  });
  it('emits an exact registered transition with the original 105 prefix and no deployment authority',()=>{
    expect(manifest.preparedTransition).toMatchObject({status:'canonical_registered',canonical:true,qualificationOnly:true,operatorReleased:true,
      fromLedgerSha256:manifest.predecessor.ledgerReleaseSha256,migrationCount:106,tableCountBefore:207,tableCountAfter:209,
      mandatoryRollbackRehearsal:true});
    const bytes=readFileSync(join(directory,manifest.preparedTransition.manifest.file),'utf8');
    expect(manifest.preparedTransition.manifest.sha256).toBe(sha(bytes));
    const prepared=JSON.parse(bytes) as {contract_version:string;migrations:{version:string;file:string}[]};
    expect(prepared.contract_version).toBe('clinical-core-migrations/1');expect(prepared.migrations).toHaveLength(106);
    const baseline=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
      {encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024}));
    expect(prepared.migrations.slice(0,105)).toEqual(baseline.manifest.migrations.slice(0,105));
    for(const m of prepared.migrations.slice(0,105))
      expect(readFileSync(join(directory,'prepared-migrations',m.file),'utf8')).toBe(baseline.files[m.file]);
    expect(prepared.migrations[105]).toEqual({version:'20261006030000',file:'20261006030000_production_care_claim_recovery.sql'});
    expect(readFileSync(join(directory,'prepared-migrations',prepared.migrations[105].file),'utf8'))
      .toBe(readFileSync(join(directory,manifest.overlay.file),'utf8'));
    expect(sha(prepared.migrations.map(m=>`${m.version}:${sha(readFileSync(join(directory,'prepared-migrations',m.file)))}`).join('\n')))
      .toBe(manifest.preparedTransition.toLedgerSha256);
    expect(manifest.deployable).toBe(false);expect(manifest.activation).toBe('blocked');
  });
  it('emits a hashed self-contained prepared operator that refuses invalid commands without AWS calls',()=>{
    const operator=manifest.preparedTransition.operator;
    expect(operator).toMatchObject({scope:'prepared_qualification_only',embeddedMigrations:true,observedTarget:true,
      postRehearsalTargetRecheck:true,migrationPerformed:false});
    const file=join(directory,operator.file);expect(operator.sha256).toBe(sha(readFileSync(file)));
    expect(()=>execFileSync(process.execPath,[file,'upgrade','--skip-rehearsal'],{encoding:'utf8',timeout:10000}))
      .toThrow();
    try{execFileSync(process.execPath,[file,'inspect','--database=clinical_core'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
      throw new Error('operator unexpectedly accepted an override');}
    catch(error){expect(String((error as {stderr?:Buffer}).stderr)).toContain('boundary_refused');}
  });
  it('maps the integrated but unactivated route without treating source integration as deployment',()=>{
    expect(manifest.proposedRoutes).toEqual(['POST /clinical-core/consumer/connection-claims']);
    expect(manifest.deploymentIntegration).toEqual({status:'source_implemented_hosted_unverified',
      builder:'scripts/build-aws-care-connections.mjs',inspector:'scripts/inspect-care-connections-qualification.mjs',
      targetContract:'aws-clinical-core-qualification-target/3',claimRecoveryDefault:false,independentReviewRequired:true,
      additionalReservedConcurrency:0,deploymentPerformed:false,hostedAcceptance:false});
    const builder=readFileSync(manifest.deploymentIntegration.builder,'utf8');
    expect(builder).toContain("['ConsumerClaimRecovery', 'Consumer', 'consumer/connection-claims']");
    expect(builder).toContain("ClaimRecoveryEnabled: { Type: 'String', Default: 'false'");
    expect(builder).toContain('ClaimRecoveryReviewSha256');
    expect(readFileSync(manifest.deploymentIntegration.inspector,'utf8')).toContain("runCareInspection('care-connections')");
    const example=JSON.parse(readFileSync('infra/aws-clinical-core/qualification-target-connections.example.json','utf8'));
    expect(example.schemaVersion).toBe(manifest.deploymentIntegration.targetContract);
    expect(example.stacks['care-connections']).toBe('ai-clinical-core-qualification-care-connections');
    expect(manifest.proposedCoveredEntityMapping).toEqual(expect.arrayContaining([
      expect.objectContaining({table:'clinical_core.care_claim_requests',status:'inventory_integrated_disposition_blocked'}),
      expect.objectContaining({table:'clinical_audit.care_claim_events',status:'inventory_integrated_disposition_blocked'}),
    ]));
    expect(manifest.reviewRequired).toContain('separate claim recovery');
    expect(manifest.remaining.join(' ')).toContain('id-less legacy uncertainty');
    expect(manifest.remaining.join(' ')).toContain('real multi-session race');
  });
  it('parses the registered 209-table mapping without treating retained parents or inventory as deletion authority',()=>{
    const coverage=JSON.parse(readFileSync('infra/aws-clinical-core/covered-entity-coverage.json','utf8'));
    const proposed=parseCoveredEntityCoverage(coverage);
    expect(proposed.tables).toHaveLength(209);
    expect(proposed.tables.find(row=>row.table==='clinical_core.care_claim_requests'))
      .toMatchObject({dependsOn:['clinical_core.patient_connections'],appendOnly:true});
    expect(proposed.tables.find(row=>row.table==='clinical_audit.care_claim_events'))
      .toMatchObject({appendOnly:true,disposition:expect.stringContaining('separately reviewed')});
    expect(()=>planCoveredEntityDeletion(proposed)).toThrow('disposition_review_required');
  });
});
