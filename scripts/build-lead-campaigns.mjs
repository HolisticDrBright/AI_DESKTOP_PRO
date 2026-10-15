/**
 * Build the campaign service's two artefacts. Never deploys, uploads or sends anything.
 *
 * - `dist/lead-campaigns/lead-signup/server.mjs`: the sign-up service, run by
 *   `infra/lead-campaigns/lead-signup.Dockerfile`.
 * - `dist/lead-campaigns/ses-events/index.js`: the SES events function (Lambda, nodejs22.x).
 *
 * Both are bundled from `src/lead-signup/` alone. The build refuses if anything outside that folder, the
 * lead-campaigns contract or the funnel text rules is pulled in, so a clinical module cannot reach the
 * marketing plane by an import. The metafile inputs are written next to each bundle for review.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv.find(arg => arg.startsWith('--out-dir='))?.slice(10) ?? 'dist/lead-campaigns';
const ALLOWED_SOURCE = /^(src\/lead-signup\/[a-z-]+\.ts|src\/contracts\/leadCampaigns\.ts|src\/funnels\/schema\.ts|node_modules\/.+)$/;
const ALLOWED_PACKAGE = /^node_modules\/(zod|@aws-sdk|@smithy|@aws-crypto|@aws|tslib|fast-xml-parser|strnum|uuid|bowser|mnemonist|obliterator)\//;

export async function buildLeadCampaigns(out = OUT) {
  const results = {};
  for (const [name, entry, format, outfile] of [
    ['lead-signup', 'src/lead-signup/main.ts', 'esm', 'server.mjs'],
    ['ses-events', 'src/lead-signup/ses-events-lambda.ts', 'cjs', 'index.js'],
  ]) {
    mkdirSync(`${out}/${name}`, { recursive: true });
    const result = await build({
      entryPoints: [entry], outfile: `${out}/${name}/${outfile}`, bundle: true, platform: 'node', target: 'node22', format,
      minify: false, legalComments: 'none', metafile: true, logLevel: 'silent',
      ...(format === 'esm' ? { banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } } : {}),
    });
    // A package path is named from its node_modules folder, however that folder is reached (a symlinked install resolves elsewhere).
    const inputs = [...new Set(Object.keys(result.metafile.inputs).map(input => input.replace(/^(?:[^]*\/)?node_modules\//, 'node_modules/')))].sort();
    const refused = inputs.filter(input => !ALLOWED_SOURCE.test(input) || (input.startsWith('node_modules/') && !ALLOWED_PACKAGE.test(input)));
    if (refused.length > 0) throw new Error(`lead_campaigns_build_refused: ${name} bundles ${refused.join(', ')}`);
    writeFileSync(`${out}/${name}/inputs.json`, JSON.stringify(inputs, null, 2) + '\n');
    results[name] = inputs;
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await buildLeadCampaigns();
  for (const [name, inputs] of Object.entries(results)) console.log(`${name}: ${inputs.filter(i => i.startsWith('src/')).length} source files, ${inputs.filter(i => i.startsWith('node_modules/')).length} package files`);
}
