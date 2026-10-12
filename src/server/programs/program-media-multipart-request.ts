if (typeof window !== 'undefined') throw new Error('program media multipart request is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { programMediaStorageSchema, type ProgramMediaStorage } from '@/contracts/programMedia';
import { ProgramMediaError, ProgramMediaWriteError } from './program-media-authoring';
import { createProgramMediaNativeLedger } from './program-media-native-ledger';
import { createProgramMediaMultipartLedger, type ProgramMediaMultipartSession } from './program-media-multipart-ledger';
import { programMediaPartManifest, PROGRAM_MEDIA_PART_BYTES } from './program-media-parts';
import { createAwsProgramMediaMultipartStoreSource, type AwsProgramMediaMultipartStore } from './aws-program-media-multipart-store';
import type { AwsProgramMediaStoreConfiguration, ProgramMediaMultipartPolicyReview } from './aws-program-media-store';

export const PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT = 'program-media-multipart-control/1' as const;
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ artifactId: uuid }).strict();
const write = reference.extend({ commandId: uuid });
const command = <O extends string, S extends z.ZodType>(operation: O, request: S) => z.object({ operation: z.literal(operation), request }).strict();
/** No provider IDs, receipts, proof, release, actor, credentials or endpoint may
 * enter from a browser. commandId is only an idempotency key, not authority. */
export const programMediaMultipartControlCommand = z.discriminatedUnion('operation', [
  command('start', write.extend({ manifest: programMediaPartManifest })), command('status', reference),
  command('create', write), command('part', write.extend({ partNumber: z.number().int().min(1).max(32) })),
  command('complete', write), command('reconcile', reference), command('cancel', reference), command('cleanup', reference),
]);
export type ProgramMediaMultipartControlCommand = z.infer<typeof programMediaMultipartControlCommand>;
export const programMediaMultipartView = z.object({
  artifactId: uuid, contentType: z.enum(['video/mp4', 'video/webm']), bytes: z.number().int().positive().max(268435456), sha256: digest,
  state: z.enum(['prepared', 'creation_admitted', 'uploading', 'completion_admitted', 'verifying', 'abort_requested', 'committed', 'aborted']),
  acceptBefore: z.string().datetime({ offset: true }), receivedParts: z.array(z.number().int().min(1).max(32)).max(32),
  pendingParts: z.array(z.number().int().min(1).max(32)).max(32), pendingWork: z.boolean(),
}).strict().superRefine((s, ctx) => {
  const count = Math.ceil(s.bytes / PROGRAM_MEDIA_PART_BYTES);
  const received = new Set(s.receivedParts), pending = new Set(s.pendingParts);
  if (received.size !== s.receivedParts.length || pending.size !== s.pendingParts.length
    || [...received, ...pending].some(part => part > count) || [...pending].some(part => received.has(part))
    || (pending.size > 0 && !s.pendingWork)
    || (s.state === 'committed' && (s.pendingWork || received.size !== count))
    || (s.state === 'aborted' && s.pendingWork)) {
    ctx.addIssue({ code: 'custom', message: 'program_media_progress_mismatch' });
  }
});
export type ProgramMediaMultipartView = z.infer<typeof programMediaMultipartView>;
export const programMediaPartBodyAdmission = z.object({ totalBytes: z.number().int().positive().max(268435456),
  partNumber: z.number().int().min(1).max(32), sha256: digest }).strict();
const storageIdentity = (s: ProgramMediaStorage) => JSON.stringify([s.purpose, s.phiAllowed, s.dedicated, s.bucket,
  s.expectedBucketOwner, s.region, s.kmsKeyArn, s.maxImageBytes, s.maxVideoBytes, s.publicOrigin]);
const activationSchema = z.object({ enabled: z.literal(true), nativeEvidenceSha256: digest, multipartEvidenceSha256: digest }).strict();
const reviewSchema = z.object({ contract: z.literal('program-media-multipart-resource-review/1'), policySha256: digest, evidenceSha256: digest }).strict();

/** Uninstalled, OFF-by-default native request composition. A trusted host must
 * independently resolve CURRENT MFA workforce authority, reviewed releases,
 * restricted SQL credentials and program-scoped STS credentials. It is not a
 * browser auth factory, deploy approval, public route or background worker.
 * SDK I/O is outside short ledger transactions. Unknown writers stay pending;
 * interrupted requests do not certify settlement, cancellation or deletion. */
