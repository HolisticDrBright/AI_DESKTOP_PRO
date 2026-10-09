import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ESLint, Linter } from 'eslint';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const plugin = require('@next/eslint-plugin-next');
const pluginRequire = createRequire(require.resolve('@next/eslint-plugin-next'));
const { globSync } = pluginRequire('fast-glob');
const { getRootDirs } = pluginRequire('./utils/get-root-dirs');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'alp-lint-roots-'));
const forward = value => value.replace(/\\/g, '/');
const sorted = values => values.map(forward).sort();
const find = pattern => sorted(globSync(forward(pattern), { onlyDirectories: true }));
for (const dir of ['one/app', 'two/pages', 'deep/nested/app', '.hidden/app', 'with space/app']) {
  fs.mkdirSync(path.join(fixture, dir), { recursive: true });
}
fs.writeFileSync(path.join(fixture, 'one/app/page.tsx'), 'export default function Page(){ return null; }');
fs.writeFileSync(path.join(fixture, 'two/pages/index.tsx'), 'export default function Page(){ return null; }');
fs.writeFileSync(path.join(fixture, 'plain-file'), 'fictional fixture');
after(() => {
  assert.equal(path.dirname(fixture), os.tmpdir());
  assert.ok(path.basename(fixture).startsWith('alp-lint-roots-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('the actual pinned Next plugin resolves the internal adapter, not the vulnerable parser', () => {
  const adapter = pluginRequire('fast-glob/package.json');
  assert.equal(adapter.name, '@alp/next-root-glob');
  assert.equal(adapter.version, '1.0.0');
  assert.equal(adapter.dependencies.tinyglobby, '0.2.17');
  assert.equal(require('@next/eslint-plugin-next/package.json').version, '15.5.25');
  assert.equal(require('eslint-config-next/package.json').version, '15.5.25');
  assert.equal(require('next/package.json').version, '15.5.25');
  assert.deepEqual(Object.keys(pluginRequire('fast-glob')), ['globSync']);
});

test('upstream has exactly the reviewed directory-only glob consumer', () => {
  const pluginDist = path.dirname(require.resolve('@next/eslint-plugin-next'));
  const consumers = [];
  const scan = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.name.endsWith('.js') && fs.readFileSync(file, 'utf8').includes('require("fast-glob")')) {
        consumers.push(forward(path.relative(pluginDist, file)));
      }
    }
  };
  scan(pluginDist);
  assert.deepEqual(consumers, ['utils/get-root-dirs.js']);
  const source = fs.readFileSync(path.join(pluginDist, consumers[0]), 'utf8');
  assert.equal((source.match(/_fastglob\.globSync/g) || []).length, 1);
  assert.match(source, /onlyDirectories: true/);
  assert.match(source, /rootDir\.replace/);
  assert.equal(createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex'), '886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde');
  assert.equal(json('package-lock.json').packages['node_modules/@next/eslint-plugin-next'].integrity,
    'sha512-dAzOqZQCAOgIq5yQpsuMBZcwxK0AtzGqHMQpxNWYLQlvf79rsP3SDwdGPNQC4ySaMSihOQXMO/VXubQ3JWW+3A==');
});

test('locked graph has no braces, micromatch or unrelated local override', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  assert.equal(pkg.devDependencies['fast-glob'], 'file:vendor/next-root-glob');
  assert.deepEqual(pkg.overrides['@next/eslint-plugin-next@15.5.25'], { 'fast-glob': '$fast-glob' });
  assert.equal(lock.packages['node_modules/fast-glob'].resolved, 'vendor/next-root-glob');
  assert.equal(lock.packages['vendor/next-root-glob'].name, '@alp/next-root-glob');
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert.ok(!/(?:^|\/)node_modules\/(?:braces|micromatch)$/.test(name), name);
    assert.ok(!name.includes('@next/eslint-plugin-next/vendor/'), `broken nested file override: ${name}`);
    if (/(?:^|\/)node_modules\/fast-glob$/.test(name)) {
      assert.equal(entry.resolved, 'vendor/next-root-glob');
      assert.equal(entry.link, true);
    }
  }
});

test('full audit remains mandatory and the Docker dependency stage includes the adapter', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: npm audit --audit-level=high/);
  assert.doesNotMatch(ci, /npm audit[^\n]*(?:omit|production|\|\|)/);
  assert.match(ci, /run: npm run test:lint-root-matcher/);
  for (const file of ['Dockerfile', 'Dockerfile.production']) {
    const dependencyStage = fs.readFileSync(path.join(root, file), 'utf8').split('AS builder')[0];
    assert.ok(dependencyStage.indexOf('COPY vendor/next-root-glob ./vendor/next-root-glob') > 0, file);
    assert.ok(dependencyStage.indexOf('COPY vendor/next-root-glob') < dependencyStage.indexOf('RUN npm ci'), file);
  }
});

