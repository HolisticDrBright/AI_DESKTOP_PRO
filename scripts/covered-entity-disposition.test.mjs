import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {immutableDispositionErrors} from './covered-entity-disposition.mjs';

const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
  {encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
const sql = Object.values(artifact.files).join('\n');
const coverage = JSON.parse(readFileSync('infra/aws-clinical-core/covered-entity-coverage.json', 'utf8'));

test('shipped metadata covers every scoped immutable table in the real canonical SQL', () => {
  assert.deepEqual(immutableDispositionErrors(sql, coverage.tables), []);
  const pending = coverage.tables.filter(entry => entry.appendOnly === true);
  assert.equal(pending.length, 44);
  for (const entry of pending) {
    const omitted = coverage.tables.map(row => row === entry ? {...row, appendOnly:undefined, disposition:undefined} : row);
    assert.ok(immutableDispositionErrors(sql, omitted).some(message => message.startsWith(entry.table)), entry.table);
  }
});

test('missing, false, malformed, oversized and retained disposition flags cannot pass', () => {
  const table = 'clinical_core.fictional';
  const trigger = `CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON ${table}\nFOR EACH ROW EXECUTE FUNCTION clinical_private.block_update_delete( );`;
  const base = {table, scope:'organization_column', column:'organization_id'};
  for (const metadata of [{}, {appendOnly:false}, {appendOnly:'true'}, {appendOnly:true},
    {appendOnly:true, disposition:'short'}, {appendOnly:true, disposition:'x'.repeat(2001)},
    {disposition:'A separately reviewed disposition is required.'}]) {
    assert.ok(immutableDispositionErrors(trigger, [{...base,...metadata}]).length > 0);
  }
  const valid = {...base, appendOnly:true, disposition:'A separately reviewed disposition is required.'};
  assert.deepEqual(immutableDispositionErrors(trigger, [valid]), []);
  assert.ok(immutableDispositionErrors(trigger, [{...valid, scope:'retained'}]).length > 0);
});

test('future recovery request and event mappings retain pending disposition', () => {
  const overlay = readFileSync('infra/aws-clinical-core/production-candidates/care-claim-recovery.sql', 'utf8');
  for (const table of ['clinical_core.care_claim_requests','clinical_audit.care_claim_events']) {
    assert.ok(immutableDispositionErrors(overlay, [{table,scope:'organization_column'}]).length > 0);
  }
});
