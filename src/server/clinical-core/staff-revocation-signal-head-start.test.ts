import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ClinicalCoreDatabase } from './database';
import { PENDING_HEAD_START_DECISION, withPendingHeadStart } from './staff-revocation-signal-head-start';
import type { StaffRevocationSignalPublisher } from './workforce-identity-revocation';

/**
 * The bounded head start (an OWNER DECISION, not taken): how long the operator host may wait for the pending signal
 * before the clinical decision's transaction begins. It exists so the decision can be taken with its effect measured,
 * not so it is on: nothing outside tests constructs it, and it has no default duration. Fictional parts only.
 */
function parts() {
  const events: string[] = [];
  let settle!: (outcome: 'ok' | 'fail') => void;
  const signal: StaffRevocationSignalPublisher = {
    publish: async () => { events.push('publish'); },
    hold: () => new Promise<void>((resolve, reject) => { events.push('hold'); settle = outcome => (outcome === 'ok' ? resolve() : reject(new Error('fictional outage'))); }),
    release: async () => { events.push('release'); },
  };
  const database: ClinicalCoreDatabase = { transaction: async work => { events.push('transaction'); return work({ query: async () => ({ rows: [] }) }); } };
  let wake!: () => void;
  const sleeps: number[] = [];
  const sleep = (ms: number) => { sleeps.push(ms); events.push('sleep'); return new Promise<void>(resolve => { wake = resolve; }); };
  return { events, signal, database, sleep, sleeps, settle: (o: 'ok' | 'fail') => settle(o), wake: () => wake() };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the pending head start is an owner decision with no default', () => {
  it('the decision is recorded as not taken, with the proposed duration and its ceiling', () => {
    expect(PENDING_HEAD_START_DECISION).toEqual({ status: 'owner_decision_required', proposedMs: 250, maxMs: 1000 });
  });

  it('refuses to be built without an explicit duration from 1 to 1000 ms', () => {
    const { signal, database } = parts();
    for (const headStartMs of [undefined, 0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withPendingHeadStart({ signal, database, headStartMs: headStartMs as number }), String(headStartMs)).toThrow('pending_head_start_invalid');
    }
  });

  it('nothing outside its own file and tests constructs it', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(path); } };
    walk('src');
    const constructing = files.filter(f => !/\.test\.(ts|tsx)$/.test(f) && !f.endsWith('staff-revocation-signal-head-start.ts') && readFileSync(f, 'utf8').includes('withPendingHeadStart('));
    expect(constructing).toEqual([]);
  });
});

describe('configured (in tests only), it bounds the wait for the pending write', () => {
  it('a pending write that lands first ends the wait: the transaction begins before the head start runs out', async () => {
    const p = parts();
    const wrapped = withPendingHeadStart({ signal: p.signal, database: p.database, headStartMs: 250, sleep: p.sleep });
    const hold = wrapped.signal.hold('fictional-subject-0001', '0e000000-0000-4000-8000-000000000001');
    const work = wrapped.database.transaction(async () => 'done');
    await tick();
    expect(p.events).toEqual(['hold', 'sleep']);
    p.settle('ok');
    expect(await work).toBe('done');
    await hold;
    expect(p.events).toEqual(['hold', 'sleep', 'transaction']);
    expect(p.sleeps).toEqual([250]);
  });

  it('a pending write that never answers holds the transaction for the head start alone', async () => {
    const p = parts();
    const wrapped = withPendingHeadStart({ signal: p.signal, database: p.database, headStartMs: 250, sleep: p.sleep });
    void wrapped.signal.hold('fictional-subject-0001', '0e000000-0000-4000-8000-000000000001');
    const work = wrapped.database.transaction(async () => 'done');
    await tick();
    expect(p.events).toEqual(['hold', 'sleep']);
    p.wake();
    expect(await work).toBe('done');
    expect(p.events).toEqual(['hold', 'sleep', 'transaction']);
  });

  it('a pending write that fails ends the wait at once, and its failure stays the caller\'s', async () => {
    const p = parts();
    const wrapped = withPendingHeadStart({ signal: p.signal, database: p.database, headStartMs: 250, sleep: p.sleep });
    const hold = wrapped.signal.hold('fictional-subject-0001', '0e000000-0000-4000-8000-000000000001');
    const work = wrapped.database.transaction(async () => 'done');
    await tick();
    p.settle('fail');
    expect(await work).toBe('done');
    await expect(hold).rejects.toThrow('fictional outage');
  });

  it('with no pending write in flight there is no wait at all, and publish and release pass straight through', async () => {
    const p = parts();
    const wrapped = withPendingHeadStart({ signal: p.signal, database: p.database, headStartMs: 250, sleep: p.sleep });
    expect(await wrapped.database.transaction(async () => 'done')).toBe('done');
    await wrapped.signal.publish('fictional-subject-0001', '0e000000-0000-4000-8000-000000000001');
    await wrapped.signal.release('fictional-subject-0001', '0e000000-0000-4000-8000-000000000001');
    expect(p.events).toEqual(['transaction', 'publish', 'release']);
    expect(p.sleeps).toEqual([]);
  });
});
