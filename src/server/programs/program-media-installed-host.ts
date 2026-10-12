if (typeof window !== 'undefined') throw new Error('program media installed host is server-only');
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getRequestSession } from '@/server/session';
import { programMediaHostTarget } from './program-media-host-target';
import { createProgramMediaHostHandlers } from './program-media-host';
import { waitProgramMediaHost } from './program-media-host-authority';

// Reviewed, read-only container mount. No browser path, environment endpoint,
// arbitrary env-file search, config cache, credential or fixture is accepted.
const TARGET_FILE = '/run/alp/program-media-host-target.json', MAX_TARGET_BYTES = 262144;
const unavailable = () => new Response(JSON.stringify({ contractVersion: 'program-media-host/1', ok: false, error: { code: 'program_media_disabled' } }),
  { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
async function readTarget(signal: AbortSignal) {
  const opening = open(TARGET_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).then(async file => {
    // A late file-open response still owns a descriptor and must close it.
    if (signal.aborted) { await file.close(); throw new Error('refused'); } return file;
  });
  const file = await waitProgramMediaHost(opening, signal);
  try {
    const initial = await waitProgramMediaHost(file.stat(), signal);
    if (!initial.isFile() || initial.size < 1 || initial.size > MAX_TARGET_BYTES) throw new Error('refused');
    const buffer = Buffer.alloc(MAX_TARGET_BYTES + 1); let received = 0;
    while (received <= MAX_TARGET_BYTES) {
      const result = await waitProgramMediaHost(file.read(buffer, received, buffer.byteLength - received, received), signal);
      if (result.bytesRead === 0) break; received += result.bytesRead;
      if (received > MAX_TARGET_BYTES) throw new Error('refused');
    }
    const final = await waitProgramMediaHost(file.stat(), signal);
    if (received !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ino !== initial.ino) throw new Error('refused');
    const bytes = buffer.subarray(0, received);
    if (!/^[a-f0-9]{64}$/.test(process.env.PROGRAM_MEDIA_HOST_TARGET_SHA256 ?? '')
      || createHash('sha256').update(bytes).digest('hex') !== process.env.PROGRAM_MEDIA_HOST_TARGET_SHA256) throw new Error('refused');
    const target = programMediaHostTarget.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (process.env.PROGRAM_MEDIA_SOURCE_COMMIT !== target.sourceCommit) throw new Error('refused'); return target;
  } finally { await waitProgramMediaHost(file.close(), signal); }
}

/** Installed Next/container route entry, OFF by default. Enabling a flag alone
 * is not authority: the mounted artifact, signed session, current Cognito
 * policy/user, fixed database login+ledger+release and scoped STS readbacks must
 * all succeed. No AWS resources or operator approvals are created here. */
export async function handleInstalledProgramMediaRequest(request: Request): Promise<Response> {
  if (process.env.APP_EDITION !== 'clinical' || process.env.PROGRAM_MEDIA_QUALIFICATION_ENABLED !== 'true'
    || process.env.PHI_ALLOWED !== 'false' || process.env.PRODUCTION_ACTIVATION !== 'blocked') return unavailable();
  if (request.signal.aborted) return unavailable();
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 30000); request.signal.addEventListener('abort', abort, { once: true });
  try {
    const target = await readTarget(controller.signal), session = await waitProgramMediaHost(getRequestSession(), controller.signal);
    // The existing server session token is the Cognito ID token in an HttpOnly
    // cookie. Browser Authorization/custom actor fields do not override it.
    return await waitProgramMediaHost(createProgramMediaHostHandlers({ target, enabled: true }).handle(new Request(request, { signal: controller.signal }),
      session.signedIn && !session.expired ? session.token : null), controller.signal);
  } catch { return unavailable(); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); controller.abort(); }
}
