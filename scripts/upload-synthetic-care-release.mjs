/** Upload/read back code only. No stack execution, schema write, fixture or PHI activation. */
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {S3Client, GetBucketLocationCommand, GetBucketVersioningCommand, GetBucketEncryptionCommand,
  PutObjectCommand, HeadObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P, sha256, careSourceSnapshot, careMobileBinding, refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity, SYNTHETIC_MEMBER_PROFILE} from './synthetic-aws-principal.mjs';

const canonical = value => JSON.stringify(value);
const checksum = m => Buffer.from(m.zipSha256, 'hex').toString('base64');
const metadata = m => ({'source-desktop': m.desktop.commit, 'source-mobile': m.mobile.source.commit,
  sha256: m.zipSha256, execution: 'synthetic-staging', 'phi-allowed': 'false'});
export function verifyCareUploadPreparation(plan, manifest, now = Date.now()) {
  const age = now - Date.parse(plan?.observedAt);
  if (plan?.contract !== 'synthetic-care-release-preparation/1' || !Number.isFinite(age) || age < 0 || age > 120000
    || plan.account !== P.account || plan.phiAllowed !== false || plan.awsMutationPerformed !== false
    || plan.deployed !== false || plan.candidateUploaded !== false || plan.paidMobileBuildStarted !== false
    || plan.routeCount !== 51 || plan.previousCodeSha256 !== Buffer.from(P.previousZipSha256, 'hex').toString('base64')
    || plan.candidateZipSha256 !== manifest.zipSha256 || canonical(plan.desktop) !== canonical(manifest.desktop)
    || canonical(plan.mobile) !== canonical(manifest.mobile) || manifest.phiAllowed !== false
    || manifest.deployed !== false || manifest.acceptance !== false || manifest.phiActivation !== false
    || !/^[a-f0-9]{64}$/.test(manifest.zipSha256) || !Number.isSafeInteger(manifest.zipBytes)
    || manifest.zipBytes <= 0 || manifest.zipBytes > 10 * 1024 * 1024
    || manifest.key !== `clinical-core/authenticated-api/care-release/${manifest.desktop.commit}/${manifest.zipSha256}.zip`) fail('upload_preparation');
}
export function verifyCareUploadBucket(location, versioning, encryption) {
  const rules = encryption?.ServerSideEncryptionConfiguration?.Rules;
  if (location?.LocationConstraint !== P.region || versioning?.Status !== 'Enabled' || rules?.length !== 1
    || rules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'aws:kms'
    || rules[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID !== P.keyArn
    || rules[0].BucketKeyEnabled !== true) fail('upload_bucket');
}
const validVersion = v => typeof v === 'string' && v.length > 0 && v.length <= 1024 && v !== 'null';
export function verifyCareStoredArtifact(response, manifest, version) {
  const actual = response?.Metadata, expected = metadata(manifest);
  if (!validVersion(version) || response?.VersionId !== version || response.DeleteMarker === true
    || response.ContentLength !== manifest.zipBytes || response.ContentType !== 'application/zip'
    || response.ServerSideEncryption !== 'aws:kms' || response.SSEKMSKeyId !== P.keyArn || response.BucketKeyEnabled !== true
    || response.ChecksumSHA256 !== checksum(manifest)
    || response.ChecksumType && response.ChecksumType !== 'FULL_OBJECT'
    || response.WebsiteRedirectLocation || !actual || Object.keys(actual).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => actual[key] !== value)) fail('stored_artifact');
}
export async function readCareArtifact(body, manifest, signal) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function' || typeof body.destroy !== 'function') fail('artifact_body');
  const chunks = []; let count = 0;
  const abort = () => body.destroy(new Error('synthetic_care_release_refused:artifact_timeout'));
  signal?.addEventListener('abort', abort, {once: true});
  try {
    if (signal?.aborted) fail('artifact_stream');
    for await (const value of body) {
      if (signal?.aborted || !(value instanceof Uint8Array)) fail('artifact_stream');
      count += value.byteLength;
      if (count > manifest.zipBytes) fail('artifact_overrun');
      chunks.push(Buffer.from(value));
    }
    if (signal?.aborted || count !== manifest.zipBytes) fail('artifact_length');
    const result = Buffer.concat(chunks, count);
    if (sha256(result) !== manifest.zipSha256) fail('artifact_digest');
    return result;
  } catch (error) {body.destroy(); throw error;}
  finally {signal?.removeEventListener('abort', abort);}
}
/** The transport is injected only for credential-free failure tests, not exposed as a CLI override. */
export async function uploadAndVerifyCareArtifact(send, manifest, zip) {
  if (zip.length !== manifest.zipBytes || sha256(zip) !== manifest.zipSha256) fail('upload_local_bytes');
  const bucket = {Bucket: P.bucket, ExpectedBucketOwner: P.account};
  verifyCareUploadBucket(await send(new GetBucketLocationCommand(bucket)),
    await send(new GetBucketVersioningCommand(bucket)), await send(new GetBucketEncryptionCommand(bucket)));
  let put, reused = false;
  try {
    put = await send(new PutObjectCommand({...bucket, Key: manifest.key, Body: zip, ContentLength: zip.length,
      ContentType: 'application/zip', IfNoneMatch: '*', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: P.keyArn,
      BucketKeyEnabled: true, ChecksumSHA256: checksum(manifest), Metadata: metadata(manifest)}));
  } catch (error) {
    // A timeout, 409, 403 or unknown response is not evidence of an existing valid artifact.
    if (error?.$metadata?.httpStatusCode !== 412 || error.name !== 'PreconditionFailed') throw error;
    put = await send(new HeadObjectCommand({...bucket, Key: manifest.key, ChecksumMode: 'ENABLED'}));
    reused = true;
  }
  if (!validVersion(put.VersionId) || put.ServerSideEncryption !== 'aws:kms' || put.SSEKMSKeyId !== P.keyArn
    || put.BucketKeyEnabled !== true || put.ChecksumSHA256 !== checksum(manifest)) fail('upload_receipt');
  const request = {...bucket, Key: manifest.key, VersionId: put.VersionId, ChecksumMode: 'ENABLED'};
  verifyCareStoredArtifact(await send(new HeadObjectCommand(request)), manifest, put.VersionId);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const object = await send(new GetObjectCommand(request), {abortSignal: controller.signal});
    try {verifyCareStoredArtifact(object, manifest, put.VersionId);} catch (error) {object.Body?.destroy?.(); throw error;}
    const remote = await readCareArtifact(object.Body, manifest, controller.signal);
    if (!remote.equals(zip)) fail('artifact_readback');
  } finally {clearTimeout(timer);}
  return {bucket: P.bucket, key: manifest.key, versionId: put.VersionId, sha256: manifest.zipSha256,
    bytes: manifest.zipBytes, reused, encryption: 'aws:kms', kmsKeyArn: P.keyArn, exactVersionReadbackVerified: true};
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--v2-root' || args[2] !== '--candidate' || args[4] !== '--upload-fictional-code-only'
    || args[1].startsWith('--') || args[3].startsWith('--')) fail('arguments');
  const root = process.cwd(), mobileRoot = resolve(args[1]), dir = resolve(args[3]);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'artifact-manifest.json'), 'utf8'));
  const zip = readFileSync(resolve(dir, 'candidate.zip'));
  // This rebuilds the real handler and observes the complete live authority and database.
  const plan = JSON.parse(execFileSync(process.execPath, [resolve(root, 'scripts/prepare-synthetic-care-release.mjs'),
    '--v2-root', mobileRoot, '--candidate', dir, '--prepare-fictional-only'],
  {encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}));
  observeSyntheticMemberIdentity(); verifyCareUploadPreparation(plan, manifest);
  const unchanged = () => {
    if (canonical(careSourceSnapshot(root, 'desktop')) !== canonical(manifest.desktop)
      || canonical(careMobileBinding(mobileRoot, root)) !== canonical(manifest.mobile)
      || !readFileSync(resolve(dir, 'candidate.zip')).equals(zip)) fail('source_changed');
  };
  unchanged();
  const client = new S3Client({region: P.region, credentials: fromIni({profile: SYNTHETIC_MEMBER_PROFILE}), maxAttempts: 1});
  const send = (command, options = {}) => client.send(command, {...options, abortSignal: options.abortSignal ?? AbortSignal.timeout(30000)});
  try {
    const artifact = await uploadAndVerifyCareArtifact(send, manifest, zip); unchanged();
    const receipt = {contract: 'synthetic-care-artifact-upload/1', observedAt: new Date().toISOString(),
      execution: 'synthetic-staging', account: P.account, region: P.region, desktop: manifest.desktop, mobile: manifest.mobile,
      preparation: plan.directory, artifact, candidateUploaded: true, awsMutationPerformed: !artifact.reused,
      changeSetCreated: false, deployed: false, schemaChanged: false, rollbackRehearsed: false,
      hostedAcceptance: false, phiAllowed: false, paidMobileBuildStarted: false};
    const out = resolve(dir, 'uploads'); mkdirSync(out, {recursive: true});
    const file = resolve(out, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({receipt: file, ...receipt}));
  } finally {client.destroy();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(error.message?.startsWith('synthetic_care_release_refused:') ? error.message
    : 'synthetic_care_release_refused:upload_failed_or_unconfirmed'); process.exitCode = 1;});
}
