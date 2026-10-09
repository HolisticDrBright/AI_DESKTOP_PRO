if (typeof window !== 'undefined') throw new Error('catalog-lock-admission is server-only');
import { randomBytes } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { CatalogForwardInspectionBuild, CatalogForwardInspectionDependencies } from './catalog-forward-inspection-command';
import { executeCatalogForwardInspectionCommand } from './catalog-forward-inspection-command';
import { CatalogForwardUpgradeError, runCatalogForwardUpgrade } from './catalog-forward-upgrade';
import { careErasureUpgradeFromAws } from './care-erasure-schema-upgrade';

type Fixture = { stableId: string; original: string; changed: string };
export const catalogLockFixtureSql = Object.freeze({
  create: `insert into clinical_reference.knowledge_sources as t(stable_id,environment)
    values($1,'synthetic-staging') returning to_jsonb(t)::text original,
    (to_jsonb(t)||jsonb_build_object('updated_at',t.updated_at+interval '1 second'))::text changed`,
  update: `update clinical_reference.knowledge_sources as t
    set updated_at=updated_at+interval '1 second' where stable_id=$1 and to_jsonb(t)=$2::jsonb
    and review_status='needs_review' and active_version is null and environment='synthetic-staging'
    and contains_phi=false and data_classification='reference_only' returning to_jsonb(t)::text changed`,
  remove: `delete from clinical_reference.knowledge_sources as t
    where stable_id=$1 and (to_jsonb(t)=$2::jsonb or to_jsonb(t)=$3::jsonb)
    and review_status='needs_review' and active_version is null and environment='synthetic-staging'
    and contains_phi=false and data_classification='reference_only'
    and not exists(select 1 from clinical_reference.knowledge_source_versions v where v.source_stable_id=t.stable_id)
    returning stable_id`,
});
export type CatalogLockDependencies = CatalogForwardInspectionDependencies & {
  verifyCustody: () => void;
  record: (stage: string, details: Record<string, unknown>) => void;
  persistFixture: (fixture: Fixture) => void;
};
const refuse = (code: string): never => { throw new Error('catalog_lock_admission_refused:' + code); };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settings(tx: ClinicalCoreTransaction) {
  await tx.query('set transaction isolation level read committed');
  await tx.query("set local statement_timeout='5s'");
  await tx.query("set local lock_timeout='5s'");
  await tx.query("set local idle_in_transaction_session_timeout='15s'");
  await tx.query('set local row_security=off');
  if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== 'clinical_core') refuse('database');
}
function guarded(database: ClinicalCoreDatabase, verify: () => void): ClinicalCoreDatabase {
  return { transaction: work => { verify(); return database.transaction(tx => work({ query: (sql, args) => {
    verify(); return tx.query(sql, args);
  } })); } };
}

/** A source-only seam for failure testing; the executable port supplies the real
 * independently observed inspector and the actual preserving migration. */
