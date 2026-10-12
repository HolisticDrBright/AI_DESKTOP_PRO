import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
const f = vi.hoisted(() => ({ open: vi.fn(), session: vi.fn(), factory: vi.fn(), handle: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: f.open }));
vi.mock('@/server/session', () => ({ getRequestSession: f.session }));
vi.mock('./program-media-host', () => ({ createProgramMediaHostHandlers: f.factory }));
import { handleInstalledProgramMediaRequest } from './program-media-installed-host';
import { PROGRAM_MEDIA_HOST_SCHEMA_SHA256 } from './program-media-host-target';
const id = (n: number) => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = () => ({ contract: 'program-media-host-target/1', execution: 'qualification', account: '588966314750', region: 'us-east-2',
  phiAllowed: false, productionActivation: 'blocked', sourceCommit: 'a'.repeat(40), hostReviewSha256: 'a'.repeat(64), databaseName: 'clinical_core_qualification',
  clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-media', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-media-login',
  loginName: 'program_media_runtime', hostRoleArn: 'arn:aws:iam::588966314750:role/alp-media-host', storageRoleArn: 'arn:aws:iam::588966314750:role/alp-media-storage',
  poolId: 'us-east-2_fictionalMedia', clientId: 'fictionalmedia', origin: 'https://desktop.example.test',
  designatedWorkforce: [{ subject: 'fictional_media_workforce', personId: id(1), organizationId: id(2) }],
  migrations: Object.entries(PROGRAM_MEDIA_HOST_SCHEMA_SHA256).map(([name, sha256], i) => ({
    version: '202610110000' + String(i).padStart(2, '0'), name: 'fictional_only_' + name.slice(0, -4), sha256 })),
  storage: { purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-lessons', expectedBucketOwner: '588966314750', region: 'us-east-2',
    kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/' + id(90), maxImageBytes: 16777216, maxVideoBytes: 268435456, publicOrigin: 'https://lessons.example.test/' },
  forbiddenBuckets: ['fictional-recordings'], forbiddenKmsKeyArns: ['arn:aws:kms:us-east-2:588966314750:key/' + id(91)],
  nativeEvidenceSha256: 'c'.repeat(64), multipartEvidenceSha256: 'd'.repeat(64),
  policyReview: { contract: 'program-media-multipart-resource-review/1', policySha256: 'e'.repeat(64), evidenceSha256: 'f'.repeat(64) } });
let close: ReturnType<typeof vi.fn>, stat: ReturnType<typeof vi.fn>, content: Buffer;
const request = () => new Request('https://desktop.example.test/api/live/programs/media/control', { method: 'POST', headers: { authorization: 'Bearer browser-forged-token' }, body: '{}' });
function enabled() {
  vi.stubEnv('APP_EDITION', 'clinical'); vi.stubEnv('PROGRAM_MEDIA_QUALIFICATION_ENABLED', 'true'); vi.stubEnv('PHI_ALLOWED', 'false'); vi.stubEnv('PRODUCTION_ACTIVATION', 'blocked');
  vi.stubEnv('PROGRAM_MEDIA_SOURCE_COMMIT', 'a'.repeat(40)); vi.stubEnv('PROGRAM_MEDIA_HOST_TARGET_SHA256', createHash('sha256').update(content).digest('hex'));
}
beforeEach(() => {
  vi.resetAllMocks(); content = Buffer.from(JSON.stringify(target())); close = vi.fn(async () => undefined);
  stat = vi.fn(async () => ({ isFile: () => true, size: content.length, mtimeMs: 1, ino: 2 }));
  f.open.mockResolvedValue({ stat, close, read: async (buffer: Buffer, offset: number, length: number, position: number) => {
    const part = content.subarray(position, position + length); part.copy(buffer, offset); return { bytesRead: part.length }; } });
  f.session.mockResolvedValue({ signedIn: true, expired: false, token: 'signed-cookie-id-token' });
  f.factory.mockReturnValue({ handle: f.handle }); f.handle.mockImplementation(async () => new Response('fixture handler only', { status: 202 }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('installed container entry, configuration-only fictional test', () => {
  it.each(['APP_EDITION', 'PROGRAM_MEDIA_QUALIFICATION_ENABLED', 'PHI_ALLOWED', 'PRODUCTION_ACTIVATION'])('is off before file/session/network use with wrong %s', async key => {
    enabled(); vi.stubEnv(key, 'wrong'); expect((await handleInstalledProgramMediaRequest(request())).status).toBe(503);
    expect(f.open).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
  });
  it('uses only the bounded exact mounted artifact and signed server-cookie token, not browser Authorization', async () => {
    enabled(); const r = request(); expect((await handleInstalledProgramMediaRequest(r)).status).toBe(202);
    expect(f.open.mock.calls[0][0]).toBe('/run/alp/program-media-host-target.json');
    expect(f.factory).toHaveBeenCalledWith({ target: target(), enabled: true });
    const [bound, token] = f.handle.mock.calls[0] as [Request, string]; expect(bound.url).toBe(r.url); expect(token).toBe('signed-cookie-id-token');
    expect(bound.signal.aborted).toBe(true); expect(close).toHaveBeenCalledOnce();
  });
  it.each(['changed size', 'changed inode', 'changed mtime', 'not a file', 'too large', 'wrong hash', 'wrong source', 'missing file', 'bad JSON'])('holds %s without installing a fallback host', async what => {
    enabled();
    if (what === 'changed size') stat.mockResolvedValueOnce({ isFile: () => true, size: content.length - 1, mtimeMs: 1, ino: 2 });
    if (what === 'changed inode') stat.mockResolvedValueOnce({ isFile: () => true, size: content.length, mtimeMs: 1, ino: 3 });
    if (what === 'changed mtime') stat.mockResolvedValueOnce({ isFile: () => true, size: content.length, mtimeMs: 2, ino: 2 });
    if (what === 'not a file') stat.mockResolvedValue({ isFile: () => false, size: content.length, mtimeMs: 1, ino: 2 });
    if (what === 'too large') stat.mockResolvedValue({ isFile: () => true, size: 262145, mtimeMs: 1, ino: 2 });
    if (what === 'wrong hash') vi.stubEnv('PROGRAM_MEDIA_HOST_TARGET_SHA256', 'f'.repeat(64));
    if (what === 'wrong source') vi.stubEnv('PROGRAM_MEDIA_SOURCE_COMMIT', 'f'.repeat(40));
    if (what === 'missing file') f.open.mockRejectedValue(new Error('not present'));
    if (what === 'bad JSON') { content = Buffer.from('{'); enabled(); }
    const response = await handleInstalledProgramMediaRequest(request()); expect(response.status).toBe(503); expect(f.factory).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('secret');
  });
  it('passes no token for an expired session and never uses a browser-provided identity', async () => {
    enabled(); f.session.mockResolvedValue({ signedIn: true, expired: true, token: 'expired-cookie' }); const r = request(); await handleInstalledProgramMediaRequest(r);
    expect(f.handle.mock.calls[0][0].url).toBe(r.url); expect(f.handle.mock.calls[0][1]).toBeNull();
  });
  it.each(['open', 'stat', 'read', 'session', 'handler'])('bounds an ignored %s wait by one total deadline', async step => {
    vi.useFakeTimers(); enabled();
    if (step === 'open') f.open.mockImplementation(() => new Promise(() => undefined));
    if (step === 'stat') stat.mockImplementation(() => new Promise(() => undefined));
    if (step === 'read') f.open.mockResolvedValue({ stat, close, read: () => new Promise(() => undefined) });
    if (step === 'session') f.session.mockImplementation(() => new Promise(() => undefined));
    if (step === 'handler') f.handle.mockImplementation(() => new Promise(() => undefined));
    const work = handleInstalledProgramMediaRequest(request()); await vi.advanceTimersByTimeAsync(30000);
    expect((await work).status).toBe(503); expect(vi.getTimerCount()).toBe(0);
    if (step === 'stat' || step === 'read') expect(close).toHaveBeenCalledOnce();
  });
  it('closes a descriptor whose open finishes after withdrawal without admitting a session', async () => {
    vi.useFakeTimers(); enabled(); let finish!: (file: unknown) => void;
    f.open.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const work = handleInstalledProgramMediaRequest(request()); await vi.advanceTimersByTimeAsync(30000); expect((await work).status).toBe(503);
    finish({ close }); await Promise.resolve(); await Promise.resolve(); expect(close).toHaveBeenCalledOnce(); expect(f.session).not.toHaveBeenCalled();
  });
});
