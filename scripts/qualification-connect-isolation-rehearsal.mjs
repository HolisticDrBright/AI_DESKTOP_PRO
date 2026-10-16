/** Source-only rollback rehearsal core. No CLI and no commit path. */
import { createHash } from 'node:crypto';

const APPLY_SHA256 = '28e0d4bd1dc30f0abb6732ec44250f480844662a440e8461091735c8d53621f8';
const DATABASES = Object.freeze([
  'alp_chat_rls_synthetic_v1', 'clinical_core', 'clinical_core_qualification', 'postgres',
]);
const refuse = reason => { throw new Error(`qualification_connect_rehearsal_refused:${reason}`); };
const check = (condition, reason) => { if (!condition) refuse(reason); };
const normalized = value => String(value).replace(/\r\n/g, '\n');
const stripComments = statement => statement.replace(/--[^\r\n]*/g, '').trim().toLowerCase();

export function connectIsolationStatements(sql, splitPostgresStatements) {
  check(typeof sql === 'string' && typeof splitPostgresStatements === 'function', 'source');
  check(createHash('sha256').update(normalized(sql)).digest('hex') === APPLY_SHA256, 'sql_hash');
  const statements = splitPostgresStatements(sql);
  check(statements.length >= 6 && stripComments(statements[0]) === 'begin'
    && stripComments(statements.at(-1)) === 'commit', 'transaction_delimiters');
  const interior = statements.slice(1, -1);
  check(interior.every(statement => !['begin', 'commit', 'rollback'].includes(stripComments(statement))),
  'nested_transaction');
  check(interior.some(statement => /revoke connect on database alp_chat_rls_synthetic_v1/i.test(statement))
    && interior.some(statement => /grant connect on database clinical_core_qualification/i.test(statement))
    && interior.some(statement => /qualification_connect_verification_failed/i.test(statement)),
  'candidate_incomplete');
  return interior;
}

function assertSnapshot(snapshot, state, custody) {
  check(snapshot?.grantState === state && snapshot.phiAllowed === false
    && snapshot.productionActivation === 'blocked'
    && snapshot.programLoginActive === false
    && Array.isArray(snapshot.databases) && snapshot.databases.length === DATABASES.length
    && snapshot.databases.every((database, index) => database === DATABASES[index])
    && /^[a-f0-9]{64}$/.test(snapshot.custodySha256 ?? '')
    && /^[a-f0-9]{64}$/.test(snapshot.aclSha256 ?? '')
    && (custody === undefined || snapshot.custodySha256 === custody),
  'snapshot_drift');
}

/**
 * Inject an exact-source, target-bound RDS client only after separate approval.
 * This function can only roll back. Its caller must bind inspect() to the same
 * transaction id and compare the full four-database ACL digest afterward.
 */
export async function rehearseConnectIsolation({ sql, splitPostgresStatements,
  begin, execute, inspect, rollback }) {
  check([begin, execute, inspect, rollback].every(value => typeof value === 'function'), 'interface');
  const statements = connectIsolationStatements(sql, splitPostgresStatements);
  const before = await inspect();
  assertSnapshot(before, 'default');
  let transactionId;
  let rolledBack = false;
  try {
    transactionId = await begin();
    check(typeof transactionId === 'string' && transactionId.length > 0, 'transaction_missing');
    await execute("set local statement_timeout = '5s'", transactionId);
    for (const statement of statements) await execute(statement, transactionId);
    const inside = await inspect(transactionId);
    assertSnapshot(inside, 'isolated', before.custodySha256);
    check(inside.aclSha256 !== before.aclSha256, 'grant_not_changed');
    await rollback(transactionId);
    rolledBack = true;
    const after = await inspect();
    assertSnapshot(after, 'default', before.custodySha256);
    check(after.aclSha256 === before.aclSha256, 'rollback_acl_mismatch');
    return { rehearsalRolledBack: true, committed: false,
      custodySha256: before.custodySha256, beforeAclSha256: before.aclSha256 };
  } catch (error) {
    if (transactionId && !rolledBack) {
      try { await rollback(transactionId); }
      catch { refuse('rollback_outcome_uncertain_manual_inspection_required'); }
      const after = await inspect();
      assertSnapshot(after, 'default', before.custodySha256);
      check(after.aclSha256 === before.aclSha256, 'rollback_acl_mismatch');
    }
    throw error;
  }
}