test('literal directory does not expand into its descendants', () => {
  assert.deepEqual(find(path.join(fixture, 'one')), [forward(path.join(fixture, 'one'))]);
});
test('static relative directory preserves its exact configured spelling', () => {
  assert.deepEqual(find('src'), ['src']);
  assert.deepEqual(find('./src/'), ['./src/']);
  assert.deepEqual(find('./src'), ['./src']);
  assert.deepEqual(find('src/'), ['src/']);
});
test('absolute directory paths including spaces stay absolute', () => {
  assert.deepEqual(find(path.join(fixture, 'with space')), [forward(path.join(fixture, 'with space'))]);
});
test('filesystem roots retain their absolute root separator', () => {
  const filesystemRoot = forward(path.parse(fixture).root);
  assert.deepEqual(find(filesystemRoot), [filesystemRoot]);
});
test('wildcards match directories, not files or hidden directories', () => {
  assert.deepEqual(find(`${forward(fixture)}/*`), sorted(['deep', 'one', 'two', 'with space'].map(dir => path.join(fixture, dir))));
});
test('relative glob matches retain an explicit dot prefix', () => {
  assert.deepEqual(find('./src/{app,lib}'), ['./src/app', './src/lib']);
});
test('recursive directory matching preserves explicitly requested roots', () => {
  assert.deepEqual(find(`${forward(fixture)}/**/app`), sorted(['one/app', 'deep/nested/app', 'with space/app'].map(dir => path.join(fixture, dir))));
});
test('brace alternatives preserve matching roots', () => {
  assert.deepEqual(find(`${forward(fixture)}/{one,two}`), sorted(['one', 'two'].map(dir => path.join(fixture, dir))));
});
test('extglob alternatives preserve matching roots', () => {
  assert.deepEqual(find(`${forward(fixture)}/@(one|two)`), sorted(['one', 'two'].map(dir => path.join(fixture, dir))));
});
test('missing paths and ordinary files are not project roots', () => {
  assert.deepEqual(find(path.join(fixture, 'missing')), []);
  assert.deepEqual(find(path.join(fixture, 'plain-file')), []);
});
test('explicit dot directories remain usable while glob defaults exclude them', () => {
  assert.deepEqual(find(path.join(fixture, '.hidden')), [forward(path.join(fixture, '.hidden'))]);
});
test('the actual Next resolver keeps its default context root', () => {
  assert.deepEqual(getRootDirs({ cwd: fixture, settings: {} }), [fixture]);
});
test('the actual Next resolver handles Windows path separators', () => {
  assert.deepEqual(sorted(getRootDirs({ cwd: fixture, settings: { next: { rootDir: forward(path.join(fixture, 'one')).replace(/\//g, '\\') } } })), [forward(path.join(fixture, 'one'))]);
});
test('the actual Next resolver handles configured root arrays and ignores non-string entries', () => {
  const roots = [path.join(fixture, 'one'), null, 42, path.join(fixture, 'two')];
  assert.deepEqual(sorted(getRootDirs({ cwd: fixture, settings: { next: { rootDir: roots } } })), sorted([roots[0], roots[3]]));
});
test('oversized, deeply nested or unsupported requests fail with a bounded refusal', () => {
  for (const pattern of ['', 'a'.repeat(4097), `${'{'.repeat(33)}x${'}'.repeat(33)}`, `${'('.repeat(33)}x${')'.repeat(33)}`, 'bad\0pattern']) {
    assert.throws(() => globSync(pattern, { onlyDirectories: true }), { name: 'TypeError', message: 'next_root_glob_invalid' });
  }
  for (const options of [undefined, {}, { onlyDirectories: false }, { onlyDirectories: true, onlyFiles: false }]) {
    assert.throws(() => globSync('src', options), { name: 'TypeError', message: 'next_root_glob_invalid' });
  }
  assert.throws(() => globSync(['src'], { onlyDirectories: true }), /next_root_glob_invalid/);
});
test('normal character classes still match and escaped parentheses do not count as nesting', () => {
  assert.deepEqual(find(`${forward(fixture)}/[ot]*`), sorted(['one', 'two'].map(dir => path.join(fixture, dir))));
  assert.doesNotThrow(() => globSync(`${'\\('.repeat(33)}x`, { onlyDirectories: true }));
});

test('the real Next internal-link rule still discovers configured app and pages roots', () => {
  const linter = new Linter();
  const config = [{
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { next: { rootDir: `${forward(fixture)}/{one,two}` } },
    plugins: { '@next/next': plugin },
    rules: { '@next/next/no-html-link-for-pages': 'error' },
  }];
  const internal = linter.verify('export default () => <a href="/">Internal</a>', config);
  assert.ok(internal.some(message => message.ruleId === '@next/next/no-html-link-for-pages'), JSON.stringify(internal));
  for (const code of ['export default () => <a href="https://example.invalid/">External</a>', 'export default () => <a href="/" download>Download</a>', 'export default () => <Link href="/">Internal</Link>']) {
    assert.deepEqual(linter.verify(code, config), []);
  }
});

test('the full repository config retains all Next recommendations and React and TypeScript enforcement', async () => {
  const eslint = new ESLint({ cwd: root });
  const config = await eslint.calculateConfigForFile(path.join(root, 'src/app/page.tsx'));
  const nextRules = { ...plugin.configs.recommended.rules, ...plugin.configs['core-web-vitals'].rules };
  const severity = value => Array.isArray(value) ? value[0] : value;
  for (const [name, value] of Object.entries(nextRules)) {
    const expected = value === 'error' ? 2 : value === 'warn' ? 1 : value;
    assert.equal(severity(config.rules[name]), expected, name);
  }
  for (const name of ['react/jsx-key', 'react-hooks/rules-of-hooks', '@typescript-eslint/no-explicit-any']) {
    assert.ok(severity(config.rules[name]) > 0, name);
  }
});
