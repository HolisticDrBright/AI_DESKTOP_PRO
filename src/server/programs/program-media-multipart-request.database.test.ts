import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { classifyDatabaseRejection } from '@/server/clinical-core/rds-data-database';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ProgramMediaMultipartSession } from './program-media-multipart-ledger';
import type { ProgramMediaMultipartAdmission, AwsProgramMediaMultipartStore } from './aws-program-media-multipart-store';
import type { AwsProgramMediaStoreConfiguration } from './aws-program-media-store';
import { createProgramMediaNativeLedger } from './program-media-native-ledger';
import { createProgramMediaMultipartRequestSource } from './program-media-multipart-request';
import { ProgramMediaError, ProgramMediaWriteError } from './program-media-authoring';
import { PROGRAM_MEDIA_PART_BYTES, type ProgramMediaPartManifest } from './program-media-parts';
import { createProgramMediaMultipartHandler } from './program-media-multipart-http';
import { createProgramMediaMultipartPreviewRequestSource } from './program-media-multipart-preview-request';
import { createProgramMediaMultipartLedger } from './program-media-multipart-ledger';
import { createProgramMediaControlHandler } from './program-media-http';

const seam = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('./aws-program-media-multipart-store', () => ({ createAwsProgramMediaMultipartStoreSource: seam.open }));
const id = (n: number) => '74000000-0000-4000-8000-' + String(n).padStart(12, '0');
const context = { actorPersonId: id(1), organizationId: id(2), identityPool: 'workforce', identitySubject: 'syn_multipart_request_educator',
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false } as ClinicalRequestContext;
const storage = { purpose: 'educational_media' as const, phiAllowed: false as const, dedicated: true as const, bucket: 'alp-synthetic-lessons',
  expectedBucketOwner: '588966314750', region: 'us-east-2', kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/' + id(99),
  maxImageBytes: 16777216, maxVideoBytes: 268435456, publicOrigin: 'https://lessons.example.test/' };
const activation = { enabled: true, nativeEvidenceSha256: 'a'.repeat(64), multipartEvidenceSha256: 'b'.repeat(64) };
const policyReview = { contract: 'program-media-multipart-resource-review/1' as const, policySha256: 'c'.repeat(64), evidenceSha256: 'd'.repeat(64) };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const small = new TextEncoder().encode('Fictional educational video, not patient information');
let db: PGlite, insideTransaction = false, operations: string[];
let programId: string;
let failBefore: Set<string>, failAfter: Set<string>;
let database: ClinicalCoreDatabase;

/** Local fictional store only. It computes observations from bytes, never from
 * a ready-made success response. Parent SDK suites separately test actual S3
 * serialization/middleware. This suite proves composition with real SQL. */
