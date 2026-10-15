import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The campaign Lambdas as they would be deployed: each bundle reaches only the campaign code and the AWS clients it
 * needs. No clinical module, table, role, endpoint or the transactional configuration set is reachable from them.
 */
describe('the campaign Lambda bundles', () => {
  for (const name of ['api', 'sender', 'events']) {
    it(`${name} bundles nothing clinical`, async () => {
      const result = await build({ entryPoints: [`src/campaigns/lambda/${name}.ts`], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
        write: false, metafile: true, logLevel: 'silent', alias: { '@': './src' } });
      const inputs = Object.keys(result.metafile.inputs).map(path => path.replace(/\\/g, '/')).filter(path => !path.includes('node_modules/'));
      for (const input of inputs) expect(input, input).toMatch(/^src\/(?:campaigns\/|funnels\/schema\.ts$)/);
      const code = result.outputFiles[0]!.text;
      expect(code).not.toMatch(/clinical_core|clinical_private|CLINICAL_|alp-transactional|consult_request|patient_notice/);
      expect(Object.keys(result.metafile.inputs).some(path => /client-(?:rds-data|cognito|scheduler|pinpoint)/.test(path))).toBe(false);
    }, 60_000);
  }
});
