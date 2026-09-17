import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('application-only stylesheet sources', () => {
  it('compiles app utilities without adopting classes from generated artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alp-style-boundary-')); temporary.push(root);
    const stylesheet = join(root, 'src/app/globals.css');
    mkdirSync(dirname(stylesheet), { recursive: true });
    mkdirSync(join(root, 'src/components'), { recursive: true });
    mkdirSync(join(root, 'graphify-out'), { recursive: true });
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    const source = readFileSync(resolve('src/app/globals.css'), 'utf8');
    expect(source).toContain('@import "tailwindcss" source("../");');
    // Resolve the installed engine without depending on a node_modules link in
    // the isolated fixture. Preserve the actual source directive and theme.
    const require = createRequire(resolve('package.json'));
    const engine = require.resolve('tailwindcss/index.css').replaceAll('\\', '/');
    const css = source.replace('"tailwindcss"', JSON.stringify(engine));
    writeFileSync(stylesheet, css);
    writeFileSync(join(root, 'src/components/Example.tsx'), '<div className="p-[137px] bg-action disabled:opacity-50"/>');
    writeFileSync(join(root, 'graphify-out/graph.html'), '<div class="p-[139px]"/>');
    writeFileSync(join(root, 'artifacts/trace.html'), '<div class="p-[149px]"/>');
    const result = await postcss([tailwind({ base: root, optimize: false })]).process(css, { from: stylesheet });
    expect(result.css).toContain('padding: 137px');
    expect(result.css).toContain('.bg-action');
    expect(result.css).toContain('disabled');
    expect(result.css).not.toContain('padding: 139px');
    expect(result.css).not.toContain('padding: 149px');
  });
});
