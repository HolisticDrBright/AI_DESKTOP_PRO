import { build } from 'esbuild';
await build({ entryPoints: ['src/server/clinical-core/lab-range-prepare-cli.ts'],
  outfile: 'dist/lab-range-tools/prepare.cjs', bundle: true, platform: 'node',
  target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' });
console.log('Offline unsigned range preparation tool built.');
