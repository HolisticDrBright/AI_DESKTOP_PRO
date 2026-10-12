if (typeof window !== 'undefined') throw new Error('program media image HTTP is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readBoundedRequestBody, BoundedBodyError } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { programMediaReservation, programMediaArtifact } from '@/contracts/programMedia';
import { ProgramMediaError } from './program-media-authoring';
import { waitProgramMediaHost } from './program-media-host-authority';

type Source = { reservation(artifactId: string): Promise<unknown>;
  admit(artifactId: string, bytes: Uint8Array, signal: AbortSignal, sha256: string): Promise<unknown> };
const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Origin' } });
const failure = (code: string, status: number) => reply(status, { contractVersion: 'program-media-image-http/1', ok: false, error: { code } });
/** The real container can receive bounded binary images. Authenticate and read
 * the immutable reservation BEFORE body admission; the native source rechecks
 * identity, recipe and SQL admission again AFTER receiving measured bytes. */
export function createProgramMediaImageHandler(input: { enabled?: boolean; sourceForRequest(request: Request, signal: AbortSignal): Promise<Source> }) {
  const enabled = input.enabled === true, factory = input.sourceForRequest;
  return async (request: Request) => {
    if (!enabled) return failure('program_media_disabled', 503);
    const url = new URL(request.url), match = url.pathname.match(/^\/api\/live\/programs\/media\/image\/([a-f0-9-]{36})$/);
    if (!match || !z.string().uuid().safeParse(match[1]).success) return failure('not_found', 404);
    if (request.url.includes('?') || url.hash || request.method !== 'PUT') return failure('request_invalid', 400);
    if (!sameBrowserOrigin(request) || request.signal.aborted) return failure('access_refused', 403);
    if (request.headers.get('content-type') !== 'application/octet-stream' || (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity'))
      return failure('request_invalid', 415);
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal]), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const source = await waitProgramMediaHost(factory(request, signal), signal);
      const reservation = programMediaReservation.parse(await waitProgramMediaHost(source.reservation(match[1]), signal));
      if (reservation.artifactId !== match[1] || reservation.kind !== 'image' || reservation.bytes > 16777216) throw new ProgramMediaError('access_refused');
      const bytes = new Uint8Array(await readBoundedRequestBody({ body: request.body, headers: request.headers, signal }, reservation.bytes, 10000));
      if (bytes.byteLength !== reservation.bytes || createHash('sha256').update(bytes).digest('hex') !== reservation.sha256) throw new ProgramMediaError('request_invalid');
      const artifact = programMediaArtifact.parse(await waitProgramMediaHost(source.admit(reservation.artifactId, bytes, signal, reservation.sha256), signal));
      if (artifact.artifactId !== reservation.artifactId || artifact.clinic !== reservation.clinic || artifact.programId !== reservation.programId
        || artifact.sha256 !== reservation.sha256 || artifact.bytes !== reservation.bytes || artifact.kind !== 'image' || artifact.contentType !== reservation.contentType
        || artifact.state !== 'ready') throw new ProgramMediaError('service_unavailable');
      return reply(200, { contractVersion: 'program-media-image-http/1', ok: true, data: artifact });
    } catch (error) {
      const code = request.signal.aborted ? 'access_refused' : controller.signal.aborted ? 'service_unavailable'
        : error instanceof ProgramMediaError ? error.code : error instanceof BoundedBodyError ? 'request_invalid' : 'service_unavailable';
      return failure(code, code === 'access_refused' ? 403 : code === 'request_invalid' ? 400 : code === 'conflict' || code === 'reservation_expired' ? 409 : 503);
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