function fictionalStore() {
  const uploads = new Map<string, { session: ProgramMediaMultipartSession; parts: Map<number, { bytes: Uint8Array; etag: string }> }>();
  const versions = new Map<string, { session: ProgramMediaMultipartSession; bytes: Uint8Array }>();
  const external = () => expect(insideTransaction, 'provider I/O must be outside SQL transactions').toBe(false);
  const admission = (a: ProgramMediaMultipartAdmission) => { external(); expect(a.admitted).toBe(true); expect(a.session.pending.some(p => p.claimId === a.claimId && p.state === 'open')).toBe(true); };
  const create = vi.fn(async (a: ProgramMediaMultipartAdmission) => {
    admission(a); const uploadId = 'fictional-upload-' + randomUUID(); uploads.set(uploadId, { session: structuredClone(a.session), parts: new Map() }); return { uploadId };
  });
  const part = vi.fn(async (a: ProgramMediaMultipartAdmission, partNumber: number, bytes: Uint8Array) => {
    admission(a); const upload = uploads.get(a.session.uploadId!)!; const etag = '"fictional-part-' + randomUUID() + '"';
    upload.parts.set(partNumber, { bytes: new Uint8Array(bytes), etag }); return { partNumber, bytes: bytes.length, checksum: Buffer.from(hash(bytes), 'hex').toString('base64'), etag };
  });
  const complete = vi.fn(async (a: ProgramMediaMultipartAdmission) => {
    admission(a); const upload = uploads.get(a.session.uploadId!)!;
    const bytes = new Uint8Array(Buffer.concat(a.session.manifest.parts.map(p => Buffer.from(upload.parts.get(p.partNumber)!.bytes))));
    const objectVersion = 'fictional-version-' + randomUUID(); versions.set(objectVersion, { session: structuredClone(a.session), bytes });
    uploads.delete(a.session.uploadId!); return { objectVersion, checksum: a.session.checksum };
  });
  const parts = vi.fn(async (s: ProgramMediaMultipartSession) => {
    external(); const upload = uploads.get(s.uploadId!); if (!upload) return { complete: false, parts: [] };
    return { complete: true, parts: [...upload.parts].map(([partNumber, p]) => ({ partNumber, bytes: p.bytes.length,
      checksum: Buffer.from(hash(p.bytes), 'hex').toString('base64'), etag: p.etag })) };
  });
  const inventory = vi.fn(async (s: ProgramMediaMultipartSession) => {
    external(); return { complete: true, checkedAt: new Date().toISOString(),
      uploads: [...uploads].filter(([, u]) => u.session.objectKey === s.objectKey).map(([uploadId]) => ({ uploadId, initiatedAt: new Date().toISOString() })),
      versions: [...versions].filter(([, v]) => v.session.objectKey === s.objectKey).map(([objectVersion, v]) => ({ objectVersion, deleteMarker: false, bytes: v.bytes.length })) };
  });
  const verify = vi.fn(async (s: ProgramMediaMultipartSession) => {
    external(); const stored = versions.get(s.objectVersion!);
    if (!stored || stored.session.writerClaimId !== s.writerClaimId || stored.session.objectKey !== s.objectKey || stored.session.checksum !== s.checksum
      || hash(stored.bytes) !== s.sha256 || stored.bytes.length !== s.totalBytes) throw new ProgramMediaError('storage_unverified');
    for (const p of s.manifest.parts) if (hash(stored.bytes.subarray((p.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES, (p.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES + p.bytes)) !== p.sha256)
      throw new ProgramMediaError('storage_unverified');
    return { objectVersion: s.objectVersion!, checksum: s.checksum, sha256: hash(stored.bytes), bytes: stored.bytes.length };
  });
  const abort = vi.fn(async (_s: ProgramMediaMultipartSession, uploadId: string) => { external(); uploads.delete(uploadId); });
  const removeVersion = vi.fn(async (_s: ProgramMediaMultipartSession, version: string) => { external(); versions.delete(version); });
  const preview = vi.fn(async (s: ProgramMediaMultipartSession) => {
    await verify(s); return { token: 'fictional-preview-capability-' + s.objectVersion, until: new Date(Date.now() + 300000).toISOString() };
  });
  const store = { create, part, complete, parts, inventory, verify, preview, abort, removeVersion } satisfies AwsProgramMediaMultipartStore;
  const close = vi.fn(); seam.open.mockResolvedValue({ store, close });
  return { store, close, uploads, versions };
}
function fixture() {
  const provider = fictionalStore();
  const resolveContext = vi.fn(async (_signal: AbortSignal) => ({ ...context }));
  const credentialsForProgram = vi.fn(async (scope: { clinic: string; programId: string }, _signal: AbortSignal) => ({ storage, scope,
    expectedRoleArn: 'arn:aws:iam::588966314750:role/alp-educational-media-worker',
    credentials: { accessKeyId: 'ASIA' + 'A'.repeat(16), secretAccessKey: 'x'.repeat(40), sessionToken: 'fictional-only-session', expiration: new Date(Date.now() + 3600000) },
    forbiddenBuckets: ['alp-recording-store'], forbiddenKmsKeyArns: ['arn:aws:kms:us-east-2:588966314750:key/' + id(98)] } satisfies AwsProgramMediaStoreConfiguration));
  const inputs = { database, storage: { ...storage }, resolveContext, credentialsForProgram, activation: { ...activation }, policyReview: { ...policyReview } };
  const make = () => createProgramMediaMultipartRequestSource(inputs);
  const source = make();
  const run = (operation: string, request: Record<string, unknown>, bytes?: Uint8Array, signal = new AbortController().signal) => source.execute({ operation, request }, signal, bytes);
  return { ...provider, inputs, source, make, run, resolveContext, credentialsForProgram };
}
async function reserve(bytes = small, contentType: 'video/mp4' | 'video/webm' = 'video/mp4') {
  const artifactId = randomUUID(), sha256 = hash(bytes), manifest: ProgramMediaPartManifest = { totalBytes: bytes.length, parts: [] };
  for (let offset = 0; offset < bytes.length; offset += PROGRAM_MEDIA_PART_BYTES) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + PROGRAM_MEDIA_PART_BYTES));
    manifest.parts.push({ partNumber: manifest.parts.length + 1, bytes: part.length, sha256: hash(part) });
  }
  await createProgramMediaNativeLedger(database, { storage, evidenceSha256: activation.nativeEvidenceSha256 }).reserve(context, {
    artifactId, clinic: context.organizationId, programId, commandId: randomUUID(), kind: 'video', contentType, bytes: bytes.length, sha256,
    objectKey: `program-media/${context.organizationId}/${programId}/${artifactId}/${sha256}.${contentType === 'video/webm' ? 'webm' : 'mp4'}`,
    state: 'reserved', createdAt: new Date().toISOString(), acceptBefore: new Date(Date.now() + 900000).toISOString(), failure: null,
  });
  return { artifactId, manifest, bytes };
}
async function uploading(f: ReturnType<typeof fixture>, bytes = small) {
  const r = await reserve(bytes); await f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
  await f.run('create', { artifactId: r.artifactId, commandId: randomUUID() }); return r;
}
async function allParts(f: ReturnType<typeof fixture>, bytes = small) {
  const r = await uploading(f, bytes);
  for (const p of r.manifest.parts) await f.run('part', { artifactId: r.artifactId, partNumber: p.partNumber, commandId: randomUUID() }, bytes.subarray((p.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES, (p.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES + p.bytes));
  return r;
}
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  for (const m of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + m.file, 'utf8'));
  for (const [file, digest] of [
    ['program-media-ledger.sql', '6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d'],
    ['program-media-settlement.sql', '74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04'],
    ['program-media-native-ledger.sql', '69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7'],
    ['program-media-multipart.sql', 'a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092'],
  ]) { const sql = readFileSync('infra/aws-clinical-core/source-candidates/' + file, 'utf8').replace(/\r\n/g, '\n'); expect(hash(sql)).toBe(digest); await db.exec(sql); }
  await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional media request clinic')", [context.organizationId]);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [context.actorPersonId, 'syn_media_request_person']);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)", [context.actorPersonId, context.identitySubject]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [context.organizationId, context.actorPersonId]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Fictional educational course',$3)", [id(3), context.organizationId, context.actorPersonId]);
  database = { transaction: async work => {
    let currentOperation = '';
    const answer = await (async () => { try { return await db.transaction(async tx => {
      insideTransaction = true;
      try {
        await tx.exec('set local session authorization program_media_worker');
        expect((await tx.query('select current_user,session_user')).rows).toEqual([{ current_user: 'program_media_worker', session_user: 'program_media_worker' }]);
        return await work({ query: async (sql, parameters) => {
          if (sql.includes('program_media_request(') || sql.includes('program_media_multipart_request(')) {
            currentOperation = JSON.parse(String(parameters?.[0])).operation; operations.push(currentOperation);
            if (failBefore.delete(currentOperation)) throw new Error('fictional receipt persistence failure');
          }
          try { return await tx.query(sql, parameters?.map(p => typeof p === 'object' && p !== null && 'kind' in p && 'value' in p ? p.value : p) ?? []) as never; }
          catch (error) {
            // The fictional RDS transport shapes an actual PostgreSQL message
            // like Data API, then uses the unchanged production mapper.
            const shaped = error instanceof Error ? { name: 'DatabaseErrorException', message: error.message } : error;
            throw classifyDatabaseRejection(shaped) ?? error;
          }
        } });
      } finally { insideTransaction = false; }
    }); } finally {
      // PGlite keeps SET LOCAL session authorization after COMMIT and RESET
      // does not restore it (separately reproduced). Only this fictional
      // operator connection explicitly restores its original login for fixture
      // setup. Both users above are asserted reduced during every source call.
      await db.exec('set session authorization postgres');
    } })();
    if (failAfter.delete(currentOperation)) throw new Error('fictional reply lost after committed transaction');
    return answer;
  } };
}, 120000);
beforeEach(async () => {
  vi.clearAllMocks(); operations = []; failBefore = new Set(); failAfter = new Set(); insideTransaction = false;
  programId = randomUUID();
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Isolated fictional test course',$3)", [programId, context.organizationId, context.actorPersonId]);
  await db.query("update clinical_core.organization_memberships set status='active' where person_id=$1", [context.actorPersonId]);
  await db.query("update clinical_core.program_media_activation set enabled=true,evidence_sha256=$1,native_evidence_sha256=$1,reviewed_by='Fictional operator only',reviewed_at=clock_timestamp(),storage_bucket=$2,public_origin=$3,expected_bucket_owner=$4,region=$5,kms_key_arn=$6,max_image_bytes=$7,max_video_bytes=$8,multipart_enabled=true,multipart_evidence_sha256=$9",
    [activation.nativeEvidenceSha256, storage.bucket, storage.publicOrigin, storage.expectedBucketOwner, storage.region, storage.kmsKeyArn, storage.maxImageBytes, storage.maxVideoBytes, activation.multipartEvidenceSha256]);
});
afterAll(async () => { await db?.close(); });

