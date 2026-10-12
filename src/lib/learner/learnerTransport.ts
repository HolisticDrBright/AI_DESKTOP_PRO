import { z } from 'zod';
import { educationAccessView, educationCurriculumRead, type CurriculumBinding } from '@/contracts/programEducationAccess';
import { curriculumPin, educationProgressOutcome, educationProgressRead, educationProgressRequest, type EducationProgress, type EducationProgressRequest } from '@/contracts/programEducationProgress';

/**
 * The browser side of My courses: one same-origin route (`/api/my-courses`), one deadline
 * over the request and the whole body, a received-byte bound with Content-Length agreement and
 * strict UTF-8, no redirects, nothing cached, and every reply parsed against the contract and bound
 * to the course the caller is opening. The same answer rules as the consumer app's progress client:
 * a reply for another entitlement, enrollment or curriculum pin is not this course's answer, and a
 * receipt must agree with the progress it arrives with.
 */
export type LearnerFailure = 'signin' | 'access' | 'host_unavailable' | 'invalid' | 'unavailable';
export class LearnerTransportError extends Error {
  constructor(readonly reason: LearnerFailure) { super(reason); this.name = 'LearnerTransportError'; }
}
export const LEARNER_REPLY_MAX_BYTES = 1_048_576;
export const LEARNER_DEADLINE_MS = 20_000;
export const LEARNER_ROUTE = '/api/my-courses';

const host = z.enum(['reviewed', 'fictional_fixture', 'fictional_sql_fixture']);
const accessReply = z.object({ data: z.object({ action: z.literal('access'), view: educationAccessView }).strict(), host }).strict();
const curriculumReply = z.object({ data: z.object({ action: z.literal('curriculum'), read: educationCurriculumRead }).strict(), host }).strict();
const progressReply = z.object({ data: z.union([
  z.object({ action: z.literal('read'), read: educationProgressRead }).strict(),
  z.object({ action: z.enum(['complete', 'position']), outcome: educationProgressOutcome }).strict(),
]), host }).strict();
export type LearnerHostKind = z.infer<typeof host>;
export type ProgressReply = z.infer<typeof progressReply>['data'];
export const progressBinding = z.object({ entitlementId: z.string().uuid(), enrollmentId: z.string().uuid().nullable(), curriculum: curriculumPin }).strict();
export type ProgressBinding = z.infer<typeof progressBinding>;

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new LearnerTransportError('unavailable');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LEARNER_REPLY_MAX_BYTES)) throw new LearnerTransportError('unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw new LearnerTransportError('unavailable');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new LearnerTransportError('unavailable');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LEARNER_REPLY_MAX_BYTES || (length !== null && size > Number(length))) throw new LearnerTransportError('unavailable');
      chunks.push(next.value);
    }
    if (length !== null && size !== Number(length)) throw new LearnerTransportError('unavailable');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new LearnerTransportError('unavailable'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}

