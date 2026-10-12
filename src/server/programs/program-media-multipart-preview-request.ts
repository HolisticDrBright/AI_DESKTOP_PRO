if (typeof window !== 'undefined') throw new Error('program media multipart preview is server-only');
import { z } from 'zod';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { programMediaReadRequest, programMediaPreview, programMediaStorageSchema, type ProgramMediaStorage } from '@/contracts/programMedia';
import { createProgramMediaNativeLedger } from './program-media-native-ledger';
import { createProgramMediaMultipartLedger } from './program-media-multipart-ledger';
import { createAwsProgramMediaMultipartStoreSource } from './aws-program-media-multipart-store';
import type { AwsProgramMediaStoreConfiguration, ProgramMediaMultipartPolicyReview } from './aws-program-media-store';
import { ProgramMediaError } from './program-media-authoring';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commandSchema = z.object({ operation: z.literal('preview'), request: programMediaReadRequest }).strict();
const activationSchema = z.object({ enabled: z.literal(true), nativeEvidenceSha256: digest, multipartEvidenceSha256: digest }).strict();
const policySchema = z.object({ contract: z.literal('program-media-multipart-resource-review/1'), policySha256: digest, evidenceSha256: digest }).strict();
const storageIdentity = (s: ProgramMediaStorage) => JSON.stringify([s.purpose, s.phiAllowed, s.dedicated, s.bucket, s.expectedBucketOwner,
  s.region, s.kmsKeyArn, s.maxImageBytes, s.maxVideoBytes, s.publicOrigin]);
const actorIdentity = (c: ClinicalRequestContext) => JSON.stringify([c.actorPersonId, c.organizationId, c.identityPool, c.identitySubject,
  c.purpose, c.environment, c.dataClassification, c.containsPhi, c.realPatientData]);

/** OFF-by-default original-author read composition for the existing metadata
 * preview handler. The host must verify current workforce MFA; no native host,
 * credential or release is invented here. This does not authorize team/learner
 * delivery and it admits no mutation, settlement, cleanup or publication.
 * Each SQL call is short, outside S3 reads. Recheck authority after signing so a
 * withdrawn actor cannot receive the capability from a late response. */
