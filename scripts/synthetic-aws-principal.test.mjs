import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSyntheticMemberIdentity, observeSyntheticMemberIdentity } from './synthetic-aws-principal.mjs';

test('synthetic AWS principal requires the pinned member role, never account root', () => {
  const valid = { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional-session' };
  assert.doesNotThrow(() => assertSyntheticMemberIdentity(valid));
  for (const identity of [
    { Account: valid.Account, Arn: `arn:aws:iam::${valid.Account}:root` },
    { Account: valid.Account, Arn: `arn:aws:iam::${valid.Account}:user/long-lived` },
    { Account: '173535830222', Arn: valid.Arn },
    { Account: valid.Account },
  ]) assert.throws(() => assertSyntheticMemberIdentity(identity), /synthetic_member_principal_refused/);
  let argumentsSeen;
  const observed = observeSyntheticMemberIdentity((file, args) => {
    argumentsSeen = { file, args };
    return JSON.stringify(valid);
  });
  assert.deepEqual(observed, valid);
  assert.deepEqual(argumentsSeen, { file: 'aws', args: ['sts', 'get-caller-identity', '--profile', 'ai-synthetic-member', '--region', 'us-east-2', '--output', 'json'] });
  assert.throws(() => observeSyntheticMemberIdentity(() => '{bad-json'), /synthetic_member_principal_refused/);
});

test('active fictional intake runners pin both CLI and SDK to the observed member role', () => {
  for (const file of ['verify-synthetic-program-routes-hosted.mjs', 'register-aws-qualification-consent.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /observeSyntheticMemberIdentity\(\)/);
    assert.match(source, /profile=SYNTHETIC_MEMBER_PROFILE|profile = SYNTHETIC_MEMBER_PROFILE/);
    assert.match(source, /fromIni\(\{\s*profile\s*\}\)/);
    assert.doesNotMatch(source, /ai-synthetic-staging/);
  }
});

test('synthetic route change preparers also refuse an ambient root identity', () => {
  for (const file of ['prepare-synthetic-program-api-change.mjs', 'prepare-synthetic-intake-api-change.mjs',
    'prepare-synthetic-lifecycle-api-change.mjs', 'prepare-synthetic-final-api-change.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /observeSyntheticMemberIdentity\(\)/);
    assert.match(source, /profile=SYNTHETIC_MEMBER_PROFILE/);
    assert.doesNotMatch(source, /ai-synthetic-staging/);
  }
});
