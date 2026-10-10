import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInventoryIdentityConfigurationCommand } from './inventory-qualification-identity-configuration-command';
it('rejects write options, malformed or oversized bindings before AWS reads', async () => {
  let calls = 0;
  const read = async () => { calls += 1; throw Error('must_not_read'); };
  for (const args of [[], ['--activate'], ['--observe-configuration'], ['--observe-configuration', '--approve'],
    ['--observe-configuration', 'identity.json', '--phi']])
    await expect(runInventoryIdentityConfigurationCommand(args, read)).rejects.toThrow('identity_configuration_argument_refused');
  const directory = mkdtempSync(join(tmpdir(), 'alp-identity-command-'));
  try {
    const file = join(directory, 'identity.json');
    for (const value of ['invalid json', '{}', 'null', JSON.stringify({ approved: true }), ' '.repeat(16385)]) {
      writeFileSync(file, value);
      await expect(runInventoryIdentityConfigurationCommand(['--observe-configuration', file], read)).rejects.toThrow();
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  expect(calls).toBe(0);
});
