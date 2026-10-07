import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
let directory:string;
type Manifest={contract:string;status:string;deployable:boolean;sourceCommit:string;sourceDirty:boolean;
  predecessor:{migrationCount:number;ledgerReleaseSha256:string};overlay:{file:string;sha256:string;bytes:number;canonical:boolean;hostedVerified:boolean};
  libraries:{file:string;sha256:string}[];functions:{name:string;bodySha256:string;apiExecute:boolean}[];
  dependencyFunctions:{name:string;bodySha256:string;apiExecute:boolean}[];proposedRoutes:string[];
  proposedCoveredEntityMapping:{table:string;status:string}[];reviewRequired:string;
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
  it('pins 105 but never claims this overlay is canonical or deployed',()=>{
    expect(manifest).toMatchObject({contract:'care-claim-recovery-source-candidate/1',status:'unreleased',deployable:false,
      predecessor:{migrationCount:105,ledgerReleaseSha256:'7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743'},
      overlay:{canonical:false,hostedVerified:false},activation:'blocked',phiAllowed:false,seededApprovals:false,seededIdentities:false,seededConsents:false});
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);expect(typeof manifest.sourceDirty).toBe('boolean');
    expect(manifest).not.toHaveProperty('migrationReleaseSha256');
  });
  it('hashes real emitted bytes, dependencies and libraries',()=>{
    const sql=readFileSync(join(directory,manifest.overlay.file),'utf8');expect(sql).not.toContain('\r');
    expect(manifest.overlay.sha256).toBe(sha(sql));expect(manifest.overlay.bytes).toBe(Buffer.byteLength(sql));
    const functions=[...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([,name,body])=>({name,bodySha256:sha(body),apiExecute:name.startsWith('clinical_core.')}));
    expect(manifest.functions).toEqual(functions);expect(functions).toHaveLength(2);expect(manifest.dependencyFunctions).toHaveLength(7);
    expect(manifest.libraries.map(l=>l.file)).toEqual(['api-library.cjs','service-library.cjs','database-binding-library.cjs']);
    for(const l of manifest.libraries)expect(l.sha256).toBe(sha(readFileSync(join(directory,l.file))));
  });
  it('names the pending route, dispositions and real integration obligations',()=>{
    expect(manifest.proposedRoutes).toEqual(['POST /clinical-core/consumer/connection-claims']);
    expect(manifest.proposedCoveredEntityMapping).toEqual(expect.arrayContaining([
      expect.objectContaining({table:'clinical_core.care_claim_requests',status:'inventory_and_disposition_pending'}),
      expect.objectContaining({table:'clinical_audit.care_claim_events',status:'inventory_and_disposition_pending'}),
    ]));
    expect(manifest.reviewRequired).toContain('separate claim recovery');
    expect(manifest.remaining.join(' ')).toContain('id-less legacy uncertainty');
    expect(manifest.remaining.join(' ')).toContain('real multi-session race');
  });
});
