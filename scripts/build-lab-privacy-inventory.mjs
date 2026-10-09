import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const artifact='dist/lab-privacy-inventory.cjs';
const result=await build({entryPoints:['src/server/clinical-core/lab-privacy-inventory.ts'],outfile:artifact,
  bundle:true,platform:'node',target:'node22',format:'cjs',logLevel:'warning',metafile:true});
const files=[...Object.keys(result.metafile.inputs).filter(file=>!file.includes('node_modules/')),
  'scripts/build-lab-privacy-inventory.mjs','scripts/discover-lab-privacy-inventory.mjs','package-lock.json'];
writeFileSync('dist/lab-privacy-inventory.build.json',JSON.stringify({artifact:hash(artifact),
  sources:Object.fromEntries([...new Set(files)].sort().map(file=>[file,hash(file)]))},null,2)+'\n');
console.log('Built read-only operator inventory. No AWS request performed.');
