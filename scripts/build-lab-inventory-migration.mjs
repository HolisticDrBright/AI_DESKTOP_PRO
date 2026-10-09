import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const artifact='dist/lab-inventory-migration.cjs';
const result=await build({entryPoints:['src/server/clinical-core/lab-inventory-migration.ts'],
  outfile:artifact,bundle:true,platform:'node',target:'node22',format:'cjs',logLevel:'warning',metafile:true});
const files=[...Object.keys(result.metafile.inputs).filter(file=>!file.includes('node_modules/')),
  'scripts/build-lab-inventory-migration.mjs','scripts/migrate-lab-inventory.mjs','package-lock.json'];
writeFileSync('dist/lab-inventory-migration.build.json',JSON.stringify({artifact:hash(artifact),
  sources:Object.fromEntries([...new Set(files)].sort().map(file=>[file,hash(file)]))},null,2)+'\n',{encoding:'utf8'});
console.log('Built administrative lab inventory migration. No AWS operation performed.');
