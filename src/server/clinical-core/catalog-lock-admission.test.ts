import { describe, expect, it } from 'vitest';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { CatalogForwardUpgradeError } from './catalog-forward-upgrade';
import { qualifyCatalogLockAdmission } from './catalog-lock-admission';

// This fictional transport tests orchestration and failure cleanup only. It
// is deliberately not evidence of an Aurora wait or production acceptance.
function setup(mode = 'success') {
  let state = 'absent', identity = '', pid = 100, waiting = false, writerAlive = false, lockAlive = false;
  let commits = 0, deletes = 0, durable = false;
  const original = JSON.stringify({ review_status: 'needs_review', updated_at: 1 }), changed = JSON.stringify({ review_status: 'needs_review', updated_at: 2 });
  const events: string[] = [], statements: string[] = [];
  const db: ClinicalCoreDatabase = { transaction: async work => {
    const ownPid = ++pid; let wrote = false;
    const tx: ClinicalCoreTransaction = { query: async <Row extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) => {
      statements.push(sql); let rows: Record<string, unknown>[] = [];
      if (sql === 'select current_database() as name') rows = [{ name: 'clinical_core' }];
      else if (sql === 'select pg_backend_pid() pid') rows = [{ pid: ownPid }];
      else if (sql.startsWith('select stable_id from')) rows = mode === 'collision' ? [{ stable_id: 'existing' }] : [];
      else if (sql.startsWith('insert into')) { state = 'original'; identity = String(args![0]); rows = [{ original, changed }]; }
      else if (sql.startsWith('update clinical_reference')) {
        expect(durable).toBe(true); expect(args).toEqual([identity, original]);
        writerAlive = true; wrote = true;
        rows = mode === 'wrong_writer' ? [] : [{ changed }];
      } else if (sql.startsWith('select exists(select 1 from pg_locks')) {
        rows = [{ waiting: mode === 'no_wait' ? false : waiting }];
        if (mode === 'monitor_failure') throw Error('fictional monitor refused');
      } else if (sql.startsWith('lock table ')) {
        waiting = true; lockAlive = true;
        const deadline = Date.now() + 4500;
        while (writerAlive && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
        waiting = false; lockAlive = false;
      } else if (sql.startsWith('delete from')) {
        expect(writerAlive).toBe(false); expect(lockAlive).toBe(false);
        expect(sql).toContain('not exists(select 1 from clinical_reference.knowledge_source_versions');
        expect(args).toEqual([identity, original, changed]);
        if (mode !== 'cleanup_denied') { state = 'absent'; deletes++; rows = [{ stable_id: identity }]; }
      }
      return { rows: rows as Row[] };
    } };
    try {
      const result = await work(tx);
      if (wrote) { writerAlive = false; if (mode === 'commit_failure') throw Error('ambiguous fictional commit'); state = 'changed'; commits++; }
      return result;
    } catch (error) { if (wrote) writerAlive = false; throw error; }
  } };
  const inspect = async () => ({ referenceMigrationCount: 2, alreadyApplied: false, rowCount: state === 'absent' ? 10 : 11,
    preservedSchemaSha256: 'a'.repeat(64), observationSha256: state === 'absent' ? 'b'.repeat(64) : state === 'original' ? 'c'.repeat(64) : 'd'.repeat(64) });
  const migrate = (database: ClinicalCoreDatabase, witness: string) => database.transaction(async tx => {
    await tx.query('set transaction isolation level read committed');
    await tx.query('set local row_security=off');
    await tx.query('lock table clinical_reference.knowledge_sources in share row exclusive mode');
    expect((await inspect()).observationSha256).not.toBe(witness);
    if (mode === 'wrong_refusal') throw new CatalogForwardUpgradeError('upgrade_busy');
    if (mode !== 'missed_change') throw new CatalogForwardUpgradeError('observation_changed', 'before_fingerprint');
  });
  const dependencies = { verifyCustody: () => {}, record: (stage: string) => { events.push(stage); },
    persistFixture: (f: { stableId: string; original: string; changed: string }) => {
      expect(f).toEqual({ stableId: identity, original, changed }); durable = true;
    } };
  return { run: () => qualifyCatalogLockAdmission(db, inspect, migrate, dependencies), events, statements,
    state: () => ({ state, commits, deletes, writerAlive, lockAlive }) };
}
describe('fictional lock qualification orchestration, not a hosted acceptance claim', () => {
  it('admits only a durable unapproved fixture, observes waiting before commit, refuses the changed witness and restores the original inventory', async () => {
    const f = setup(), result = await f.run();
    expect(result).toMatchObject({ realLockWaitObserved: true, competingCommitVerified: true, changedWitnessRefused: true,
      workersSettled: true, fixtureRemoved: true, lastingApplyPerformed: false, hostedAcceptance: false, phiAllowed: false });
    expect(result.writerPid).not.toBe(result.migrationPid); expect(result.after).toEqual(result.before);
    expect(f.events).toEqual(['catalog_lock_fixture_admitted', 'catalog_lock_writer_admitted', 'catalog_lock_wait_observed',
      'catalog_lock_refusal_verified', 'catalog_lock_cleanup_admitted', 'catalog_lock_cleanup_verified']);
    expect(f.state()).toEqual({ state: 'absent', commits: 1, deletes: 1, writerAlive: false, lockAlive: false });
    expect(f.statements.some(sql => /^(create|alter|drop)/.test(sql))).toBe(false);
  });
  for (const mode of ['wrong_writer', 'monitor_failure', 'commit_failure', 'wrong_refusal', 'missed_change']) {
    it(`never certifies ${mode}, and waits for all admitted workers before exact cleanup`, async () => {
      const f = setup(mode); await expect(f.run()).rejects.toThrow();
      expect(f.state()).toMatchObject({ state: 'absent', deletes: 1, writerAlive: false, lockAlive: false });
      expect(f.events).not.toContain('catalog_lock_cleanup_verified');
    });
  }
  it('does not remove a preexisting random-key collision', async () => {
    const f = setup('collision'); await expect(f.run()).rejects.toThrow('fixture_collision');
    expect(f.state()).toMatchObject({ state: 'absent', commits: 0, deletes: 0 });
  });
  it('never accepts a denied exact cleanup', async () => {
    const f = setup('cleanup_denied'); await expect(f.run()).rejects.toThrow('fixture_cleanup');
    expect(f.state()).toMatchObject({ state: 'changed', deletes: 0 });
    expect(f.events).not.toContain('catalog_lock_cleanup_verified');
  });
  it('does not substitute a sleep or a request flag for a real observed wait', async () => {
    const f = setup('no_wait'); await expect(f.run()).rejects.toThrow('real_lock_wait_not_observed');
    expect(f.state()).toMatchObject({ state: 'absent', commits: 0, deletes: 1 });
  }, 10000);
});
