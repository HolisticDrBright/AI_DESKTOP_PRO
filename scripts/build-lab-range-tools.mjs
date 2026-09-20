import { build } from 'esbuild';
await build({ entryPoints: ['src/server/clinical-core/lab-range-prepare-cli.ts'],
  outfile: 'dist/lab-range-tools/prepare.cjs', bundle: true, platform: 'node',
  target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' });
await build({ entryPoints: ['src/server/clinical-core/lab-range-activation-readiness-cli.ts'],
  outfile: 'dist/lab-range-tools/activation-readiness.cjs', bundle: true, platform: 'node',
  target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' });
await build({ entryPoints: ['src/server/clinical-core/clinical-safety-regression-cli.ts'],
  outfile: 'dist/lab-range-tools/safety-regression.cjs', bundle: true, platform: 'node',
  target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' });
console.log('Offline unsigned range preparation, activation-readiness and safety-regression tools built.');
