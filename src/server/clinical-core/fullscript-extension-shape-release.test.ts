import { describe, expect, it } from 'vitest';
import { FULLSCRIPT_UPGRADE } from './fullscript-migration-release';
import { fullscriptExtensionShapeForVersion, FULLSCRIPT_EXTENSION_SHAPE_RELEASE } from './fullscript-extension-shape-release';
import { verifyFullscriptExtensionSchema } from './fullscript-schema-upgrade';
import type { ClinicalCoreTransaction } from './database';

describe('exact source-derived Fullscript engine/shape binding', () => {
  it('retains the historical embedded projection without replacing its pin', () => {
    expect(fullscriptExtensionShapeForVersion('18.3')).toBe(FULLSCRIPT_UPGRADE.extensionShape);
    expect(fullscriptExtensionShapeForVersion('17.7')).not.toBe(FULLSCRIPT_UPGRADE.extensionShape);
    expect(Object.keys(FULLSCRIPT_EXTENSION_SHAPE_RELEASE)).toEqual(['17.7', '18.3']);
  });
  it.each(['17.8', '18.2', '17.7 Aurora', '18', '', undefined, null, {}, 17.7])('refuses unknown engine %j without fallback', value => {
    expect(fullscriptExtensionShapeForVersion(value)).toBeUndefined();
  });
  it.each([[], [{ version: '17.7' }, { version: '18.3' }], [{ version: '19.0' }]].map(rows => ({ rows })))('refuses ambiguous or unqualified engine rows before shape/permissions', async ({ rows }) => {
    let queries = 0;
    const tx = { query: async () => { queries++; return { rows }; } } as unknown as ClinicalCoreTransaction;
    await expect(verifyFullscriptExtensionSchema(tx, [])).rejects.toMatchObject({ category: 'verification_failed', stage: 'extension_engine' });
    expect(queries).toBe(1);
  });
});
