/** Emits SOURCE metadata only. Cannot apply, authorize, deploy or connect to AWS. */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileTelehealthSchemaSource } from './compile-telehealth-schema-source.mjs';
if(process.argv.length!==2)throw Error('telehealth_schema_source_argument_refused');
const output=fileURLToPath(new URL('../dist/aws-clinical-core/telehealth-schema-source/',import.meta.url));
const source=await compileTelehealthSchemaSource();
mkdirSync(output,{recursive:true});
if(readdirSync(output).some(name=>name!=='schema-source.json'))throw Error('telehealth_schema_source_output_refused');
writeFileSync(output+'schema-source.json',JSON.stringify(source,null,2)+'\n');
console.log(JSON.stringify({contract:source.contract,activation:source.activation,phiAllowed:source.phiAllowed,
  postgresVersion:source.postgresVersion,snapshots:source.snapshots.map(({projection,...s})=>({...s,items:projection.length})),
  warning:'SOURCE only; engine/owner binding, native custody and preserving upgrades are not authorized by this artifact.'},null,2));
