import { describe, expect, it, vi } from 'vitest';
import { createLearnerController, type LearnerSnapshot } from './learnerController';
import { LearnerTransportError, type LearnerTransport } from './learnerTransport';

/**
 * My courses' lifecycle (hardening WP2) over a fictional transport: what is shown, and when it is
 * dropped. Revoked access while a read or save is pending, stale answers, an outage, two tabs on one
 * account, a change of account, and outlines that cannot name their lessons. Fictional values only.
 */
const subject = 'sub:fictional-learner-a';
const entitlementId = '7e1a0000-0000-4000-8000-0000000000f1', enrollmentId = '7e1a0000-0000-4000-8000-0000000000f2';
const curriculum = { versionId: '7e1a0000-0000-4000-8000-0000000000f3', version: 1, sourceDigest: 'd'.repeat(64) };
const entitlement = (over: Record<string, unknown> = {}) => ({ contract: 'program-education-access/1', entitlementId, orderId: '7e1a0000-0000-4000-8000-0000000000f4', organizationId: '7e1a0000-0000-4000-8000-0000000000f5', programId: '7e1a0000-0000-4000-8000-0000000000f6', offerId: '7e1a0000-0000-4000-8000-0000000000f7', offerRevision: 1,
  curriculum, accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30, subject: { kind: 'claimed', consumerSubject: subject, claimedAt: '2026-10-12T00:00:00Z' }, state: 'active', revision: 2,
  window: { startsAt: '2026-10-12T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' }, settlement: { verificationEventId: null, settledAt: '2026-10-12T00:00:00Z' }, policy: null, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', ...over });
const enrollment = { enrollmentId, entitlementId, consumerSubject: subject, curriculum, state: 'active', revision: 1, phaseIndex: 0, startedAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
const view = (over: Record<string, unknown> = {}) => ({ contract: 'program-education-access/1', consumerSubject: subject, readAt: '2026-10-12T00:00:00Z', entitlements: [entitlement()], enrollments: [enrollment], ...over });
const item = (id: string, kind = 'lesson') => ({ id, title: 'Fictional ' + id, kind, instructions: 'Fictional private text of ' + id + '.', released: true });
const phases = [{ id: 'phase-1', title: 'Fictional phase one', items: [item('lesson-a'), item('habit-b', 'habit')] }, { id: 'phase-2', title: 'Fictional phase two', items: [item('lesson-c')] }];
const served = (shape: unknown[] = phases) => ({ outcome: 'served', entitlementId, curriculum, title: 'Fictional course', phases: shape });
const lessonA = { phaseId: 'phase-1', itemId: 'lesson-a' }, habitB = { phaseId: 'phase-1', itemId: 'habit-b' };
const progress = (over: Record<string, unknown> = {}) => ({ contract: 'program-education-progress/1', entitlementId, enrollmentId, curriculum, revision: 0, completed: [] as unknown[], position: null, updatedAt: null, ...over });
const done = (lesson: typeof lessonA, requestId: string) => ({ lesson, completedAt: '2026-10-12T00:00:00Z', requestId });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let ids = 0;
const requestId = () => `7e1a0000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

function harness(transport: Partial<Record<keyof LearnerTransport, ReturnType<typeof vi.fn>>> = {}) {
  const t = { access: vi.fn(async () => ({ view: view(), host: 'reviewed' as const })), curriculum: vi.fn(async () => ({ read: served(), host: 'reviewed' as const })), progress: vi.fn(async () => ({ reply: { action: 'read', read: { outcome: 'read', progress: progress() } }, host: 'reviewed' as const })), ...transport };
  let last: LearnerSnapshot | null = null;
  const controller = createLearnerController({ transport: t as unknown as LearnerTransport, requestId, onChange: snapshot => { last = snapshot; } });
  const text = () => JSON.stringify(last);
  return { t, controller, state: () => last!, text };
}
async function opened(h: ReturnType<typeof harness>) {
  await h.controller.start();
  await h.controller.open(entitlementId);
  return h;
}

describe('nothing is shown that the service has not answered for this learner', () => {
  it('without a host, the page says so and holds nothing; an outage is not "no courses"', async () => {
    const none = harness({ access: vi.fn(async () => { throw new LearnerTransportError('host_unavailable'); }) });
    await none.controller.start();
    expect(none.state()).toMatchObject({ phase: 'host_unavailable', view: null, course: null });
    const down = harness({ access: vi.fn(async () => { throw new LearnerTransportError('unavailable'); }) });
    await down.controller.start();
    expect(down.state()).toMatchObject({ phase: 'unavailable', view: null });
    expect(down.state().error).toContain('does not mean you have none');
  });
  it('reads progress bound to the entitlement, its one enrollment and the purchased pin', async () => {
    const h = await opened(harness());
    expect(h.t.curriculum).toHaveBeenCalledWith(entitlementId, curriculum);
    expect(h.t.progress).toHaveBeenCalledWith({ action: 'read', entitlementId }, { entitlementId, enrollmentId, curriculum });
    expect(h.state().progress).toMatchObject({ state: 'ready' });
  });
  it('an unreadable progress is said as such, never as nothing completed', async () => {
    const h = await opened(harness({ progress: vi.fn(async () => { throw new LearnerTransportError('unavailable'); }) }));
    expect(h.state().progress).toEqual({ state: 'unavailable' });
    expect(h.state().course).not.toBeNull();
  });
});

describe('revoked access while a read or a save is pending', () => {
  it('a save whose answer is a sign-in refusal drops the course, the lesson text and the pending save', async () => {
    const h = await opened(harness());
    await h.controller.goTo(lessonA);
    const save = deferred<unknown>();
    h.t.progress.mockImplementationOnce(() => save.promise);
    const pending = h.controller.complete(lessonA);
    expect(h.state().pending).toMatchObject({ state: 'saving' });
    save.reject(new LearnerTransportError('signin'));
    await pending;
    expect(h.state()).toMatchObject({ phase: 'signin', view: null, course: null, outline: null, lesson: null, pending: null });
    expect(h.text()).not.toContain('Fictional private text');
  });
  it('a curriculum read refused for access drops everything and says access changed', async () => {
    const h = harness({ curriculum: vi.fn(async () => { throw new LearnerTransportError('access'); }) });
    await h.controller.start();
    await h.controller.open(entitlementId);
    expect(h.state()).toMatchObject({ phase: 'signin', view: null, course: null });
    expect(h.state().error).toContain('Access changed');
  });
});

describe('stale answers commit nothing', () => {
  it('a save superseded by returning to the tab is discarded; the page shows what the service has now', async () => {
    const h = await opened(harness());
    const save = deferred<unknown>();
    h.t.progress.mockImplementationOnce(() => save.promise);
    const pending = h.controller.complete(lessonA);
    // Back on the tab: access, the course and progress are read again; the service has the save already.
    h.t.progress.mockResolvedValueOnce({ reply: { action: 'read', read: { outcome: 'read', progress: progress({ revision: 1, completed: [done(lessonA, 'x')] }) } }, host: 'reviewed' });
    h.t.progress.mockResolvedValueOnce({ reply: { action: 'read', read: { outcome: 'read', progress: progress({ revision: 1, completed: [done(lessonA, 'x')] }) } }, host: 'reviewed' });
    await h.controller.resume();
    // The superseded answer arrives late, claiming something else; it is never applied.
    save.resolve({ reply: { action: 'complete', outcome: { outcome: 'recorded', receipt: { requestId: 'late', action: 'complete', lesson: habitB, recordedAt: '2026-10-12T00:00:00Z', revision: 9 }, progress: progress({ revision: 9, completed: [done(habitB, 'late')] }) } }, host: 'reviewed' });
    await pending;
    expect(h.state().progress).toMatchObject({ state: 'ready', progress: { revision: 1, completed: [{ lesson: lessonA }] } });
    expect(h.state().pending).toBeNull();
  });
  it('opening another course drops the first before the second is read, and a late answer for the first is discarded', async () => {
    const other = '7e1a0000-0000-4000-8000-0000000000e9';
    const h = harness({ access: vi.fn(async () => ({ view: view({ entitlements: [entitlement(), entitlement({ entitlementId: other })] }), host: 'reviewed' as const })) });
    await h.controller.open(entitlementId); // before any access view: nothing happens
    expect(h.t.curriculum).not.toHaveBeenCalled();
    await h.controller.start();
    await h.controller.open(entitlementId);
    expect(h.state().course?.entitlement.entitlementId).toBe(entitlementId);
    const slow = deferred<unknown>();
    h.t.curriculum.mockImplementationOnce(() => slow.promise);
    const second = h.controller.open(other);
    expect(h.state().course).toBeNull();
    expect(h.text()).not.toContain('Fictional private text');
    slow.resolve({ read: { ...served(), entitlementId: other }, host: 'reviewed' });
    await second;
    expect(h.state().course?.entitlement.entitlementId).toBe(other);
  });
  it('an access view for a different account starts over instead of mixing two accounts', async () => {
    const h = await opened(harness());
    h.t.access.mockResolvedValueOnce({ view: view({ consumerSubject: 'sub:fictional-learner-b', entitlements: [], enrollments: [] }), host: 'reviewed' });
    await h.controller.refresh();
    expect(h.state()).toMatchObject({ view: null, course: null });
    expect(h.state().error).toContain('different account');
  });
});

describe('two tabs on one account', () => {
  it('the tab that is behind is shown the saved progress, never a merge', async () => {
    // One fictional service shared by both tabs: revision-checked like the real ledger.
    let saved = progress();
    const serviceProgress = vi.fn(async (command: { action: string; lesson?: typeof lessonA; expectedRevision?: number; requestId?: string }) => {
      if (command.action === 'read') return { reply: { action: 'read', read: { outcome: 'read', progress: saved } }, host: 'reviewed' };
      if (command.expectedRevision !== saved.revision) return { reply: { action: command.action, outcome: { outcome: 'refused', reason: 'revision_stale', progress: saved } }, host: 'reviewed' };
      const revision = saved.revision + 1;
      saved = progress({ revision, completed: command.action === 'complete' ? [...saved.completed, done(command.lesson!, command.requestId!)] : saved.completed, position: command.action === 'position' ? command.lesson : saved.position });
      return { reply: { action: command.action, outcome: { outcome: 'recorded', receipt: { requestId: command.requestId, action: command.action, lesson: command.lesson, recordedAt: '2026-10-12T00:00:00Z', revision }, progress: saved } }, host: 'reviewed' };
    });
    const first = await opened(harness({ progress: serviceProgress }));
    const second = await opened(harness({ progress: serviceProgress }));
    await first.controller.complete(lessonA);
    expect(first.state().notice).toContain('Saved for this account');
    await second.controller.complete(habitB);
    expect(second.state().notice).toContain('updated in another tab');
    expect(second.state().progress).toMatchObject({ state: 'ready', progress: { revision: 1, completed: [{ lesson: lessonA }] } });
    expect(saved.completed).toHaveLength(1);
  });
});

describe('an outline that cannot name its lessons offers nothing to save', () => {
  it('ambiguous or oversized: no position and no completion is sent', async () => {
    for (const shape of [[phases[0], { ...phases[1], items: [item('lesson-a')] }], Array.from({ length: 53 }, (_, i) => ({ id: `p${i}`, title: 'x', items: [item(`i${i}`)] }))]) {
      const h = harness({ curriculum: vi.fn(async () => ({ read: served(shape), host: 'reviewed' as const })) });
      await opened(h);
      expect(h.state().outline?.lessons).toEqual([]);
      const before = h.t.progress.mock.calls.length;
      await h.controller.goTo(lessonA);
      await h.controller.complete(lessonA);
      expect(h.t.progress.mock.calls.length).toBe(before);
    }
  });
});
