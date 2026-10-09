/** Build the exact matched fictional API package; no AWS calls or mobile builds. */
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_RELEASE, careSourceSnapshot, careMigrationBinding, careMobileBinding, careReleaseZip,
  normalizedText, sha256, buildCareIdentityBundle, refuseCareRelease} from './synthetic-care-release.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--v2-root' || args[1].startsWith('--')) refuseCareRelease('arguments');
  const root = process.cwd(), mobileRoot = resolve(args[1]);
  const desktop = careSourceSnapshot(root, 'desktop'), mobile = careMobileBinding(mobileRoot, root);
  const migrations = careMigrationBinding(root);
  const directory = resolve(root, 'dist/synthetic-care-release', desktop.commit, mobile.source.commit);
  mkdirSync(directory, {recursive: true});
  const bundle = await buildCareIdentityBundle(root);
  const release = {contract: CARE_RELEASE.contract, execution: 'synthetic-staging', phiAllowed: false,
    desktop, mobile, migrations, bundleSha256: sha256(bundle),
    templateSha256: sha256(normalizedText(root, 'infra/aws-clinical-core/identity-api-extension.json')),
    erasureProtocol: 'request-id-receipt-settlement/1', legacyErasureAdmission: false,
    // Restoring the old code after revoking its SQL authority is not rollback.
    rollback: {databaseDownMigrationAllowed: false, previousApiAllowedAfterUpgrade: false,
      successorCompatibleReForwardRequired: true, rehearsed: false},
    deployed: false, acceptance: false, phiActivation: false};
  const zip = careReleaseZip(bundle, release), zipSha256 = sha256(zip);
  const manifest = {...release, zipSha256, zipBytes: zip.length,
    key: `clinical-core/authenticated-api/care-release/${desktop.commit}/${zipSha256}.zip`};
  if (JSON.stringify(desktop) !== JSON.stringify(careSourceSnapshot(root, 'desktop'))
    || JSON.stringify(mobile) !== JSON.stringify(careMobileBinding(mobileRoot, root))) refuseCareRelease('source_changed_during_build');
  for (const [name, data] of [['index.js', bundle], ['release.json', JSON.stringify(release) + '\n'],
    ['candidate.zip', zip], ['artifact-manifest.json', JSON.stringify(manifest, null, 2) + '\n']]) {
    const file = resolve(directory, name);
    try {writeFileSync(file, data, {flag: 'wx'});} catch {if (!readFileSync(file).equals(Buffer.from(data))) refuseCareRelease('artifact_collision');}
  }
  console.log(JSON.stringify({directory, desktopCommit: desktop.commit, mobileCommit: mobile.source.commit,
    zipSha256, built: true, deployed: false, paidMobileBuildStarted: false, phiAllowed: false}));
} catch (error) {
  console.error(error.message?.startsWith('synthetic_care_release_refused:') ? error.message : 'synthetic_care_release_refused:build');
  process.exitCode = 1;
}
