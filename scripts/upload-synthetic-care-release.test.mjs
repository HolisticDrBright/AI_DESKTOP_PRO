import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {CARE_RELEASE as P, sha256} from './synthetic-care-release.mjs';
import {verifyCareUploadPreparation, verifyCareUploadBucket, verifyCareStoredArtifact,
  readCareArtifact, uploadAndVerifyCareArtifact} from './upload-synthetic-care-release.mjs';
const zip = Buffer.from('fictional code artifact');
const manifest = {desktop: {commit: 'a'.repeat(40), clean: true}, mobile: {source: {commit: 'b'.repeat(40)}, built: false},
  zipSha256: sha256(zip), zipBytes: zip.length, phiAllowed: false, deployed: false, acceptance: false, phiActivation: false};
manifest.key = `clinical-core/authenticated-api/care-release/${manifest.desktop.commit}/${manifest.zipSha256}.zip`;
const location = {LocationConstraint: P.region}, versioning = {Status: 'Enabled'},
  encryption = {ServerSideEncryptionConfiguration: {Rules: [{BucketKeyEnabled: true,
    ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'aws:kms', KMSMasterKeyID: P.keyArn}}]}};
const response = () => ({VersionId: 'fictional-version', ContentLength: zip.length, ContentType: 'application/zip',
  ServerSideEncryption: 'aws:kms', SSEKMSKeyId: P.keyArn, BucketKeyEnabled: true, ChecksumType: 'FULL_OBJECT',
  ChecksumSHA256: Buffer.from(manifest.zipSha256, 'hex').toString('base64'),
  Metadata: {'source-desktop': manifest.desktop.commit, 'source-mobile': manifest.mobile.source.commit,
    sha256: manifest.zipSha256, execution: 'synthetic-staging', 'phi-allowed': 'false'}});