describe('original-author multipart preview with the actual restricted ledger', () => {
  const source = (f: ReturnType<typeof fixture>) => createProgramMediaMultipartPreviewRequestSource(f.inputs);
  const command = (artifactId: string) => ({ operation: 'preview', request: { artifactId } });
  const preview = (f: ReturnType<typeof fixture>, artifactId: string) => source(f).execute(command(artifactId), new AbortController().signal);
  async function ready(f: ReturnType<typeof fixture>) {
    const r = await allParts(f); await f.run('complete', { artifactId: r.artifactId, commandId: randomUUID() }); return r;
  }
  it('is OFF by default before context, SQL or credentials', async () => {
    const f = fixture();
    await expect(createProgramMediaMultipartPreviewRequestSource({ ...f.inputs, activation: undefined }).execute(command(id(88)), new AbortController().signal))
      .rejects.toThrow('program_media_disabled');
    expect(operations).toEqual([]); expect(f.resolveContext).not.toHaveBeenCalled(); expect(f.credentialsForProgram).not.toHaveBeenCalled();
  });
  it('reads a committed artifact without mutation, then rechecks authority and closes the scoped store', async () => {
    const f = fixture(), r = await ready(f); operations = []; f.close.mockClear();
    const answer = await preview(f, r.artifactId);
    expect(answer).toMatchObject({ artifactId: r.artifactId, version: 2, state: 'ready', bytes: small.length, sha256: hash(small), historical: false });
    expect(operations).toEqual(['configuration', 'artifact', 'authorize', 'status', 'configuration', 'artifact', 'status']);
    expect(f.store.preview).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('renders through the metadata HTTP handler without exposing object/provider identities', async () => {
    const f = fixture(), r = await ready(f), handler = createProgramMediaControlHandler({ enabled: true, sourceForRequest: async () => source(f) });
    const response = await handler(new Request('https://desktop.example.test/api/live/programs/media/control', { method: 'POST',
      headers: { Origin: 'https://desktop.example.test', Host: 'desktop.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify(command(r.artifactId)) }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json(); expect(body.data.artifactId).toBe(r.artifactId);
    expect(body.data).not.toHaveProperty('objectKey'); expect(body.data).not.toHaveProperty('objectVersion'); expect(body.data).not.toHaveProperty('writerClaimId');
  });
  it('does not turn an unfinished video into a preview', async () => {
    const f = fixture(), r = await uploading(f); f.credentialsForProgram.mockClear(); seam.open.mockClear();
    await expect(preview(f, r.artifactId)).rejects.toThrow('not_ready'); expect(f.credentialsForProgram).not.toHaveBeenCalled(); expect(seam.open).not.toHaveBeenCalled();
  });
  it('labels a retired original-author version as historical without publishing it', async () => {
    const f = fixture(), r = await ready(f);
    await createProgramMediaNativeLedger(database, { storage, evidenceSha256: activation.nativeEvidenceSha256 }).retire(context, r.artifactId, 2, new Date().toISOString());
    const before = await db.query<{ count: number }>('select count(*)::integer as count from clinical_core.program_media_publications');
    operations = [];
    expect(await preview(f, r.artifactId)).toMatchObject({ artifactId: r.artifactId, state: 'retired', version: 3, historical: true });
    expect(operations).not.toContain('recordPublication');
    expect(await db.query('select count(*)::integer as count from clinical_core.program_media_publications')).toEqual(before);
  });
  it('rejects an ignored context deadline before SQL or credentials', async () => {
    const f = fixture(); f.resolveContext.mockImplementationOnce(() => new Promise(() => undefined));
    const short = createProgramMediaMultipartPreviewRequestSource({ ...f.inputs, timeoutMs: 5 });
    await expect(short.execute(command(id(88)), new AbortController().signal)).rejects.toThrow('service_unavailable');
    expect(operations).toEqual([]); expect(f.credentialsForProgram).not.toHaveBeenCalled();
  });
  it.each(['valid', 'changed writer', 'changed bytes'])('composes restricted SQL, actual SDK preview and HTTP with fictional transport: %s', async kind => {
    const f = fixture(), r = await ready(f);
    const multipart = createProgramMediaMultipartLedger(database, { storage, evidenceSha256: activation.nativeEvidenceSha256 },
      { enabled: true, evidenceSha256: activation.multipartEvidenceSha256 });
    const session = (await multipart.execute(context, { operation: 'status', parameters: { artifactId: r.artifactId } })).session;
    const stored = f.versions.get(session.objectVersion!)!;
    const bucketArn = `arn:aws:s3:::${storage.bucket}`, objects = bucketArn + '/*';
    const resourcePolicy = JSON.stringify({ Statement: [
      { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [bucketArn, objects], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      ...[['s3:x-amz-server-side-encryption', 'aws:kms'], ['s3:x-amz-server-side-encryption-aws-kms-key-id', storage.kmsKeyArn]]
        .map(([key, value]) => ({ Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: objects,
          Condition: { StringNotEquals: { [key]: value }, Null: { [key]: 'false' } } })),
      { Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: objects,
        Condition: { StringNotEquals: { 's3:if-none-match': '*' }, Bool: { 's3:ObjectCreationOperation': 'true' } } },
    ] });
    const object = { VersionId: session.objectVersion!, ContentLength: stored.bytes.length, ContentType: session.contentType,
      ChecksumType: 'COMPOSITE', ChecksumSHA256: session.checksum, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: storage.kmsKeyArn,
      Metadata: { 'artifact-id': session.artifactId, 'program-id': session.programId, clinic: session.clinic,
        purpose: 'educational_media', 'writer-claim-id': kind === 'changed writer' ? id(88) : session.writerClaimId, 'whole-sha256': session.sha256 } };
    const commands: string[] = [];
    const s3 = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      expect(insideTransaction).toBe(false); commands.push(command.constructor.name);
      expect(command.input.Bucket).toBe(storage.bucket); expect(command.input.ExpectedBucketOwner).toBe('588966314750');
      switch (command.constructor.name) {
        case 'GetBucketVersioningCommand': return { Status: 'Enabled' };
        case 'GetBucketEncryptionCommand': return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault:
          { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: storage.kmsKeyArn } }] } };
        case 'GetPublicAccessBlockCommand': return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
        case 'GetBucketOwnershipControlsCommand': return { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } };
        case 'GetBucketTaggingCommand': return { TagSet: [['alp:purpose', 'educational_media'], ['alp:classification', 'synthetic_only'], ['alp:phi-allowed', 'false'], ['alp:dedicated', 'true']].map(([Key, Value]) => ({ Key, Value })) };
        case 'GetBucketPolicyCommand': return { Policy: resourcePolicy };
        case 'HeadObjectCommand':
        case 'GetObjectCommand': {
          expect(command.input.Key).toBe(session.objectKey); expect(command.input.VersionId).toBe(session.objectVersion);
          return command.constructor.name === 'HeadObjectCommand' ? object : { ...object,
            Body: Readable.from([kind === 'changed bytes' ? new Uint8Array(stored.bytes.length).fill(9) : stored.bytes]) };
        }
        default: throw new Error('Unexpected fictional provider command; network is never used');
      }
    }) as never);
    const sts = vi.spyOn(STSClient.prototype, 'send').mockImplementation((async () => {
      expect(insideTransaction).toBe(false);
      return { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/alp-educational-media-worker/fictional-preview' };
    }) as never);
    try {
      const actual = await vi.importActual<typeof import('./aws-program-media-multipart-store')>('./aws-program-media-multipart-store');
      seam.open.mockImplementationOnce(actual.createAwsProgramMediaMultipartStoreSource);
      const nativeSource = createProgramMediaMultipartPreviewRequestSource({ ...f.inputs,
        policyReview: { ...policyReview, policySha256: hash(resourcePolicy) } });
      const handler = createProgramMediaControlHandler({ enabled: true, sourceForRequest: async () => nativeSource });
      const response = await handler(new Request('https://desktop.example.test/api/live/programs/media/control', { method: 'POST',
        headers: { Origin: 'https://desktop.example.test', Host: 'desktop.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify(command(r.artifactId)) }));
      const body = await response.json();
      if (kind !== 'valid') { expect(response.status).toBe(503); expect(body).not.toHaveProperty('data'); }
      else {
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
        const capability = new URL(body.data.previewToken);
        expect(body.data.previewToken.length).toBeGreaterThan(512);
        expect(capability.hostname).toBe(storage.bucket + '.s3.us-east-2.amazonaws.com');
        expect(capability.searchParams.get('versionId')).toBe(session.objectVersion);
        expect(capability.searchParams.get('X-Amz-Expires')).toBe('300');
        expect(body.data).not.toHaveProperty('objectKey'); expect(body.data).not.toHaveProperty('writerClaimId');
      }
      expect(commands.filter(name => /Upload|Put|Delete|Abort|Complete/.test(name))).toEqual([]);
    } finally { s3.mockRestore(); sts.mockRestore(); }
  });
  it.each(['membership', 'release', 'identity', 'artifact version'])('discards a late preview after %s changes', async kind => {
    const f = fixture(), r = await ready(f); f.close.mockClear();
    f.store.preview.mockImplementationOnce(async s => {
      if (kind === 'membership') await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [context.actorPersonId]);
      if (kind === 'release') await db.query('update clinical_core.program_media_activation set multipart_enabled=false');
      if (kind === 'identity') f.resolveContext.mockResolvedValueOnce({ ...context, identitySubject: 'syn_different_author' });
      if (kind === 'artifact version') await createProgramMediaNativeLedger(database, { storage, evidenceSha256: activation.nativeEvidenceSha256 })
        .attachText(context, r.artifactId, 2, 'caption', { text: 'Supplied fictional caption', source: 'supplied_by_author', format: 'plain', sha256: hash('Supplied fictional caption') });
      return { token: 'fictional-preview-' + s.objectVersion, until: new Date(Date.now() + 300000).toISOString() };
    });
    await expect(preview(f, r.artifactId)).rejects.toThrow(kind === 'artifact version' ? 'conflict' : kind === 'release' ? 'program_media_disabled' : 'access_refused');
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses a cross-program credential before opening the store', async () => {
    const f = fixture(), r = await ready(f); seam.open.mockClear(); f.store.preview.mockClear();
    const actual = f.credentialsForProgram.getMockImplementation()!;
    f.credentialsForProgram.mockImplementationOnce(async (scope, signal) => ({ ...await actual(scope, signal), scope: { ...scope, programId: id(88) } }));
    await expect(preview(f, r.artifactId)).rejects.toThrow('storage_unverified'); expect(seam.open).not.toHaveBeenCalled(); expect(f.store.preview).not.toHaveBeenCalled();
  });
  it('rejects internal provider/proof fields before context resolution', async () => {
    const f = fixture();
    await expect(source(f).execute({ operation: 'preview', request: { artifactId: id(88), objectVersion: 'forged', proof: {} } }, new AbortController().signal))
      .rejects.toThrow('request_invalid'); expect(f.resolveContext).not.toHaveBeenCalled();
  });
  it('closes a preview that returns a deadline beyond the five-minute cap', async () => {
    const f = fixture(), r = await ready(f); f.close.mockClear();
    f.store.preview.mockResolvedValueOnce({ token: 'fictional-preview-capability', until: new Date(Date.now() + 3600000).toISOString() });
    await expect(preview(f, r.artifactId)).rejects.toThrow('service_unavailable'); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('stops an ignored preview await on withdrawal and closes the resource', async () => {
    const f = fixture(), r = await ready(f), stop = new AbortController(); f.close.mockClear();
    f.store.preview.mockImplementationOnce(async () => { stop.abort(); return new Promise(() => undefined); });
    await expect(source(f).execute(command(r.artifactId), stop.signal)).rejects.toThrow('access_refused'); expect(f.close).toHaveBeenCalledTimes(1);
  });
});

describe('native multipart request composition with restricted SQL and fictional provider bytes', () => {
  it('is OFF by default and refuses invalid activation or policy before any authority or secret read', async () => {
    const f = fixture(), command = { operation: 'status', request: { artifactId: randomUUID() } };
    for (const inputs of [{ ...f.inputs, activation: undefined }, { ...f.inputs, activation: { ...activation, enabled: false } }])
      await expect(createProgramMediaMultipartRequestSource(inputs).execute(command, new AbortController().signal)).rejects.toThrow('program_media_disabled');
    for (const inputs of [{ ...f.inputs, policyReview: undefined }, { ...f.inputs, activation: { ...activation, nativeEvidenceSha256: '' } }])
      await expect(createProgramMediaMultipartRequestSource(inputs).execute(command, new AbortController().signal)).rejects.toThrow('storage_unverified');
    expect(f.resolveContext).not.toHaveBeenCalled(); expect(operations).toEqual([]); expect(seam.open).not.toHaveBeenCalled();
  });
  it.each(['recordPart', 'recordUpload', 'recordCompletion', 'commit', 'certifyAbort', 'admitPart', 'settleAttempt'])('refuses client proof command %s', async operation => {
    const f = fixture(); await expect(f.run(operation, { artifactId: randomUUID(), proof: {}, claimId: randomUUID() })).rejects.toThrow('request_invalid');
    expect(f.resolveContext).not.toHaveBeenCalled(); expect(operations).toEqual([]);
  });
  it.each([{ context }, { storage }, { activation }, { evidenceSha256: 'a'.repeat(64) }, { uploadId: 'forged' }])('refuses caller authority fields %j', async extra => {
    const f = fixture(); await expect(f.source.execute({ operation: 'status', request: { artifactId: randomUUID() }, ...extra }, new AbortController().signal)).rejects.toThrow('request_invalid');
    expect(f.resolveContext).not.toHaveBeenCalled();
  });
  it('keeps status, start and cancellation database-only and excludes provider and private attempt identities from replies', async () => {
    const f = fixture(), r = await reserve(small, 'video/webm'); operations = [];
    const result = await f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
    expect(result).toMatchObject({ artifactId: r.artifactId, state: 'prepared', contentType: 'video/webm', pendingWork: false });
    expect(await f.run('status', { artifactId: r.artifactId })).toEqual(result);
    expect(await f.run('cancel', { artifactId: r.artifactId })).toMatchObject({ state: 'abort_requested' });
    expect(f.credentialsForProgram).not.toHaveBeenCalled(); expect(seam.open).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/writerClaimId|claimId|actorId|clinic|objectKey|uploadId|objectVersion|evidence|secret/);
  });
  it('captures dependency functions, input values and Node Buffer bytes before asynchronous authentication', async () => {
    const f = fixture(), r = await uploading(f), bytes = Buffer.from(small), command = { operation: 'part', request: { artifactId: r.artifactId, commandId: randomUUID(), partNumber: 1 } };
    f.resolveContext.mockImplementationOnce(async () => {
      f.inputs.resolveContext = vi.fn(async () => ({ ...context, actorPersonId: id(88) }));
      f.inputs.credentialsForProgram = vi.fn(async () => { throw new Error('changed dependency'); });
      f.inputs.activation.nativeEvidenceSha256 = 'f'.repeat(64); f.inputs.policyReview.policySha256 = 'f'.repeat(64); f.inputs.storage.bucket = 'changed-lessons';
      command.request.artifactId = randomUUID(); bytes.fill(0); return { ...context };
    });
    expect(await f.source.execute(command, new AbortController().signal, bytes)).toMatchObject({ artifactId: r.artifactId, receivedParts: [1], pendingWork: false });
    expect(f.store.part.mock.calls[0][2]).toEqual(small);
  });
  it('requires current release, storage, membership and consumer isolation before credentials', async () => {
    const f = fixture(), r = await reserve();
    await db.exec('update clinical_core.program_media_activation set multipart_enabled=false');
    await expect(f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() })).rejects.toThrow('program_media_disabled');
    await db.exec('update clinical_core.program_media_activation set multipart_enabled=true');
    f.resolveContext.mockResolvedValueOnce({ ...context, identityPool: 'consumer' });
    await expect(f.run('status', { artifactId: r.artifactId })).rejects.toThrow('access_refused');
    await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [context.actorPersonId]);
    await expect(f.run('status', { artifactId: r.artifactId })).rejects.toThrow('access_refused');
    expect(f.credentialsForProgram).not.toHaveBeenCalled();
  });
  it('refuses a substituted program scope or store before the provider write and settles only the unsent attempt', async () => {
    const f = fixture(), r = await reserve();
    await f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
    const original = f.credentialsForProgram.getMockImplementation()!;
    for (const field of ['scope', 'storage'] as const) {
      f.credentialsForProgram.mockImplementationOnce(async (...args) => {
        const credentials = await original(...args);
        return field === 'scope' ? { ...credentials, scope: { ...credentials.scope, programId: id(88) } }
          : { ...credentials, storage: { ...credentials.storage, bucket: 'different-educational-store' } };
      });
      await expect(f.run('create', { artifactId: r.artifactId, commandId: randomUUID() })).rejects.toThrow('storage_unverified');
      expect(await f.run('status', { artifactId: r.artifactId })).toMatchObject({ state: 'prepared', pendingWork: false });
    }
    expect(seam.open).not.toHaveBeenCalled(); expect(f.store.create).not.toHaveBeenCalled();
    expect((await db.query("select outcome from clinical_private.program_media_multipart_attempts where artifact_id=$1 order by started_at", [r.artifactId])).rows)
      .toEqual([{ outcome: 'not_sent' }, { outcome: 'not_sent' }]);
  });
  it('refuses creation, part and completion admitted after cancellation without any new provider mutation', async () => {
    const f = fixture(), r = await uploading(f);
    await f.run('cancel', { artifactId: r.artifactId });
    for (const operation of ['create', 'part', 'complete']) {
      await expect(f.run(operation, { artifactId: r.artifactId, commandId: randomUUID(), ...(operation === 'part' ? { partNumber: 1 } : {}) },
        operation === 'part' ? small : undefined)).rejects.toThrow('conflict');
    }
    expect(f.store.create).toHaveBeenCalledOnce(); expect(f.store.part).not.toHaveBeenCalled(); expect(f.store.complete).not.toHaveBeenCalled();
    expect(await f.run('status', { artifactId: r.artifactId })).toMatchObject({ state: 'abort_requested', pendingWork: false });
  });
  it('creates, receives measured parts, verifies whole bytes and commits exactly once across fresh request sources', async () => {
    const f = fixture(), bytes = new Uint8Array(PROGRAM_MEDIA_PART_BYTES + 3).fill(19), r = await allParts(f, bytes), commandId = randomUUID();
    const result = await f.run('complete', { artifactId: r.artifactId, commandId });
    expect(result).toMatchObject({ state: 'committed', pendingWork: false, receivedParts: [1, 2], sha256: hash(bytes) });
    const restarted = f.make();
    expect(await restarted.execute({ operation: 'complete', request: { artifactId: r.artifactId, commandId } }, new AbortController().signal)).toEqual(result);
    expect(f.store.create).toHaveBeenCalledOnce(); expect(f.store.complete).toHaveBeenCalledOnce(); expect(f.store.verify).toHaveBeenCalledOnce();
    expect((await db.query("select count(*)::int as count from clinical_core.program_media_events where artifact_id=$1 and event='committed'", [r.artifactId])).rows).toEqual([{ count: 1 }]);
  });
  it('executes the real metadata and 8 MiB binary HTTP flow through SQL admission and fictional byte verification', async () => {
    const f = fixture(), bytes = new Uint8Array(PROGRAM_MEDIA_PART_BYTES + 3).fill(11), r = await reserve(bytes);
    const handler = createProgramMediaMultipartHandler({ enabled: true, sourceForRequest: async () => f.source });
    async function metadata(operation: string, request: Record<string, unknown>) {
      const response = await handler(new Request('https://desktop.example.test/api/live/programs/media/multipart/control', {
        method: 'POST', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ operation, request }),
      })); expect(response.status).toBe(200); return response.json() as Promise<{ data: { state: string } }>;
    }
    await metadata('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
    await metadata('create', { artifactId: r.artifactId, commandId: randomUUID() });
    for (const p of r.manifest.parts) {
      const body = bytes.subarray((p.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES, (p.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES + p.bytes);
      const response = await handler(new Request(`https://desktop.example.test/api/live/programs/media/multipart/part/${r.artifactId}/${p.partNumber}/${randomUUID()}`, {
        method: 'PUT', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/octet-stream', 'x-alp-part-sha256': p.sha256 }, body: Buffer.from(body),
      })); expect(response.status).toBe(200);
    }
    expect(await metadata('complete', { artifactId: r.artifactId, commandId: randomUUID() })).toMatchObject({ data: { state: 'committed' } });
    expect(f.store.part.mock.calls.map(c => c[2].length)).toEqual([PROGRAM_MEDIA_PART_BYTES, 3]);
    expect(f.resolveContext.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
  it('rechecks current database authority after the binary body is read and before any write admission', async () => {
    const f = fixture(), r = await uploading(f), handler = createProgramMediaMultipartHandler({ enabled: true, sourceForRequest: async () => f.source });
    const body = new ReadableStream<Uint8Array>({ async pull(c) {
      await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [context.actorPersonId]);
      c.enqueue(small); c.close();
    } }, { highWaterMark: 0 });
    const response = await handler(new Request(`https://desktop.example.test/api/live/programs/media/multipart/part/${r.artifactId}/1/${randomUUID()}`, {
      method: 'PUT', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/octet-stream', 'x-alp-part-sha256': hash(small) },
      body, duplex: 'half',
    } as RequestInit));
    expect(response.status).toBe(403); expect(f.store.part).not.toHaveBeenCalled();
    expect((await db.query("select count(*)::int as count from clinical_private.program_media_multipart_attempts where artifact_id=$1 and kind='part'", [r.artifactId])).rows)
      .toEqual([{ count: 0 }]);
  });
  it('refuses wrong bytes before admitting a writer or reading credentials', async () => {
    const f = fixture(), r = await uploading(f); f.credentialsForProgram.mockClear(); operations = [];
    await expect(f.run('part', { artifactId: r.artifactId, commandId: randomUUID(), partNumber: 1 }, new Uint8Array(small.length))).rejects.toThrow('request_invalid');
    expect(operations).not.toContain('admitPart'); expect(f.credentialsForProgram).not.toHaveBeenCalled();
  });
  it('persists a definite pre-send failure and permits a separately admitted attempt, never the old key', async () => {
    const f = fixture(), r = await reserve(), commandId = randomUUID();
    await f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
    seam.open.mockRejectedValueOnce(new ProgramMediaError('storage_unverified'));
    await expect(f.run('create', { artifactId: r.artifactId, commandId })).rejects.toThrow('storage_unverified');
    expect(await f.run('create', { artifactId: r.artifactId, commandId })).toMatchObject({ state: 'prepared', pendingWork: false });
    expect(await f.run('create', { artifactId: r.artifactId, commandId: randomUUID() })).toMatchObject({ state: 'uploading' });
    expect(f.store.create).toHaveBeenCalledOnce();
  });
  it('holds an unknown creation without adopting a listed upload or issuing another creation on restart', async () => {
    const f = fixture(), r = await reserve(), commandId = randomUUID(), create = f.store.create.getMockImplementation()!;
    await f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
    f.store.create.mockImplementationOnce(async a => { await create(a); throw new ProgramMediaWriteError(false); });
    await expect(f.run('create', { artifactId: r.artifactId, commandId })).rejects.toThrow('service_unavailable');
    const restarted = f.make();
    expect(await restarted.execute({ operation: 'create', request: { artifactId: r.artifactId, commandId } }, new AbortController().signal)).toMatchObject({ state: 'creation_admitted', pendingWork: true });
    expect(await f.run('reconcile', { artifactId: r.artifactId })).toMatchObject({ state: 'creation_admitted', pendingWork: true });
    await expect(f.run('create', { artifactId: r.artifactId, commandId: randomUUID() })).rejects.toThrow('conflict');
    await f.run('cancel', { artifactId: r.artifactId });
    expect(await f.run('cleanup', { artifactId: r.artifactId })).toMatchObject({ pendingWork: true });
    expect(f.store.create).toHaveBeenCalledOnce(); expect(f.store.inventory).not.toHaveBeenCalled(); expect(f.store.abort).not.toHaveBeenCalled();
  });
  it.each(['before', 'after'])('recovers a part when its database receipt reply fails %s commit without resending bytes', async failure => {
    const f = fixture(), r = await uploading(f), commandId = randomUUID();
    (failure === 'before' ? failBefore : failAfter).add('recordPart');
    await expect(f.run('part', { artifactId: r.artifactId, commandId, partNumber: 1 }, small)).rejects.toThrow('service_unavailable');
    expect(await f.run('reconcile', { artifactId: r.artifactId })).toMatchObject({ receivedParts: [1], pendingWork: false });
    expect(await f.run('part', { artifactId: r.artifactId, commandId, partNumber: 1 }, small)).toMatchObject({ receivedParts: [1] });
    expect(f.store.part).toHaveBeenCalledOnce();
  });
  it('reconciles completion from one measured exact version after a lost receipt and refuses an ambiguous inventory', async () => {
    const f = fixture(), r = await allParts(f), commandId = randomUUID(); failBefore.add('recordCompletion');
    await expect(f.run('complete', { artifactId: r.artifactId, commandId })).rejects.toThrow('service_unavailable');
    f.store.inventory.mockResolvedValueOnce({ complete: true, checkedAt: new Date().toISOString(), uploads: [], versions: [
      { objectVersion: 'fictional-one', deleteMarker: false, bytes: small.length }, { objectVersion: 'fictional-two', deleteMarker: false, bytes: small.length },
    ] });
    expect(await f.run('reconcile', { artifactId: r.artifactId })).toMatchObject({ state: 'completion_admitted', pendingWork: true });
    expect(f.store.verify).not.toHaveBeenCalled();
    expect(await f.run('reconcile', { artifactId: r.artifactId })).toMatchObject({ state: 'committed', pendingWork: false });
    expect(f.store.complete).toHaveBeenCalledOnce(); expect(f.store.verify).toHaveBeenCalledOnce();
  });
  it('never commits substituted whole bytes or a fabricated writer when completion is reconciled', async () => {
    const f = fixture(), r = await allParts(f); failBefore.add('recordCompletion');
    await expect(f.run('complete', { artifactId: r.artifactId, commandId: randomUUID() })).rejects.toThrow();
    const stored = [...f.versions.values()][0]; stored.bytes[0] ^= 1;
    await expect(f.run('reconcile', { artifactId: r.artifactId })).rejects.toThrow('storage_unverified');
    expect((await db.query('select state from clinical_core.program_media_artifacts where id=$1', [r.artifactId])).rows).toEqual([{ state: 'reserved' }]);
    stored.bytes[0] ^= 1; stored.session.writerClaimId = randomUUID();
    await expect(f.run('reconcile', { artifactId: r.artifactId })).rejects.toThrow('storage_unverified');
  });
  it('retries measured verification after a failure without completing the provider upload again', async () => {
    const f = fixture(), r = await allParts(f); f.store.verify.mockRejectedValueOnce(new ProgramMediaError('service_unavailable'));
    await expect(f.run('complete', { artifactId: r.artifactId, commandId: randomUUID() })).rejects.toThrow('service_unavailable');
    expect(await f.run('status', { artifactId: r.artifactId })).toMatchObject({ state: 'verifying', pendingWork: false });
    expect((await db.query('select state,outcome from clinical_private.program_media_multipart_attempts where artifact_id=$1 order by kind', [r.artifactId])).rows)
      .toEqual([{ state: 'settled', outcome: 'receipt' }, { state: 'settled', outcome: 'receipt' }, { state: 'settled', outcome: 'receipt' }]);
    expect(await f.run('reconcile', { artifactId: r.artifactId })).toMatchObject({ state: 'committed', pendingWork: false });
    expect(f.store.complete).toHaveBeenCalledOnce(); expect(operations.filter(o => o === 'settleAttempt')).toEqual([]);
  });
  it('preserves the duplicate committed-bytes guard within one course', async () => {
    const f = fixture(), first = await allParts(f);
    expect(await f.run('complete', { artifactId: first.artifactId, commandId: randomUUID() })).toMatchObject({ state: 'committed' });
    const duplicate = await allParts(f);
    await expect(f.run('complete', { artifactId: duplicate.artifactId, commandId: randomUUID() })).rejects.toThrow('conflict');
    expect((await db.query("select count(*)::int as count from clinical_core.program_media_artifacts where program_id=$1 and state='ready'", [programId])).rows).toEqual([{ count: 1 }]);
    expect(await f.run('status', { artifactId: duplicate.artifactId })).toMatchObject({ state: 'verifying', pendingWork: false });
  });
  it('rechecks authority after provider work and leaves the original writer pending when membership was withdrawn', async () => {
    const f = fixture(), r = await uploading(f), part = f.store.part.getMockImplementation()!;
    f.store.part.mockImplementationOnce(async (...args) => {
      const receipt = await part(...args); await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [context.actorPersonId]); return receipt;
    });
    await expect(f.run('part', { artifactId: r.artifactId, partNumber: 1, commandId: randomUUID() }, small)).rejects.toThrow('access_refused');
    expect((await db.query("select state from clinical_private.program_media_multipart_attempts where artifact_id=$1 and kind='part'", [r.artifactId])).rows).toEqual([{ state: 'open' }]);
    await db.query("update clinical_core.organization_memberships set status='active' where person_id=$1", [context.actorPersonId]);
    expect(await f.run('reconcile', { artifactId: r.artifactId })).toMatchObject({ pendingWork: false, receivedParts: [1] });
    expect(f.store.part).toHaveBeenCalledOnce(); expect(f.store.removeVersion).not.toHaveBeenCalled();
  });
  it.each(['part', 'completion'])('retains late %s work through cancellation, refuses early cleanup, then removes only after receipt settlement', async kind => {
    const f = fixture(), r = kind === 'part' ? await uploading(f) : await allParts(f);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), admission = new Promise<void>(resolve => { entered = resolve; });
    if (kind === 'part') { const original = f.store.part.getMockImplementation()!; f.store.part.mockImplementationOnce(async (...args) => { const receipt = await original(...args); entered(); await waiting; return receipt; }); }
    else { const original = f.store.complete.getMockImplementation()!; f.store.complete.mockImplementationOnce(async (...args) => { const receipt = await original(...args); entered(); await waiting; return receipt; }); }
    const pending = f.run(kind === 'part' ? 'part' : 'complete', { artifactId: r.artifactId, commandId: randomUUID(), ...(kind === 'part' ? { partNumber: 1 } : {}) }, kind === 'part' ? small : undefined);
    await admission; await f.run('cancel', { artifactId: r.artifactId });
    expect(await f.run('cleanup', { artifactId: r.artifactId })).toMatchObject({ state: 'abort_requested', pendingWork: true });
    expect(f.store.abort).not.toHaveBeenCalled(); expect(f.store.removeVersion).not.toHaveBeenCalled();
    release(); expect(await pending).toMatchObject({ state: 'abort_requested', pendingWork: false });
    expect(await f.run('cleanup', { artifactId: r.artifactId })).toMatchObject({ state: 'aborted', pendingWork: false });
    expect(f.store.verify).not.toHaveBeenCalled(); expect(f.uploads.size).toBe(0); expect(f.versions.size).toBe(0);
  });
  it('refuses creation after cancel and never certifies an incomplete inventory or a failed deletion', async () => {
    const f = fixture(), r = await uploading(f); await f.run('cancel', { artifactId: r.artifactId });
    await expect(f.run('create', { artifactId: r.artifactId, commandId: randomUUID() })).rejects.toThrow('conflict');
    f.store.inventory.mockResolvedValueOnce({ complete: false, checkedAt: new Date().toISOString(), uploads: [], versions: [] });
    await expect(f.run('cleanup', { artifactId: r.artifactId })).rejects.toThrow('service_unavailable');
    f.store.abort.mockRejectedValueOnce(new Error('private denied deletion detail'));
    await expect(f.run('cleanup', { artifactId: r.artifactId })).rejects.toThrow(/^service_unavailable$/);
    expect(operations).not.toContain('certifyAbort');
    expect(await f.run('cleanup', { artifactId: r.artifactId })).toMatchObject({ state: 'aborted' });
  });
  it('terminates ignored authentication, credentials and late-open waits at withdrawal without starting a provider mutation', async () => {
    const f = fixture(), r = await reserve();
    f.resolveContext.mockImplementationOnce(async () => new Promise<never>(() => undefined));
    const controller = new AbortController(), waiting = f.run('status', { artifactId: r.artifactId }, undefined, controller.signal); controller.abort();
    await expect(waiting).rejects.toThrow('access_refused');
    await f.run('start', { artifactId: r.artifactId, manifest: r.manifest, commandId: randomUUID() });
    let resolve!: (value: { store: AwsProgramMediaMultipartStore; close: ReturnType<typeof vi.fn> }) => void;
    seam.open.mockImplementationOnce(async () => new Promise(value => { resolve = value; }));
    const stopped = new AbortController(), pending = f.run('create', { artifactId: r.artifactId, commandId: randomUUID() }, undefined, stopped.signal);
    await vi.waitUntil(() => typeof resolve === 'function'); stopped.abort(); await expect(pending).rejects.toThrow('access_refused');
    const lateClose = vi.fn(); resolve({ store: f.store, close: lateClose }); await vi.waitUntil(() => lateClose.mock.calls.length === 1);
    expect(f.store.create).not.toHaveBeenCalled();
    expect(await f.run('status', { artifactId: r.artifactId })).toMatchObject({ pendingWork: true });
  });
  it('enforces one deadline through authority resolution without treating a timeout as settlement', async () => {
    const f = fixture(); f.resolveContext.mockImplementationOnce(async () => new Promise<never>(() => undefined));
    const source = createProgramMediaMultipartRequestSource({ ...f.inputs, timeoutMs: 10 });
    await expect(source.execute({ operation: 'status', request: { artifactId: randomUUID() } }, new AbortController().signal)).rejects.toThrow('service_unavailable');
    expect(operations).toEqual([]); expect(seam.open).not.toHaveBeenCalled();
  });
});
