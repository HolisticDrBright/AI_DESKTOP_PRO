if (typeof window !== 'undefined') throw new Error('program media host is server-only');
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { createRdsDataProgramMediaDatabase } from '@/server/clinical-core/rds-data-database';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { programMediaHostTarget, type ProgramMediaHostTarget } from './program-media-host-target';
import { createProgramMediaHostAuthority, openNativeProgramMediaHostClients, waitProgramMediaHost } from './program-media-host-authority';
import { guardProgramMediaHostDatabase } from './program-media-host-database';
import { createProgramMediaControlHandler, programMediaControlCommand } from './program-media-http';
import { createProgramMediaMultipartHandler } from './program-media-multipart-http';
import { createProgramMediaMultipartRequestSource } from './program-media-multipart-request';
import { createProgramMediaMultipartPreviewRequestSource } from './program-media-multipart-preview-request';
import { createProgramMediaNativeRequestSource } from './program-media-native-request';
import { createProgramMediaNativeLedger } from './program-media-native-ledger';
import { createProgramMediaAuthoring, ProgramMediaError, type ProgramMediaObjectStore } from './program-media-authoring';
import type { AwsProgramMediaStoreConfiguration } from './aws-program-media-store';
import { createProgramMediaImageHandler } from './program-media-image-http';

export type ProgramMediaHostRequest = { database: ClinicalCoreDatabase;
  resolveContext(signal: AbortSignal): Promise<ClinicalRequestContext>;
  credentialsForProgram(scope: { clinic: string; programId: string }, signal: AbortSignal): Promise<AwsProgramMediaStoreConfiguration>;
  close(): void };
