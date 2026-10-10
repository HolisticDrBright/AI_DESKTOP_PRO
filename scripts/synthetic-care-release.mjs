/** Shared, credential-free release binding. This is not activation evidence. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readHistoricalCareParentMigrations,readHistoricalCatalogParentMigrations} from './care-canonical-migrations.mjs';

export const CARE_RELEASE = Object.freeze({
  contract: 'synthetic-care-release/1', account: '588966314750', region: 'us-east-2',
  foundation: 'ai-clinical-core-synthetic-staging', stack: 'ai-clinical-core-synthetic-staging-authenticated-api',
  apiId: 'wxv734oi12', functionName: 'wxv734oi12-synthetic-identity', database: 'clinical_core',
  cluster: 'arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa',
  secret: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-b98d4dce-bd27-475e-ae27-8f11f49c6d09-S79X4B',
  bucket: 'ai-clinical-core-synthetic-clinicaldocumentsbucket-1wv5abdrcnn7',
  consumerPool: 'us-east-2_nYngyyYGE', consumerClient: '72aksm2dm4nf03l8d9nrp2dbh0',
  workforcePool: 'us-east-2_ueGlFRbNB', workforceClient: '4s7jgr4o8sqdq7cvo9gmq96e2h',
  keyArn: 'arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900',
  previousZipSha256: '58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247',
  sourceBefore: '1da8cf4c3c8edfa1f3fc2d3230940c65eb33f1e0ad61f25582112c34766f3e22',
  sourceAfter: '52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017',
  liveBefore: '2563a6bbe70c75bbb2e9c423aececf6cf92eaead44f28da7a8c457225e0ed393',
  liveAfter: '99ad59a94bab717a4e1299979db177394e931c9ebb7f40aa8be1ba1d99d52148',
  reference: '83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',
  // Existing staging intentionally lacks these routes. A code-only update cannot add them.
  absentRoutes: ['ConsumerSpecimenContextWriteRoute', 'ConsumerSpecimenContextReadRoute',
    'WorkforceSpecimenContextReadRoute', 'PublicConsultIntakeRoute',
    'WorkforceConsentArtifactRoute', 'WorkforceCurrentConsentRoute'],
});
export const refuseCareRelease = reason => {throw new Error(`synthetic_care_release_refused:${reason}`);};
export const sha256 = v => createHash('sha256').update(v).digest('hex');
export const normalizedText = (root, file) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n?/g, '\n');
export async function buildCareIdentityBundle(root) {
  const {build} = await import('esbuild');
  const result = await build({absWorkingDir: resolve(root), entryPoints: [resolve(root, 'src/server/clinical-core/aws-identity-lambda.ts')],
    write: false, bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false,
    sourcemap: false, legalComments: 'none', treeShaking: true, logLevel: 'warning'});
  if (result.outputFiles?.length !== 1) refuseCareRelease('build_outputs');
  return Buffer.from(result.outputFiles[0].contents);
}
const git = (root, args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', windowsHide: true,
  timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
export function careSourcePaths(kind) {
  return kind === 'desktop' ? ['src', 'scripts', 'infra', '.github', 'package.json', 'package-lock.json', '.gitattributes']
    : kind === 'v2' ? ['expo', 'scripts', 'data', '.github', 'package.json', 'package-lock.json', 'bun.lock', '.gitattributes']
      : refuseCareRelease('source_kind');
}
export function careSourceEntry(file, bytes) {
  const data = /\.(?:[cm]?[jt]sx?|json|md|sql|ya?ml|ps1|css|html|txt)$/.test(file) || /(?:^|\/)(?:\.gitattributes|package-lock.json)$/.test(file)
    ? bytes.toString('utf8').replace(/\r\n?/g, '\n') : bytes;
  return {file, sha256: sha256(data)};
}
export function careSourceSnapshot(root, kind) {
  const paths = careSourcePaths(kind);
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)
    || git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...paths]).trim()) refuseCareRelease('source_dirty');
  const files = git(root, ['ls-files', '-z', '--', ...paths]).split('\0').filter(Boolean).sort();
  if (!files.length) refuseCareRelease('source_empty');
  // Text is LF-normalized, binary assets are byte-exact. Hashes include the path.
  const entries = files.map(file => careSourceEntry(file, readFileSync(resolve(root, file))));
  return {commit, clean: true, files: entries.length, sha256: sha256(JSON.stringify(entries))};
}
export function careMigrationBinding(root, historicalSourceOnly = false) {
  // Explicit historical test/build view only. Real release commands use the
  // default current manifest and continue to refuse this retired generation.
  if (typeof historicalSourceOnly !== 'boolean') refuseCareRelease('historical_mode');
  const load = folder => {
    const base = `infra/aws-clinical-core/${folder}/`;
    const manifest = JSON.parse(normalizedText(root, base + 'manifest.json'));
    if (manifest.contract_version !== 'clinical-core-migrations/1' || !Array.isArray(manifest.migrations)) refuseCareRelease('migration_manifest');
    return manifest.migrations.map((m, i, all) => {
      if (!/^\d{14}$/.test(m.version) || !new RegExp(`^${m.version}_[a-z0-9_]+\\.sql$`).test(m.file)
        || i && m.version <= all[i - 1].version) refuseCareRelease('migration_order');
      return {version: m.version, name: m.file.slice(15, -4), sha256: sha256(normalizedText(root, base + m.file))};
    });
  };
  const core = historicalSourceOnly ? readHistoricalCareParentMigrations(root).map(({version,name,sha256})=>({version,name,sha256})) : load('migrations');
  const catalog = historicalSourceOnly ? readHistoricalCatalogParentMigrations(root).map(({version,name,sha256})=>({version,name,sha256})) : load('catalog-migrations');
  if (core.length !== 46 || catalog.length !== 2 || sha256(JSON.stringify(core.slice(0, 45))) !== CARE_RELEASE.sourceBefore
    || sha256(JSON.stringify(core)) !== CARE_RELEASE.sourceAfter || sha256(JSON.stringify(catalog)) !== CARE_RELEASE.reference) refuseCareRelease('migration_drift');
  return {sourceBefore: CARE_RELEASE.sourceBefore, sourceAfter: CARE_RELEASE.sourceAfter,
    liveBefore: CARE_RELEASE.liveBefore, liveAfter: CARE_RELEASE.liveAfter, reference: CARE_RELEASE.reference,
    sourceCount: 46, liveBeforeCount: 46, liveAfterCount: 47, historicalAliasPreserved: true};
}
export function careMobileBinding(root, desktopRoot) {
  const contract = normalizedText(root, 'expo/contracts/careDataLifecycle.ts');
  if (contract !== normalizedText(desktopRoot, 'src/contracts/careDataLifecycle.ts')) refuseCareRelease('cross_app_contract');
  const eas = JSON.parse(normalizedText(root, 'expo/eas.json'));
  for (const profile of ['testflight', 'android-health-connect']) {
    const env = eas.build?.[profile]?.env;
    if (env?.EXPO_PUBLIC_RELEASE_CHANNEL !== 'synthetic-testflight' || env?.EXPO_PUBLIC_SYNTHETIC_ACCOUNT_DOMAIN !== 'brightlongevity.test'
      || env?.EXPO_PUBLIC_CLINICAL_AWS_API_ORIGIN !== `https://${CARE_RELEASE.apiId}.execute-api.${CARE_RELEASE.region}.amazonaws.com`
      || env?.EXPO_PUBLIC_CLINICAL_AWS_RUNTIME_MODE !== 'synthetic'
      || env?.EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_POOL_ID !== CARE_RELEASE.consumerPool
      || env?.EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_CLIENT_ID !== CARE_RELEASE.consumerClient
      || env?.EXPO_PUBLIC_CLINICAL_AWS_PRODUCTION_VERIFIED === 'true') refuseCareRelease('mobile_destination');
  }
  return {source: careSourceSnapshot(root, 'v2'), contractSha256: sha256(contract),
    requestJournalSha256: sha256(normalizedText(root, 'expo/lib/clinicalData/careErasureJournal.ts')),
    transportSha256: sha256(normalizedText(root, 'expo/lib/clinicalData/awsCareDataLifecycle.ts')),
    easSha256: sha256(normalizedText(root, 'expo/eas.json')), built: false, deviceVerified: false};
}
/** Deterministic, uncompressed ZIP with fixed timestamp. Only the two admitted files. */
export function careReleaseZip(bundle, release) {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
    return (crc ^ 0xffffffff) >>> 0;
  };
  const bodies = [], central = []; let offset = 0;
  for (const [name, data] of [['index.js', bundle], ['release.json', Buffer.from(JSON.stringify(release) + '\n')]]) {
    const n = Buffer.from(name), b = Buffer.from(data), crc = crc32(b), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x5021, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(b.length, 18); local.writeUInt32LE(b.length, 22); local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x5021, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(b.length, 20); entry.writeUInt32LE(b.length, 24);
    entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(offset, 42);
    bodies.push(local, n, b); central.push(entry, n); offset += local.length + n.length + b.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, directory, end]);
}