export async function qualifyCatalogLockAdmission(database: ClinicalCoreDatabase, inspect: () => Promise<Record<string, unknown>>,
  migrate: (database: ClinicalCoreDatabase, witness: string) => Promise<unknown>, d: Pick<CatalogLockDependencies, 'verifyCustody' | 'record' | 'persistFixture'>) {
  const db = guarded(database, d.verifyCustody), before = await inspect();
  if (before.referenceMigrationCount !== 2 || before.alreadyApplied !== false) refuse('predecessor');
  const stableId = 'src_syn_catalog_lock_' + randomBytes(16).toString('hex');
  // Durable admission precedes the first write. This row is never approved,
  // released, versioned, made orderable, or linked to a person or product.
  d.record('catalog_lock_fixture_admitted', { stableId, observationSha256: before.observationSha256 });
  let fixture: Fixture | undefined, created = false, workersSettled = false, waitObserved = false, writerCommitted = false;
  let writerPid = 0, migrationPid = 0;
  const ready = deferred<void>(), release = deferred<boolean>();
  let writer: Promise<{ ok: boolean; error?: unknown }> | undefined;
  try {
    await db.transaction(async tx => {
      await settings(tx);
      if ((await tx.query('select stable_id from clinical_reference.knowledge_sources where stable_id=$1', [stableId])).rows.length) refuse('fixture_collision');
      const rows = (await tx.query<{ original: string; changed: string }>(catalogLockFixtureSql.create, [stableId])).rows;
      const row = rows[0];
      if (rows.length !== 1 || !row || typeof row.original !== 'string' || typeof row.changed !== 'string') refuse('fixture_receipt');
      fixture = { stableId, ...row };
      d.persistFixture(fixture); // fsync + exact readback before commit may occur
    });
    created = true;
    const admitted = await inspect();
    if (admitted.referenceMigrationCount !== 2 || admitted.rowCount !== Number(before.rowCount) + 1
      || admitted.preservedSchemaSha256 !== before.preservedSchemaSha256
      || admitted.observationSha256 === before.observationSha256 || typeof admitted.observationSha256 !== 'string') refuse('fixture_inventory');
    const row = fixture!;
    writer = db.transaction(async tx => {
      await settings(tx);
      writerPid = Number((await tx.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]?.pid);
      if (!Number.isSafeInteger(writerPid) || writerPid < 1) refuse('writer_pid');
      const changed = (await tx.query<{ changed: string }>(catalogLockFixtureSql.update, [stableId, row.original])).rows;
      if (changed.length !== 1 || changed[0].changed !== row.changed) refuse('writer_receipt');
      d.record('catalog_lock_writer_admitted', { stableId, writerPid });
      ready.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const admittedToCommit = await Promise.race([release.promise,
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 12000); })]);
        if (!admittedToCommit) refuse('writer_not_released');
      } finally { if (timer) clearTimeout(timer); }
    }).then(() => ({ ok: true }), error => { ready.reject(error); return { ok: false, error }; });
    await ready.promise;
    const migration: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: async <Row extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) => {
      // Do not query before SET TRANSACTION, which must remain the first SQL.
      if (sql === 'set local row_security=off') {
        const result = await tx.query<Row>(sql, args);
        migrationPid = Number((await tx.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]?.pid);
        if (!Number.isSafeInteger(migrationPid) || migrationPid < 1 || migrationPid === writerPid) refuse('independent_session');
        return result;
      }
      if (!sql.startsWith('lock table ')) return tx.query<Row>(sql, args);
      const locking = tx.query<Row>(sql, args).then(result => ({ ok: true as const, result }), error => ({ ok: false as const, error }));
      let lockOutcome: Awaited<typeof locking>;
      try {
        const deadline = Date.now() + 4000;
        do {
          const observed = await db.transaction(async monitor => {
            await monitor.query('set transaction read only');
            await monitor.query("set local statement_timeout='1s'");
            return (await monitor.query<{ waiting: boolean }>(`select exists(select 1 from pg_locks
              where pid=$1 and relation='clinical_reference.knowledge_sources'::regclass
              and mode='ShareRowExclusiveLock' and not granted)
              and $2::int=any(pg_blocking_pids($1::int)) waiting`, [migrationPid, writerPid])).rows[0]?.waiting;
          });
          if (observed === true) { waitObserved = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (!waitObserved) refuse('real_lock_wait_not_observed');
        d.record('catalog_lock_wait_observed', { stableId, writerPid, migrationPid });
        release.resolve(true);
        const committed = await writer!;
        if (!committed.ok) throw committed.error;
        writerCommitted = true;
      } finally {
        release.resolve(false);
        await writer!; // no writer or lock request may outlive this callback
        lockOutcome = await locking;
      }
      if (!lockOutcome.ok) throw lockOutcome.error;
      return lockOutcome.result;
    } })) };
    let refused = false;
    try { await migrate(migration, admitted.observationSha256 as string); }
    catch (error) {
      if (error instanceof CatalogForwardUpgradeError && error.category === 'observation_changed' && error.stage === 'before_fingerprint') refused = true;
      else throw error;
    }
    if (!refused || !waitObserved || !writerCommitted) refuse('migration_did_not_refuse_changed_witness');
    workersSettled = true;
    d.record('catalog_lock_refusal_verified', { stableId, category: 'observation_changed', stage: 'before_fingerprint', workersSettled });
  } finally {
    release.resolve(false);
    if (writer) await writer;
    // Cleanup is never broad or best-effort. The exact admitted row, no
    // versions, no approval and no outside changes are mandatory.
    if (fixture && created) {
      const ownedFixture = fixture;
      d.record('catalog_lock_cleanup_admitted', { stableId });
      await db.transaction(async tx => {
        await settings(tx);
        const removed = (await tx.query<{ stable_id: string }>(catalogLockFixtureSql.remove, [stableId, ownedFixture.original, ownedFixture.changed])).rows;
        if (removed.length !== 1 || removed[0].stable_id !== stableId) refuse('fixture_cleanup');
      });
    }
  }
  const after = await inspect();
  if (!equal(before, after)) refuse('original_inventory_not_restored');
  d.record('catalog_lock_cleanup_verified', { stableId, observationSha256: after.observationSha256 });
  return { contract: 'catalog-lock-admission-qualification/1' as const, before, after, stableId, writerPid, migrationPid,
    realLockWaitObserved: true, competingCommitVerified: true, changedWitnessRefused: true, workersSettled,
    fixtureRemoved: true, repeatedDatabaseReadbackVerified: true, lastingApplyPerformed: false,
    apiDeploymentPerformed: false, canonicalRegistered: false, hostedAcceptance: false, activationApproved: false, phiAllowed: false };
}

export async function executeCatalogLockAdmission(build: CatalogForwardInspectionBuild, d: CatalogLockDependencies) {
  d.verifyCustody();
  // Validate member, exact foundation, histories and artifact before writes.
  const inspect = () => executeCatalogForwardInspectionCommand(['inspect'], build, d);
  await inspect();
  const configuration = careErasureUpgradeFromAws(d.observeCaller(), d.observeFoundation());
  // Each transaction has its own transport as well as its own server session.
  // A pending LOCK must not occupy the monitor's only HTTP socket.
  return qualifyCatalogLockAdmission({ transaction: work => d.createDatabase(configuration).transaction(work) }, inspect,
    (database, witness) => runCatalogForwardUpgrade(database, d.loadCore(), d.loadReference(), d.loadCandidate(), configuration, 'rehearse', witness), d);
}
