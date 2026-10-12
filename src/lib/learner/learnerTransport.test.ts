import { describe, expect, it, vi } from 'vitest';
import { createLearnerTransport, LEARNER_REPLY_MAX_BYTES, LEARNER_ROUTE } from './learnerTransport';

/**
 * The My courses transport (hardening WP2) under hostile or inconsistent answers: bounded by
 * received bytes and one deadline, strict UTF-8, no redirects, and every answer bound to the course
 * being opened. The same rules as the consumer app's clients. Fictional values only.
 */
const entitlementId = '7e1a0000-0000-4000-8000-0000000000f1', enrollmentId = '7e1a0000-0000-4000-8000-0000000000f2';
const curriculum = { versionId: '7e1a0000-0000-4000-8000-0000000000f3', version: 1, sourceDigest: 'd'.repeat(64) };
const binding = { entitlementId, enrollmentId, curriculum };
const lesson = { phaseId: 'phase-1', itemId: 'lesson-a' }, requestId = '7e1a0000-0000-4000-8000-0000000000a1';
const progress = (over: Record<string, unknown> = {}) => ({ contract: 'program-education-progress/1', entitlementId, enrollmentId, curriculum, revision: 1, completed: [{ lesson, completedAt: '2026-10-12T00:00:00Z', requestId }], position: null, updatedAt: '2026-10-12T00:00:00Z', ...over });
const write = { action: 'complete' as const, entitlementId, enrollmentId, curriculum, lesson, expectedRevision: 0, requestId };
const recorded = (receipt: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({ action: 'complete', outcome: { outcome: 'recorded', receipt: { requestId, action: 'complete', lesson, recordedAt: '2026-10-12T00:00:00Z', revision: 1, ...receipt }, progress: progress(state) } });
const json = (body: BodyInit, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (data: unknown) => JSON.stringify({ data, host: 'reviewed' });
const transport = (fetchImpl: typeof fetch, deadlineMs?: number) => createLearnerTransport({ fetch: fetchImpl, deadlineMs });

describe('the wire', () => {
  it('posts to the learner route, same-origin, never cached, redirects refused', async () => {
    const fetchImpl = vi.fn(async () => json(ok({ action: 'read', read: { outcome: 'read', progress: progress() } })));
    await transport(fetchImpl as unknown as typeof fetch).progress({ action: 'read', entitlementId }, binding);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LEARNER_ROUTE);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(init.body))).toEqual({ service: 'progress', body: { action: 'read', entitlementId } });
  });
  it('stops pulling a multibyte stream once past the bound', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('€'.repeat(21_846));
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (pulled >= 8_000_000) { c.close(); return; } pulled += chunk.byteLength; c.enqueue(chunk); } });
    await expect(transport(async () => json(stream)).access()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(pulled).toBeLessThanOrEqual(LEARNER_REPLY_MAX_BYTES + 2 * chunk.byteLength);
  });
  it('refuses a body longer than its Content-Length, invalid UTF-8, and a followed redirect', async () => {
    const body = ok({ action: 'read', read: { outcome: 'read', progress: progress() } });
    await expect(transport(async () => json(body, 200, { 'content-length': String(body.length - 10) })).progress({ action: 'read', entitlementId }, binding)).rejects.toMatchObject({ reason: 'unavailable' });
    const bytes = new TextEncoder().encode(body); const broken = bytes.slice(); broken[broken.length - 3] = 0xff;
    await expect(transport(async () => json(broken)).progress({ action: 'read', entitlementId }, binding)).rejects.toMatchObject({ reason: 'unavailable' });
    const redirected = json(body); Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(transport(async () => redirected).progress({ action: 'read', entitlementId }, binding)).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('one deadline: a transport that ignores the abort is cut off, and its late answer is never read', async () => {
    vi.useFakeTimers();
    try {
      let late: (value: Response) => void = () => undefined;
      const pending = transport(() => new Promise<Response>(resolve => { late = resolve; }), 5_000).access();
      const outcome = expect(pending).rejects.toMatchObject({ reason: 'unavailable' });
      await vi.advanceTimersByTimeAsync(5_001);
      await outcome;
      late(json(ok({ action: 'access', view: {} })));
      await vi.advanceTimersByTimeAsync(10);
    } finally { vi.useRealTimers(); }
  });
  it('a body that stalls after its headers is cut off by the same deadline and cancelled', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined); }, cancel() { cancelled = true; } });
      const outcome = expect(transport(async () => json(stream), 5_000).access()).rejects.toMatchObject({ reason: 'unavailable' });
      await vi.advanceTimersByTimeAsync(5_001);
      await outcome;
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('says what a refusal is: sign-in, access, no host, invalid, or unavailable', async () => {
    const cases: [number, string, string][] = [[401, 'learner_signin_required', 'signin'], [403, 'identity_refused', 'access'], [503, 'learner_host_unavailable', 'host_unavailable'], [400, 'request_invalid', 'invalid'], [503, 'service_unavailable', 'unavailable'], [404, 'not_found', 'unavailable']];
    for (const [status, code, reason] of cases) {
      await expect(transport(async () => json(JSON.stringify({ error: { code, message: code } }), status)).access()).rejects.toMatchObject({ reason });
    }
  });
});

