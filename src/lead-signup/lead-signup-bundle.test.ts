import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLeadCampaigns } from '../../scripts/build-lead-campaigns.mjs';

/**
 * The campaign service's deployable bundles hold its own code and nothing else: the build itself refuses
 * any input outside src/lead-signup/, the lead-campaigns contract and the funnel text rules, so no
 * clinical adapter, contract or credential can reach the marketing plane through an import.
 */
const out = mkdtempSync(join(tmpdir(), 'lead-campaigns-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the campaign service build', () => {
  it('bundles the sign-up service and the SES events function from the campaign code alone', async () => {
    const inputs = await buildLeadCampaigns(out) as Record<string, string[]>;
    for (const [name, files] of Object.entries(inputs)) {
      const sources = files.filter(f => !f.startsWith('node_modules/'));
      expect(sources.length, name).toBeGreaterThan(0);
      for (const file of sources) expect(file, `${name} bundles ${file}`).toMatch(/^src\/(lead-signup\/[a-z-]+\.ts|contracts\/leadCampaigns\.ts|funnels\/schema\.ts)$/);
      expect(files.some(f => /clinical|server\/|adapters\//.test(f)), name).toBe(false);
    }
    expect(inputs['ses-events']).not.toContain('src/lead-signup/server.ts');
    const server = readFileSync(join(out, 'lead-signup', 'server.mjs'), 'utf8');
    expect(server).not.toMatch(/clinical_core|CLINICAL_|consult_intake|identity-api/);
    // The clinical configuration set's name appears exactly once: in the check that refuses it.
    expect(server.match(/alp-transactional/g)).toHaveLength(1);
  }, 60_000);
});
