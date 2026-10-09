import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
let directory:string;
beforeAll(()=>{
  directory=mkdtempSync(join(tmpdir(),'covered-entity-operator-'));
  execFileSync(process.execPath,['scripts/build-aws-covered-entity-deletion-operator.mjs',`--out-dir=${directory}`],
    {encoding:'utf8',timeout:30000});
},35000);
afterAll(()=>{
  if(!directory)return;
  const target=resolve(directory);
  if(dirname(target)!==resolve(tmpdir()) || !basename(target).startsWith('covered-entity-operator-'))throw new Error('temporary_cleanup_boundary_refused');
  rmSync(target,{recursive:true,force:true});
});
describe('built covered-entity operator coverage binding (no AWS calls)',()=>{
  it('embeds the full mapping and its immutable pending dispositions',()=>{
    const bundle=readFileSync(join(directory,'index.cjs'),'utf8');
    expect(bundle).toContain('clinical_core.care_consent_texts');
    expect(bundle).toContain('clinical_private.recording_transcripts');
    expect(bundle).toContain('dispositionPending');
    expect(bundle).not.toContain('process.env.COVERAGE_PATH?.');
  });
  it('refuses replacement files and command-line overrides before requiring credentials',()=>{
    for(const [args,override] of [[['inspect'],'fictional-truncated.json'],[['destroy'],''],[['inspect','--coverage=other'],undefined]] as const){
      const env={...process.env};delete env.AWS_PROFILE;delete env.PHI_ALLOWED;delete env.COVERAGE_PATH;
      if(override!==undefined)env.COVERAGE_PATH=override;
      try{
        execFileSync(process.execPath,[join(directory,'index.cjs'),...args],{encoding:'utf8',env,timeout:10000,stdio:['ignore','pipe','pipe']});
        throw new Error('override unexpectedly accepted');
      }catch(error){expect(String((error as {stderr?:Buffer}).stderr)).toContain('covered_entity_coverage_override_refused');}
    }
  });
});