describe('every answer is bound to the course being opened', () => {
  it('a curriculum for another entitlement or another pin is not this purchase', async () => {
    const served = (over: Record<string, unknown>) => ok({ action: 'curriculum', read: { outcome: 'served', entitlementId, curriculum, title: 'Fictional course', phases: [{}], ...over } });
    for (const over of [{ entitlementId: '7e1a0000-0000-4000-8000-0000000000e9' }, { curriculum: { ...curriculum, version: 2 } }, { curriculum: { ...curriculum, sourceDigest: 'e'.repeat(64) } }]) {
      await expect(transport(async () => json(served(over))).curriculum(entitlementId, curriculum)).rejects.toMatchObject({ reason: 'unavailable' });
    }
    await expect(transport(async () => json(served({}))).curriculum(entitlementId, curriculum)).resolves.toMatchObject({ read: { outcome: 'served' } });
  });
  it('progress for another enrollment or pin, a receipt that disagrees with its progress, or a dishonest stale refusal is refused', async () => {
    const replies = [
      { action: 'read', read: { outcome: 'read', progress: progress({ enrollmentId: '7e1a0000-0000-4000-8000-0000000000e8' }) } },
      { action: 'read', read: { outcome: 'read', progress: progress({ curriculum: { ...curriculum, version: 2 } }) } },
    ];
    for (const reply of replies) await expect(transport(async () => json(ok(reply))).progress({ action: 'read', entitlementId }, binding)).rejects.toMatchObject({ reason: 'unavailable' });
    for (const reply of [recorded({ revision: 2 }, { revision: 2 }), recorded({ revision: 1 }, { revision: 0 }), recorded({}, { completed: [] }), { action: 'complete', outcome: { outcome: 'refused', reason: 'revision_stale', progress: progress({ revision: 0, completed: [] }) } }]) {
      await expect(transport(async () => json(ok(reply))).progress(write, binding)).rejects.toMatchObject({ reason: 'unavailable' });
    }
    await expect(transport(async () => json(ok(recorded({}, { revision: 4 })))).progress(write, binding)).resolves.toMatchObject({ reply: { outcome: { outcome: 'recorded' } } });
  });
  it('a command for a course other than the bound one never leaves', async () => {
    const fetchImpl = vi.fn(async () => json(ok(recorded())));
    const t = transport(fetchImpl as unknown as typeof fetch);
    await expect(t.progress(write, { ...binding, curriculum: { ...curriculum, version: 2 } })).rejects.toMatchObject({ reason: 'invalid' });
    await expect(t.progress(write, { ...binding, enrollmentId: null })).rejects.toMatchObject({ reason: 'invalid' });
    await expect(t.progress({ action: 'read', entitlementId: '7e1a0000-0000-4000-8000-0000000000e9' }, binding)).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