export function createProgramMediaMultipartPreviewRequestSource(input: {
  database: ClinicalCoreDatabase; storage: ProgramMediaStorage;
  resolveContext(signal: AbortSignal): Promise<ClinicalRequestContext>;
  credentialsForProgram(scope: { clinic: string; programId: string }, signal: AbortSignal): Promise<AwsProgramMediaStoreConfiguration>;
  activation?: { enabled: boolean; nativeEvidenceSha256: string; multipartEvidenceSha256: string };
  policyReview?: ProgramMediaMultipartPolicyReview; timeoutMs?: number;
}) {
  const database: ClinicalCoreDatabase = { transaction: input.database.transaction.bind(input.database) };
  const resolveContext = input.resolveContext, credentialsForProgram = input.credentialsForProgram;
  const storage = Object.freeze(programMediaStorageSchema.parse(input.storage)), activation = activationSchema.safeParse(input.activation);
  const policy = policySchema.safeParse(input.policyReview), enabled = input.activation?.enabled === true, timeoutMs = input.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ProgramMediaError('request_invalid');
  const release = activation.success ? { storage, evidenceSha256: activation.data.nativeEvidenceSha256 } : undefined;
  const native = createProgramMediaNativeLedger(database, release), multipart = createProgramMediaMultipartLedger(database, release,
    activation.success ? { enabled: true, evidenceSha256: activation.data.multipartEvidenceSha256 } : undefined);
  return Object.freeze({ async execute(value: unknown, requestSignal: AbortSignal) {
    if (!enabled) throw new ProgramMediaError('program_media_disabled');
    if (!activation.success || !policy.success) throw new ProgramMediaError('storage_unverified');
    const parsed = commandSchema.safeParse(value);
    if (!parsed.success) throw new ProgramMediaError('request_invalid');
    if (!(requestSignal instanceof AbortSignal) || requestSignal.aborted) throw new ProgramMediaError('access_refused');
    const request = structuredClone(parsed.data.request), deadline = new AbortController(), signal = AbortSignal.any([requestSignal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    let opened: Awaited<ReturnType<typeof createAwsProgramMediaMultipartStoreSource>> | undefined;
    const live = () => { if (requestSignal.aborted) throw new ProgramMediaError('access_refused');
      if (signal.aborted) throw new ProgramMediaError('service_unavailable'); };
    async function wait<T>(work: Promise<T>, discard?: (late: T) => void) {
      const observed = work.then(value => { if (signal.aborted) discard?.(value); live(); return value; });
      if (signal.aborted) { void observed.catch(() => undefined); live(); }
      let stop: (() => void) | undefined;
      try { return await Promise.race([observed, new Promise<never>((_resolve, reject) => {
        stop = () => { try { live(); } catch (error) { reject(error); } };
        signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      })]); } finally { if (stop) signal.removeEventListener('abort', stop); }
    }
    try {
      live(); const context = Object.freeze({ ...await wait(resolveContext(signal)) });
      const configuration = await wait(native.configuration(context));
      if (configuration.evidenceSha256 !== activation.data.nativeEvidenceSha256 || storageIdentity(configuration.storage) !== storageIdentity(storage))
        throw new ProgramMediaError('storage_unverified');
      const artifact = await wait(native.artifact(context, request.artifactId));
      if (!artifact) throw new ProgramMediaError('not_found');
      if (artifact.kind !== 'video' || !['ready', 'retired'].includes(artifact.state)) throw new ProgramMediaError('not_ready');
      if (!await wait(native.authorize(context, artifact.programId))) throw new ProgramMediaError('access_refused');
      const session = (await wait(multipart.execute(context, { operation: 'status', parameters: { artifactId: artifact.artifactId } }))).session;
      if (session.state !== 'committed' || session.objectVersion !== artifact.objectVersion || session.sha256 !== artifact.sha256
        || session.totalBytes !== artifact.bytes || session.programId !== artifact.programId || session.objectKey !== artifact.objectKey)
        throw new ProgramMediaError('not_ready');
      const scope = Object.freeze({ clinic: context.organizationId, programId: artifact.programId });
      const credentials = structuredClone(await wait(credentialsForProgram(scope, signal)));
      if (credentials.scope.clinic !== scope.clinic || credentials.scope.programId !== scope.programId || storageIdentity(credentials.storage) !== storageIdentity(storage))
        throw new ProgramMediaError('storage_unverified');
      opened = await wait(createAwsProgramMediaMultipartStoreSource(credentials, signal, policy.data, context.actorPersonId), late => late.close());
      const handle = await wait(opened.store.preview(session, artifact, signal));
      const current = Object.freeze({ ...await wait(resolveContext(signal)) });
      if (actorIdentity(current) !== actorIdentity(context)) throw new ProgramMediaError('access_refused');
      // Both release and original-author checks are re-read, not cached claims.
      const currentConfiguration = await wait(native.configuration(current));
      if (currentConfiguration.evidenceSha256 !== activation.data.nativeEvidenceSha256 || storageIdentity(currentConfiguration.storage) !== storageIdentity(storage))
        throw new ProgramMediaError('storage_unverified');
      const after = await wait(native.artifact(current, artifact.artifactId));
      if (!after || JSON.stringify(after) !== JSON.stringify(artifact)) throw new ProgramMediaError('conflict');
      await wait(multipart.execute(current, { operation: 'status', parameters: { artifactId: artifact.artifactId } })); live();
      if (Date.parse(handle.until) <= Date.now() || Date.parse(handle.until) > Date.now() + 300000) throw new ProgramMediaError('service_unavailable');
      return programMediaPreview.parse({ artifactId: artifact.artifactId, version: artifact.version, state: artifact.state, kind: artifact.kind,
        contentType: artifact.contentType, bytes: artifact.bytes, sha256: artifact.sha256, previewToken: handle.token, previewUntil: handle.until,
        historical: artifact.state === 'retired' });
    } catch (error) { if (error instanceof ProgramMediaError) throw error; throw new ProgramMediaError('service_unavailable'); }
    finally { clearTimeout(timer); deadline.abort(); opened?.close(); }
  } });
}