test('only fresh non-mutating exact preparation authorizes code upload', () => {
  const now = Date.now(), plan = {contract: 'synthetic-care-release-preparation/1', observedAt: new Date(now).toISOString(),
    account: P.account, phiAllowed: false, awsMutationPerformed: false, deployed: false, candidateUploaded: false,
    paidMobileBuildStarted: false, routeCount: 51, previousCodeSha256: Buffer.from(P.previousZipSha256, 'hex').toString('base64'),
    candidateZipSha256: manifest.zipSha256, desktop: manifest.desktop, mobile: manifest.mobile};
  verifyCareUploadPreparation(plan, manifest, now);
  for (const mutate of [p => p.observedAt = new Date(now - 120001).toISOString(), p => p.observedAt = new Date(now + 1).toISOString(),
    p => p.observedAt = 'invalid', p => p.account = '173535830222', p => p.phiAllowed = true,
    p => p.deployed = true, p => p.awsMutationPerformed = true, p => p.candidateUploaded = true,
    p => p.paidMobileBuildStarted = true, p => p.routeCount = 55, p => p.candidateZipSha256 = 'f'.repeat(64),
    p => p.previousCodeSha256 = 'other', p => p.mobile.source.commit = 'f'.repeat(40)]) {
    const changed = structuredClone(plan); mutate(changed); assert.throws(() => verifyCareUploadPreparation(changed, manifest, now));
  }
  for (const mutate of [m => m.key += '/escape', m => m.zipBytes = 0, m => m.zipBytes = 10 * 1024 * 1024 + 1,
    m => m.phiAllowed = true, m => m.acceptance = true, m => m.phiActivation = true]) {
    const changed = structuredClone(manifest); mutate(changed); assert.throws(() => verifyCareUploadPreparation(plan, changed, now));
  }
});
test('region, enabled versions and exact single KMS rule are mandatory', () => {
  verifyCareUploadBucket(location, versioning, encryption);
  for (const [l, v, e] of [[{}, versioning, encryption], [location, {Status: 'Suspended'}, encryption],
    [location, versioning, {}], [location, versioning, {ServerSideEncryptionConfiguration: {Rules: []}}],
    [location, versioning, {ServerSideEncryptionConfiguration: {Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'AES256'}}]}}]])
    assert.throws(() => verifyCareUploadBucket(l, v, e));
});
test('readback refuses wrong version, length, metadata, encryption, checksum or redirect', () => {
  verifyCareStoredArtifact(response(), manifest, 'fictional-version');
  for (const mutate of [r => r.VersionId = 'null', r => r.VersionId = 'different', r => r.DeleteMarker = true,
    r => r.ContentLength++, r => r.ContentType = 'text/plain', r => r.ServerSideEncryption = 'AES256',
    r => r.SSEKMSKeyId = 'other', r => r.BucketKeyEnabled = false, r => r.ChecksumSHA256 = 'different',
    r => r.ChecksumType = 'COMPOSITE', r => r.WebsiteRedirectLocation = 'https://other.invalid',
    r => delete r.Metadata.sha256, r => r.Metadata['phi-allowed'] = 'true', r => r.Metadata.extra = 'unexpected']) {
    const changed = response(); mutate(changed); assert.throws(() => verifyCareStoredArtifact(changed, manifest, 'fictional-version'));
  }
});
test('stream reads actual bytes; overrun, short body, digest mismatch and stalled abort fail closed', async () => {
  assert.deepEqual(await readCareArtifact(Readable.from([zip]), manifest), zip);
  for (const bytes of [zip.subarray(1), Buffer.concat([zip, Buffer.from('extra')]), Buffer.alloc(zip.length)]) {
    const body = Readable.from([bytes]); await assert.rejects(readCareArtifact(body, manifest)); assert.equal(body.destroyed, true);
  }
  const controller = new AbortController(), stalled = new Readable({read() {}});
  const pending = readCareArtifact(stalled, manifest, controller.signal); controller.abort();
  await assert.rejects(pending, /artifact_timeout/); assert.equal(stalled.destroyed, true);
});
function transport(putError, changeHead) {
  const commands = [];
  const send = async (command, options) => {
    commands.push(command);
    assert.equal(command.input.Bucket, P.bucket); assert.equal(command.input.ExpectedBucketOwner, P.account);
    switch (command.constructor.name) {
      case 'GetBucketLocationCommand': return location;
      case 'GetBucketVersioningCommand': return versioning;
      case 'GetBucketEncryptionCommand': return encryption;
      case 'PutObjectCommand': if (putError) throw putError; return response();
      case 'HeadObjectCommand': {const r = response(); changeHead?.(r); return r;}
      case 'GetObjectCommand': assert.equal(command.input.VersionId, 'fictional-version'); assert.ok(options.abortSignal);
        return {...response(), Body: Readable.from([zip])};
      default: throw new Error('unexpected command');
    }
  };
  return {send, commands};
}
test('create-only put, exact-version HEAD and actual download; identical collision never overwrites', async () => {
  for (const reused of [false, true]) {
    const t = transport(reused ? {name: 'PreconditionFailed', $metadata: {httpStatusCode: 412}} : undefined);
    const actual = await uploadAndVerifyCareArtifact(t.send, manifest, zip);
    assert.equal(actual.exactVersionReadbackVerified, true); assert.equal(actual.reused, reused);
    const put = t.commands.find(c => c.constructor.name === 'PutObjectCommand');
    assert.equal(put.input.IfNoneMatch, '*'); assert.deepEqual(put.input.Body, zip);
    assert.equal(put.input.SSEKMSKeyId, P.keyArn); assert.equal(put.input.ChecksumSHA256, response().ChecksumSHA256);
    assert.equal(t.commands.filter(c => c.constructor.name === 'PutObjectCommand').length, 1);
  }
});
test('unknown put outcome or collision mismatch cannot certify upload or trigger another write', async () => {
  for (const error of [{name: 'TimeoutError'}, {name: 'ConditionalRequestConflict', $metadata: {httpStatusCode: 409}},
    {name: 'AccessDenied', $metadata: {httpStatusCode: 403}}]) {
    const t = transport(error); await assert.rejects(uploadAndVerifyCareArtifact(t.send, manifest, zip));
    assert.equal(t.commands.length, 4);
  }
  const t = transport({name: 'PreconditionFailed', $metadata: {httpStatusCode: 412}}, r => r.ChecksumSHA256 = 'other');
  await assert.rejects(uploadAndVerifyCareArtifact(t.send, manifest, zip));
  assert.equal(t.commands.some(c => c.constructor.name === 'GetObjectCommand'), false);
  const noCalls = transport(); await assert.rejects(uploadAndVerifyCareArtifact(noCalls.send, manifest, Buffer.from('changed')));
  assert.equal(noCalls.commands.length, 0);
});