const disabled = () => new Response(JSON.stringify({ contractVersion: 'program-media-host/1', ok: false, error: { code: 'program_media_disabled' } }),
  { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const refuse = () => new Response(JSON.stringify({ contractVersion: 'program-media-host/1', ok: false, error: { code: 'access_refused' } }),
  { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const stable = (v: unknown) => JSON.stringify(v);
const neverStore: ProgramMediaObjectStore = Object.freeze({
  put: async () => { throw new ProgramMediaError('request_invalid'); }, head: async () => { throw new ProgramMediaError('request_invalid'); },
  remove: async () => { throw new ProgramMediaError('request_invalid'); }, inventory: async () => { throw new ProgramMediaError('request_invalid'); },
  preview: async () => { throw new ProgramMediaError('request_invalid'); },
});

/** Real managed-host bootstrap; no injectable identity/SQL/provider fallback in
 * this entry point. ALL SDK clients use one captured task credential principal.
 * Authentication precedes DB inspection; every DB transaction checks the same
 * dedicated login, grants and exact ledger before any authoring statement. */
export async function openNativeProgramMediaHostRequest(t: ProgramMediaHostTarget, token: string, signal: AbortSignal): Promise<ProgramMediaHostRequest> {
  const clients = await openNativeProgramMediaHostClients(signal);
  const rds = new RDSDataClient({ region: 'us-east-2', endpoint: 'https://rds-data.us-east-2.amazonaws.com', maxAttempts: 1, credentials: clients.credential });
  const close = () => { clients.close(); rds.destroy(); };
  try {
    const transport = { send: async (command: unknown) => {
      if (signal.aborted) throw new ProgramMediaError('access_refused');
      // Command shape is constructed by the fixed native SQL factory only.
      return { ...await waitProgramMediaHost(rds.send(command as Parameters<typeof rds.send>[0], { abortSignal: signal }), signal) };
    } };
    const database = guardProgramMediaHostDatabase(createRdsDataProgramMediaDatabase(t, transport), t);
    const authority = createProgramMediaHostAuthority({ target: t, database, clients });
    const admitted = await authority.resolveContext(token, signal);
    const resolveContext = async (bound: AbortSignal) => {
      const current = await authority.resolveContext(token, bound);
      if (stable(current) !== stable(admitted)) throw new ProgramMediaError('access_refused'); return current;
    };
    return Object.freeze({ database, resolveContext,
      credentialsForProgram: (scope: { clinic: string; programId: string }, bound: AbortSignal) => authority.credentialsForProgram(token, admitted, scope, bound), close });
  } catch (error) { close(); throw error; }
}

/** Router composition for the container-hosted control, image and genuine
 * binary multipart endpoints. A local fixture may replace the native opener
 * explicitly; installed routes below NEVER provide that substitution. It is
 * not a Lambda JSON/base64 tunnel and it grants no learner media authority. */
export function createProgramMediaHostHandlers(input: { target?: unknown; enabled?: boolean;
  openRequest?: (target: ProgramMediaHostTarget, token: string, signal: AbortSignal) => Promise<ProgramMediaHostRequest> }) {
  const enabled = input.enabled === true, parsed = programMediaHostTarget.safeParse(structuredClone(input.target));
  const opener = input.openRequest ?? openNativeProgramMediaHostRequest;
  return Object.freeze({ async handle(request: Request, token: string | null): Promise<Response> {
    if (!enabled || !parsed.success) return disabled();
    const t = parsed.data;
    if (!token || request.headers.get('origin') !== t.origin || request.headers.get('host') !== new URL(t.origin).host
      || !sameBrowserOrigin(request) || request.signal.aborted) return refuse();
    let opened: ProgramMediaHostRequest | undefined;
    const runtime = async (signal: AbortSignal): Promise<ProgramMediaHostRequest> => {
      const r = await waitProgramMediaHost(opener(t, token, signal).then(v => { if (signal.aborted) v.close(); return v; }), signal);
      opened = r; return r;
    };
    const activation = { enabled: true, nativeEvidenceSha256: t.nativeEvidenceSha256, multipartEvidenceSha256: t.multipartEvidenceSha256 };
    const source = (r: ProgramMediaHostRequest) => ({ database: r.database, storage: t.storage, resolveContext: r.resolveContext,
      credentialsForProgram: r.credentialsForProgram, activation, policyReview: t.policyReview });
    try {
      if (new URL(request.url).pathname.startsWith('/api/live/programs/media/multipart/')) {
        return await createProgramMediaMultipartHandler({ enabled: true, sourceForRequest: async (_req, signal) =>
          createProgramMediaMultipartRequestSource(source(await runtime(signal))) })(request);
      }
      if (new URL(request.url).pathname.startsWith('/api/live/programs/media/image/')) {
        return await createProgramMediaImageHandler({ enabled: true, sourceForRequest: async (_req, signal) => {
          const r = await runtime(signal), ledger = createProgramMediaNativeLedger(r.database, { evidenceSha256: t.nativeEvidenceSha256, storage: t.storage });
          const native = createProgramMediaNativeRequestSource({ ...source(r), resolveContext: () => r.resolveContext(signal),
            activation: { enabled: true, evidenceSha256: t.nativeEvidenceSha256 } });
          return { reservation: async (artifactId: string) => {
            const context = await r.resolveContext(signal), config = await ledger.configuration(context);
            if (config.evidenceSha256 !== t.nativeEvidenceSha256 || stable(config.storage) !== stable(t.storage)) throw new ProgramMediaError('storage_unverified');
            const row = await ledger.reservation(context, artifactId);
            if (!row || row.clinic !== context.organizationId || row.kind !== 'image') throw new ProgramMediaError('not_found');
            if (!await ledger.authorize(context, row.programId)) throw new ProgramMediaError('access_refused'); return row;
          }, admit: async (artifactId: string, bytes: Uint8Array, bound: AbortSignal, sha256: string) => {
            const answer = await native.execute({ operation: 'admit', request: { artifactId, bytes: bytes.byteLength, sha256 } }, bound, bytes);
            await r.resolveContext(bound); return answer;
          } };
        } })(request);
      }
      return await createProgramMediaControlHandler({ enabled: true, sourceForRequest: async (_req, signal) => {
        const r = await runtime(signal), ledger = createProgramMediaNativeLedger(r.database, { evidenceSha256: t.nativeEvidenceSha256, storage: t.storage });
        return { execute: async (value, bound) => {
          const command = programMediaControlCommand.parse(value), context = await r.resolveContext(bound), config = await ledger.configuration(context);
          if (config.evidenceSha256 !== t.nativeEvidenceSha256 || stable(config.storage) !== stable(t.storage)) throw new ProgramMediaError('storage_unverified');
          // Preparation/text/publication have no storage mutation. They do not
          // accidentally open the strict single-PUT policy against multipart.
          const metadata = createProgramMediaAuthoring({ ledger, storage: t.storage, store: neverStore,
            activation: { enabled: true, reason: 'Requires current reviewed native SQL release' } });
          let answer: unknown;
          if (['prepare', 'attachText', 'publish', 'retire', 'describeReference'].includes(command.operation)) {
            if (command.operation === 'prepare') answer = await metadata.prepare(context, command.request);
            else if (command.operation === 'attachText') answer = await metadata.attachText(context, command.request);
            else if (command.operation === 'publish') answer = await metadata.publish(context, command.request);
            else if (command.operation === 'retire') answer = await metadata.retire(context, command.request);
            else if (command.operation === 'describeReference') answer = await metadata.describeReference(context, command.request);
          } else if (command.operation === 'preview' && (await ledger.artifact(context, command.request.artifactId))?.kind === 'video') {
            answer = await createProgramMediaMultipartPreviewRequestSource(source(r)).execute(command, bound);
          } else {
            answer = await createProgramMediaNativeRequestSource({ ...source(r), resolveContext: () => r.resolveContext(bound),
              activation: { enabled: true, evidenceSha256: t.nativeEvidenceSha256 } }).execute(command, bound);
          }
          const current = await r.resolveContext(bound); if (stable(current) !== stable(context)) throw new ProgramMediaError('access_refused');
          const latest = await ledger.configuration(current);
          if (latest.evidenceSha256 !== t.nativeEvidenceSha256 || stable(latest.storage) !== stable(t.storage)) throw new ProgramMediaError('storage_unverified');
          return answer;
        } };
      } })(request);
    } finally { opened?.close(); }
  } });
}