export function createLearnerTransport(deps: { fetch: typeof fetch; deadlineMs?: number }) {
  async function post(payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LearnerTransportError('unavailable')); }, deps.deadlineMs ?? LEARNER_DEADLINE_MS); });
    const attempt = (async () => {
      const response = await deps.fetch(LEARNER_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
      if (response.redirected || response.type === 'opaqueredirect') throw new LearnerTransportError('unavailable');
      const raw = await readBody(response, controller.signal);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new LearnerTransportError('unavailable'); }
      if (response.status === 200) return parsed;
      const code = (parsed as { error?: { code?: unknown } })?.error?.code;
      if (response.status === 401) throw new LearnerTransportError('signin');
      if (response.status === 403) throw new LearnerTransportError('access');
      if (response.status === 400) throw new LearnerTransportError('invalid');
      if (response.status === 503 && code === 'learner_host_unavailable') throw new LearnerTransportError('host_unavailable');
      throw new LearnerTransportError('unavailable');
    })();
    // The deadline settles the call even if the transport ignores the abort; a late answer is never read.
    attempt.catch(() => undefined);
    try { return await Promise.race([attempt, deadline]); }
    catch (error) { throw error instanceof LearnerTransportError ? error : new LearnerTransportError('unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    async access() {
      const reply = accessReply.safeParse(await post({ service: 'education', body: { action: 'access' } }));
      if (!reply.success) throw new LearnerTransportError('unavailable');
      return { view: reply.data.data.view, host: reply.data.host };
    },
    async curriculum(entitlementId: string, pin: CurriculumBinding) {
      const reply = curriculumReply.safeParse(await post({ service: 'education', body: { action: 'curriculum', entitlementId } }));
      if (!reply.success) throw new LearnerTransportError('unavailable');
      const read = reply.data.data.read;
      // The answer is for the entitlement asked about and, when served, for exactly the purchased pin.
      if (read.entitlementId !== entitlementId || (read.outcome === 'served' && !samePin(read.curriculum, pin))) throw new LearnerTransportError('unavailable');
      return { read, host: reply.data.host };
    },
    async progress(command: EducationProgressRequest, binding: ProgressBinding) {
      const checked = educationProgressRequest.safeParse(command), bound = progressBinding.safeParse(binding);
      if (!checked.success || !bound.success) throw new LearnerTransportError('invalid');
      if (!commandFits(checked.data, bound.data)) throw new LearnerTransportError('invalid');
      const reply = progressReply.safeParse(await post({ service: 'progress', body: checked.data }));
      if (!reply.success || !answers(checked.data, bound.data, reply.data.data)) throw new LearnerTransportError('unavailable');
      return { reply: reply.data.data, host: reply.data.host };
    },
  };
}
export type LearnerTransport = ReturnType<typeof createLearnerTransport>;

const samePin = (a: CurriculumBinding, b: CurriculumBinding) => a.versionId === b.versionId && a.version === b.version && a.sourceDigest === b.sourceDigest;
const sameRef = (a: { phaseId: string; itemId: string }, b: { phaseId: string; itemId: string }) => a.phaseId === b.phaseId && a.itemId === b.itemId;
const belongs = (progress: EducationProgress, binding: ProgressBinding) => progress.entitlementId === binding.entitlementId
  && (binding.enrollmentId === null || progress.enrollmentId === binding.enrollmentId) && samePin(progress.curriculum, binding.curriculum);
const commandFits = (command: EducationProgressRequest, binding: ProgressBinding) => command.entitlementId === binding.entitlementId
  && (command.action === 'read' || (binding.enrollmentId !== null && command.enrollmentId === binding.enrollmentId && samePin(command.curriculum, binding.curriculum)));

/** Whether a progress reply answers this command for this course (the consumer app's rule, kept identical). */
export function answers(command: EducationProgressRequest, binding: ProgressBinding, data: ProgressReply): boolean {
  if (data.action !== command.action) return false;
  if (data.action === 'read') return data.read.outcome === 'refused' || belongs(data.read.progress, binding);
  if (command.action === 'read') return false;
  const outcome = data.outcome, progress = outcome.progress;
  if (progress && (!belongs(progress, binding) || progress.enrollmentId !== command.enrollmentId)) return false;
  if (outcome.outcome === 'recorded') {
    const receipt = outcome.receipt;
    if (receipt.requestId !== command.requestId || receipt.action !== command.action || !sameRef(receipt.lesson, command.lesson)) return false;
    if (receipt.revision !== command.expectedRevision + 1 || outcome.progress.revision < receipt.revision) return false;
    if (command.action === 'complete' && !outcome.progress.completed.some(entry => sameRef(entry.lesson, command.lesson))) return false;
    return true;
  }
  if (outcome.reason === 'revision_stale') return !!progress && progress.revision !== command.expectedRevision;
  return true;
}
