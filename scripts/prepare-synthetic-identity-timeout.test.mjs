import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { timeoutOnlyTemplate } from './prepare-synthetic-identity-timeout.mjs';

const source = JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json', import.meta.url), 'utf8'));

test('timeout candidate changes only Lambda and HTTP integration limits', () => {
  const live = structuredClone(source);
  live.Resources.IdentityApiFunction.Properties.Timeout = 15;
  live.Resources.IdentityApiIntegration.Properties.TimeoutInMillis = 15000;
  const before = JSON.stringify(live);
  const candidate = timeoutOnlyTemplate(live, source);
  assert.equal(JSON.stringify(live), before);
  assert.equal(candidate.Resources.IdentityApiFunction.Properties.Timeout, 29);
  assert.equal(candidate.Resources.IdentityApiIntegration.Properties.TimeoutInMillis, 30000);
  candidate.Resources.IdentityApiFunction.Properties.Timeout = 15;
  candidate.Resources.IdentityApiIntegration.Properties.TimeoutInMillis = 15000;
  assert.equal(JSON.stringify(candidate), before);
});

test('drift or a second timeout update refuses instead of broadening a live change', () => {
  const live = structuredClone(source);
  live.Resources.IdentityApiFunction.Properties.Timeout = 15;
  live.Resources.IdentityApiIntegration.Properties.TimeoutInMillis = 15000;
  for (const change of [
    value => { value.Resources.IdentityApiFunction.Properties.Timeout = 20; },
    value => { value.Resources.IdentityApiIntegration.Properties.TimeoutInMillis = 20000; },
    value => { value.Resources.IdentityApiIntegration.Properties.IntegrationUri = 'wrong'; },
  ]) {
    const changed = structuredClone(live); change(changed);
    assert.throws(() => timeoutOnlyTemplate(changed, source), /synthetic_timeout_refused:template_or_source_drift/);
  }
  const changedSource = structuredClone(source);
  changedSource.Resources.IdentityApiFunction.Properties.Timeout = 15;
  assert.throws(() => timeoutOnlyTemplate(live, changedSource), /synthetic_timeout_refused:template_or_source_drift/);
});
