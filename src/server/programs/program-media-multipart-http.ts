if (typeof window !== 'undefined') throw new Error('program media multipart HTTP is server-only');
import { readBoundedRequestBody, BoundedBodyError } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { PROGRAM_MEDIA_FAILURES, type ProgramMediaFailure } from '@/contracts/programMedia';
import { ProgramMediaError } from './program-media-authoring';
import { readProgramMediaPart, PROGRAM_MEDIA_PART_BYTES } from './program-media-parts';
import { PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT, programMediaMultipartControlCommand, programMediaMultipartView,
  programMediaPartBodyAdmission, type ProgramMediaMultipartControlCommand } from './program-media-multipart-request';

const CONTROL = '/api/live/programs/media/multipart/control', PART = '/api/live/programs/media/multipart/part/';
const MAX_CONTROL_BYTES = 65536, MAX_REPLY_BYTES = 65536;
type Source = { execute(value: unknown, signal: AbortSignal, bytes?: Uint8Array): Promise<unknown>;
  admitPartBody(value: unknown, signal: AbortSignal): Promise<unknown> };
const status: Record<ProgramMediaFailure, number> = { program_media_disabled: 503, request_invalid: 400, access_refused: 403,
  not_found: 404, conflict: 409, not_ready: 409, retired: 409, storage_unverified: 503, service_unavailable: 503,
  reservation_expired: 409, text_source_refused: 422 };
const reply = (http: number, value: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: http, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', Pragma: 'no-cache', Vary: 'Cookie, Origin',
  'X-Content-Type-Options': 'nosniff', ...extra,
} });
const refuse = (code: ProgramMediaFailure, http = status[code], extra?: Record<string, string>) => reply(http,
  { contractVersion: PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT, ok: false, error: { code } }, extra);

/** Uninstalled Request/Response source for a host capable of actual 8 MiB
 * binary parts. No JSON/base64 Lambda tunnel or public proof route. The host
 * resolves current MFA workforce authority before the first body read. The
 * source separately binds the immutable DB recipe BEFORE receiving part bytes
 * and rechecks authority/first admission AFTER their hash matches. All provider
 * receipts, settlement and absence proofs remain internal to that source. */
export function createProgramMediaMultipartHandler(input: {
  sourceForRequest: (request: Request, signal: AbortSignal) => Promise<Source>; enabled?: boolean; timeoutMs?: number;
}) {
  const enabled = input.enabled === true, sourceForRequest = input.sourceForRequest, timeoutMs = input.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('program_media_http_limits_invalid');
  return async (request: Request): Promise<Response> => {
    if (!enabled) return refuse('program_media_disabled');
    const url = new URL(request.url), control = url.pathname === CONTROL;
    const match = url.pathname.startsWith(PART) ? url.pathname.slice(PART.length).match(/^([a-f0-9-]{36})\/([1-9]|[12][0-9]|3[0-2])\/([a-f0-9-]{36})$/) : null;
    if (!control && !match) return refuse('not_found');
    if (request.url.includes('?') || url.hash) return refuse('request_invalid');
    if (request.method !== (control ? 'POST' : 'PUT')) return refuse('request_invalid', 405, { Allow: control ? 'POST' : 'PUT' });
    if (!sameBrowserOrigin(request) || request.signal.aborted) return refuse('access_refused');
    if ((request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')
      || (control ? !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
        : request.headers.get('content-type') !== 'application/octet-stream')) return refuse('request_invalid', 415);
    const length = request.headers.get('content-length'), maximum = control ? MAX_CONTROL_BYTES : PROGRAM_MEDIA_PART_BYTES;
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > maximum))
      return refuse('request_invalid');
    const partCommand = match ? programMediaMultipartControlCommand.safeParse({ operation: 'part', request: { artifactId: match[1], partNumber: Number(match[2]), commandId: match[3] } }) : null;
    if (partCommand && !partCommand.success) return refuse('request_invalid');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal]), deadline = Date.now() + timeoutMs;
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const live = () => { if (request.signal.aborted) throw new ProgramMediaError('access_refused');
      if (signal.aborted || Date.now() >= deadline) throw new ProgramMediaError('service_unavailable'); };
    const remaining = (maximum: number) => Math.min(maximum, Math.max(1, deadline - Date.now()));
    async function execute() {
      live();
      let command: ProgramMediaMultipartControlCommand;
      if (partCommand?.success) command = partCommand.data;
      const source = await sourceForRequest(request, signal); live();
      if (!source || typeof source.execute !== 'function' || typeof source.admitPartBody !== 'function') throw new ProgramMediaError('service_unavailable');
      let body: Uint8Array | undefined;
      if (control) {
        try {
          const bytes = await readBoundedRequestBody({ body: request.body, headers: request.headers, signal }, MAX_CONTROL_BYTES, remaining(5000));
          command = programMediaMultipartControlCommand.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (command.operation === 'part') throw new Error('binary_route_required');
        } catch (error) {
          live(); if (error instanceof BoundedBodyError && error.reason === 'interrupted') throw new ProgramMediaError('access_refused');
          throw new ProgramMediaError('request_invalid');
        }
      } else {
        const admission = programMediaPartBodyAdmission.parse(await source.admitPartBody(structuredClone(command!), signal)); live();
        if (admission.partNumber !== (command! as Extract<ProgramMediaMultipartControlCommand, { operation: 'part' }>).request.partNumber)
          throw new ProgramMediaError('service_unavailable');
        body = await readProgramMediaPart(request, admission, signal, remaining(10000));
      }
      live(); const result = programMediaMultipartView.parse(await source.execute(structuredClone(command!), signal, body)); live();
      if (result.artifactId !== command!.request.artifactId || (command!.operation === 'start' && result.bytes !== command!.request.manifest.totalBytes))
        throw new ProgramMediaError('service_unavailable');
      const answer = { contractVersion: PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT, ok: true, data: result };
      if (Buffer.byteLength(JSON.stringify(answer), 'utf8') > MAX_REPLY_BYTES) throw new ProgramMediaError('service_unavailable');
      return reply(200, answer);
    }
    try {
      return await Promise.race([execute(), new Promise<never>((_resolve, reject) => {
        abort = () => { try { live(); } catch (error) { reject(error); } };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      })]);
    } catch (error) {
      return refuse(error instanceof ProgramMediaError && PROGRAM_MEDIA_FAILURES.includes(error.code) ? error.code : 'service_unavailable');
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); controller.abort(); }
  };
}