export function createProgramMediaMultipartRequestSource(input: {
  database: ClinicalCoreDatabase; storage: ProgramMediaStorage;
  resolveContext: (signal: AbortSignal) => Promise<ClinicalRequestContext>;
  credentialsForProgram: (scope: { clinic: string; programId: string }, signal: AbortSignal) => Promise<AwsProgramMediaStoreConfiguration>;
  activation?: { enabled: boolean; nativeEvidenceSha256: string; multipartEvidenceSha256: string };
  policyReview?: ProgramMediaMultipartPolicyReview; timeoutMs?: number;
}) {
  // Capture dependencies and reviewed values once. Never re-read mutable input
  // while awaiting authentication, admission, provider work or receipt writes.
  const resolveContext = input.resolveContext, credentialsForProgram = input.credentialsForProgram;
  const database: ClinicalCoreDatabase = { transaction: input.database.transaction.bind(input.database) };
  const storage = Object.freeze(programMediaStorageSchema.parse(input.storage));
  const activation = activationSchema.safeParse(input.activation), policy = reviewSchema.safeParse(input.policyReview);
  const timeoutMs = input.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ProgramMediaError('request_invalid');
  const enabled = input.activation?.enabled === true;
  const release = activation.success ? { evidenceSha256: activation.data.nativeEvidenceSha256, storage } : undefined;
  const native = createProgramMediaNativeLedger(database, release);
  const multipart = createProgramMediaMultipartLedger(database, release, activation.success
    ? { enabled: true, evidenceSha256: activation.data.multipartEvidenceSha256 } : undefined);

    async function executeNative(value: unknown, requestSignal: AbortSignal, bytes?: Uint8Array, bodyAdmissionOnly = false) {
      if (!enabled) throw new ProgramMediaError('program_media_disabled');
      if (!activation.success || !policy.success) throw new ProgramMediaError('storage_unverified');
      const reviewedPolicy = policy.data;
      if (!(requestSignal instanceof AbortSignal) || requestSignal.aborted) throw new ProgramMediaError('access_refused');
      const parsed = programMediaMultipartControlCommand.safeParse(value);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const captured = structuredClone(parsed.data);
      if (bodyAdmissionOnly && captured.operation !== 'part') throw new ProgramMediaError('request_invalid');
      if ((!bodyAdmissionOnly && captured.operation === 'part') !== (bytes instanceof Uint8Array)
        || (bytes !== undefined && (bytes.byteLength < 1 || bytes.byteLength > PROGRAM_MEDIA_PART_BYTES))) throw new ProgramMediaError('request_invalid');
      const body = bytes === undefined ? undefined : new Uint8Array(bytes);
      const controller = new AbortController(), bound = AbortSignal.any([requestSignal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let opened: Awaited<ReturnType<typeof createAwsProgramMediaMultipartStoreSource>> | undefined;
      const live = () => {
        if (requestSignal.aborted) throw new ProgramMediaError('access_refused');
        if (bound.aborted) throw new ProgramMediaError('service_unavailable');
      };
      async function wait<T>(work: Promise<T>, discard?: (late: T) => void): Promise<T> {
        const observed = work.then(answer => { if (bound.aborted) discard?.(answer); live(); return answer; });
        if (bound.aborted) { void observed.catch(() => undefined); live(); }
        let stop: (() => void) | undefined;
        try {
          return await Promise.race([observed, new Promise<never>((_resolve, reject) => {
            stop = () => { try { live(); } catch (error) { reject(error); } };
            bound.addEventListener('abort', stop, { once: true }); if (bound.aborted) stop();
          })]);
        } finally { if (stop) bound.removeEventListener('abort', stop); }
      }
      try {
        live(); const context = Object.freeze({ ...await wait(resolveContext(bound)) });
        const configured = await wait(native.configuration(context));
        if (configured.evidenceSha256 !== activation.data.nativeEvidenceSha256
          || storageIdentity(configured.storage) !== storageIdentity(storage)) throw new ProgramMediaError('storage_unverified');
        const artifact = await wait(native.artifact(context, captured.request.artifactId));
        if (!artifact || artifact.clinic !== context.organizationId) throw new ProgramMediaError('not_found');
        if (artifact.kind !== 'video' || artifact.bytes > storage.maxVideoBytes) throw new ProgramMediaError('request_invalid');
        if (!await wait(native.authorize(context, artifact.programId))) throw new ProgramMediaError('access_refused');
        const artifactId = artifact.artifactId;
        const call = (operation: string, parameters: Record<string, unknown>) => {
          live(); return wait(multipart.execute(context, { operation, parameters: { artifactId, ...parameters } }));
        };
        const status = async () => (await call('status', {})).session;
        const view = (s: ProgramMediaMultipartSession) => programMediaMultipartView.parse({
          artifactId: s.artifactId, contentType: s.contentType, bytes: s.totalBytes, sha256: s.sha256, state: s.state, acceptBefore: s.acceptBefore,
          receivedParts: s.parts.map(p => p.partNumber).sort((a, b) => a - b),
          pendingParts: s.pending.filter(p => p.kind === 'part').map(p => p.partNumber!).sort((a, b) => a - b), pendingWork: s.pending.length > 0,
        });
        async function store(): Promise<AwsProgramMediaMultipartStore> {
          if (opened) return opened.store;
          const scope = Object.freeze({ clinic: context.organizationId, programId: artifact!.programId });
          const credentials = structuredClone(await wait(credentialsForProgram(scope, bound)));
          if (credentials.scope.clinic !== scope.clinic || credentials.scope.programId !== scope.programId
            || storageIdentity(credentials.storage) !== storageIdentity(storage)) throw new ProgramMediaError('storage_unverified');
          opened = await wait(createAwsProgramMediaMultipartStoreSource(credentials, bound, reviewedPolicy, context.actorPersonId), late => late.close());
          return opened.store;
        }
        async function commit(s: ProgramMediaMultipartSession, proof?: { objectVersion: string; checksum: string; sha256: string; bytes: number }) {
          if (s.state === 'committed') return s;
          if (s.state !== 'verifying' || s.pending.length !== 0) return s;
          const measured = proof ?? await wait((await store()).verify(s, bound));
          return (await call('commit', { proof: measured })).session;
        }
        async function reconcile(s: ProgramMediaMultipartSession) {
          if (s.state === 'committed' || s.state === 'aborted' || s.state === 'prepared') return s;
          if (s.uploadId && s.pending.some(p => p.kind === 'part')) {
            const listing = await wait((await store()).parts(s, bound));
            if (!listing.complete) throw new ProgramMediaError('service_unavailable');
            for (const pending of s.pending.filter(p => p.kind === 'part')) {
              const observed = listing.parts.find(p => p.partNumber === pending.partNumber);
              if (observed) {
                const { partNumber, ...receipt } = observed;
                s = (await call('recordPart', { claimId: pending.claimId, partNumber, receipt })).session;
              }
            }
          }
          const completing = s.pending.find(p => p.kind === 'completion');
          if (completing) {
            const inventory = await wait((await store()).inventory(s, bound));
            if (!inventory.complete) throw new ProgramMediaError('service_unavailable');
            // A unique exact-key version is a candidate, NOT proof. Verify its
            // metadata, writer, composite and every measured byte before using it.
            if (inventory.versions.length !== 1 || inventory.versions[0].deleteMarker) return s;
            const candidate = { ...s, objectVersion: inventory.versions[0].objectVersion, state: 'verifying' as const };
            const proof = await wait((await store()).verify(candidate, bound));
            s = (await call('recordCompletion', { claimId: completing.claimId, objectVersion: proof.objectVersion, checksum: proof.checksum })).session;
            return commit(s, proof);
          }
          // ListMultipartUploads does not expose initiating metadata. An unknown
          // creation is never adopted by key/count or replayed under a new claim.
          return commit(s);
        }
        async function mutate(kind: 'creation' | 'part' | 'completion', claimId: string, partNumber?: number) {
          const operation = kind === 'creation' ? 'admitCreation' : kind === 'part' ? 'admitPart' : 'admitCompletion';
          const admitted = await call(operation, { claimId, ...(partNumber === undefined ? {} : { partNumber }) });
          if (!admitted.admitted) return kind === 'completion' ? commit(admitted.session) : admitted.session;
          let attempted = false;
          try {
            const provider = await store(); live();
            const admission = { ...admitted, claimId }; attempted = true;
            if (kind === 'creation') {
              const receipt = await wait(provider.create(admission, bound));
              return (await call('recordUpload', { claimId, ...receipt })).session;
            }
            if (kind === 'part') {
              const { partNumber: receivedPart, ...receipt } = await wait(provider.part(admission, partNumber!, body!, bound));
              return (await call('recordPart', { claimId, partNumber: receivedPart, receipt })).session;
            }
            const receipt = await wait(provider.complete(admission, bound));
            const recorded = (await call('recordCompletion', { claimId, ...receipt })).session;
            // This attempt is settled at its receipt. A subsequent verification
            // failure must not reclassify that receipt or issue completion again.
            return commit(recorded);
          } catch (error) {
            if (!bound.aborted) {
              const current = await status();
              if (current.pending.some(p => p.claimId === claimId)) {
                const outcome = !attempted ? 'not_sent' : error instanceof ProgramMediaWriteError && error.settled ? 'failed_before_mutation' : 'uncertain';
                await call('settleAttempt', { claimId, outcome });
              }
            }
            // A failed receipt/settlement is never reported as successful work.
            // If withdrawal/deadline prevents recovery, the durable admission is
            // deliberately retained for a separately authorized recovery pass.
            if (error instanceof ProgramMediaError) throw error;
            throw new ProgramMediaError('service_unavailable');
          }
        }

        if (captured.operation === 'start') {
          if (captured.request.manifest.totalBytes !== artifact.bytes) throw new ProgramMediaError('request_invalid');
          return view((await call('start', { manifest: captured.request.manifest, writerClaimId: captured.request.commandId })).session);
        }
        const current = await status();
        if (captured.operation === 'status') return view(current);
        if (captured.operation === 'cancel') return view((await call('cancel', {})).session);
        if (captured.operation === 'reconcile') return view(await reconcile(current));
        if (captured.operation === 'cleanup') {
          if (current.state === 'aborted') return view(current);
          if (current.state !== 'abort_requested') throw new ProgramMediaError('conflict');
          // No destructive request is made while ANY admitted writer is open or
          // uncertain. Time passing, an HTTP abort or an empty HEAD is not proof.
          if (current.pending.length > 0) return view(current);
          const provider = await store(), initial = await wait(provider.inventory(current, bound));
          if (!initial.complete) throw new ProgramMediaError('service_unavailable');
          for (const upload of initial.uploads) await wait(provider.abort(current, upload.uploadId, bound));
          for (const version of initial.versions) await wait(provider.removeVersion(current, version.objectVersion, bound));
          const final = await wait(provider.inventory(current, bound));
          if (!final.complete || final.uploads.length !== 0 || final.versions.length !== 0) throw new ProgramMediaError('service_unavailable');
          return view((await call('certifyAbort', { proof: { complete: true, remainingUploads: 0, remainingVersions: 0,
            checkedAt: final.checkedAt, objectKey: current.objectKey } })).session);
        }
        if (captured.operation === 'part') {
          const expected = current.manifest.parts[captured.request.partNumber - 1];
          if (bodyAdmissionOnly) {
            if (!expected || current.state !== 'uploading') throw new ProgramMediaError('conflict');
            // Admission to RECEIVE bounded bytes under current durable owner and
            // immutable recipe. It admits no provider write; first write admission
            // is rechecked only after the measured body passes integrity checks.
            return programMediaPartBodyAdmission.parse({ totalBytes: current.totalBytes, partNumber: expected.partNumber, sha256: expected.sha256 });
          }
          if (!expected || body!.byteLength !== expected.bytes || createHash('sha256').update(body!).digest('hex') !== expected.sha256)
            throw new ProgramMediaError('request_invalid');
          return view(await mutate('part', captured.request.commandId, captured.request.partNumber));
        }
        return view(await mutate(captured.operation === 'create' ? 'creation' : 'completion', captured.request.commandId));
      } catch (error) {
        if (error instanceof ProgramMediaError) throw error;
        throw new ProgramMediaError('service_unavailable');
      } finally { clearTimeout(timer); controller.abort(); opened?.close(); }
    }
  return Object.freeze({
    async execute(value: unknown, signal: AbortSignal, bytes?: Uint8Array) {
      return programMediaMultipartView.parse(await executeNative(value, signal, bytes));
    },
    async admitPartBody(value: unknown, signal: AbortSignal) {
      return programMediaPartBodyAdmission.parse(await executeNative(value, signal, undefined, true));
    },
  });
}
