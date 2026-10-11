import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';

type Operation = {
  legacyDefinitions: { providerDependencies: Record<string, boolean> }[];
  productionEvidence?: { activationState: string };
};

let output: string;
let inventory: { operations: Operation[]; counts: { total: number; productionEnabled: number } };

beforeAll(() => {
  inventory = JSON.parse(readFileSync('infra/aws-clinical-core/desktop-operation-port-inventory.json', 'utf8'));
  output = execFileSync(process.execPath, ['scripts/check-aws-desktop-operation-inventory.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
  });
}, 30_000);

it('reports historical provider flags as historical evidence, not an unfinished rewrite count', () => {
  const flagged = inventory.operations.filter(operation => operation.legacyDefinitions.some(
    definition => Object.values(definition.providerDependencies).some(Boolean),
  )).length;
  expect(output).toContain(`${flagged} have legacy provider dependency flags`);
  expect(output).not.toMatch(/\d+ require provider-specific rewrites/);
});

it('does not infer provider completion from source definitions or historical dependencies', () => {
  expect(output).toContain('current provider completion is unverified by this source gate');
});

it('preserves the activation-blocked inventory and zero enabled operations', () => {
  expect(inventory.counts.productionEnabled).toBe(0);
  expect(inventory.operations.every(operation => operation.productionEvidence?.activationState === 'phi_disabled')).toBe(true);
  expect(output).toContain(`${inventory.counts.total} implemented but activation-blocked, 0 enabled`);
});
