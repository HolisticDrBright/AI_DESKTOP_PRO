import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
if (process.argv.length !== 2) throw Error('inventory_target_build_argument_refused');
const out = 'dist/aws-clinical-core/inventory-qualification-target';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/inventory-qualification-target-cli.ts'], outfile: `${out}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none' });
console.log('Built configuration-only inventory target verifier; no AWS call, deployment, approval or PHI activation.');
