/** Source-only forward proposal. No AWS, existing-target SQL or activation. */
import { execFileSync } from 'node:child_process';
import { readFileSync,mkdirSync,writeFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telehealthTransferKeyFenceCandidate } from './telehealth-transfer-key-fence-candidate.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const json=process.argv.length===3&&process.argv[2]==='--json';
if(process.argv.length>2&&!json)throw Error('telehealth_key_fence_argument_refused');
const parent=JSON.parse(execFileSync(process.execPath,['scripts/build-zoom-host-authority-candidate.mjs','--json'],
  {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60_000,windowsHide:true}));
const source=readFileSync(resolve(root,'infra/aws-clinical-core/source-candidates/telehealth-transfer-key-fence.sql'),'utf8');
const result=telehealthTransferKeyFenceCandidate(parent,source);
if(json)process.stdout.write(JSON.stringify(result));
else{
  const out=resolve(root,'dist/aws-clinical-core/telehealth-transfer-key-fence-candidate');mkdirSync(out,{recursive:true});
  const allowed=new Set([...Object.keys(result.files),'manifest.json','candidate.json']);
  if(readdirSync(out).some(name=>!allowed.has(name)))throw Error('telehealth_key_fence_output_refused');
  for(const [name,bytes]of Object.entries(result.files))writeFileSync(resolve(out,name),bytes);
  for(const [name,value]of [['manifest.json',result.manifest],['candidate.json',result.candidate]])
    writeFileSync(resolve(out,name),JSON.stringify(value,null,2)+'\n');
  process.stdout.write('Built distinct blocked 115 source proposal; all 114 parent bytes preserved. No apply, deployment or activation.\n');
}
