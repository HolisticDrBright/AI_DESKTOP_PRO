/** Complete row witness primitive for the preserving operator. This does not
 * authorize the database transport, admit its schema or certify custody. */
import { createHash } from 'node:crypto';
import { buildClinicPreservingTransition } from './clinic-preserving-transition.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const refuse = () => { throw Error('clinic_row_preservation_refused'); };
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
const quote = value => /^[a-z][a-z0-9_]{0,62}$/.test(value) ? '"' + value + '"' : refuse();
const qualified = name => { const parts = name.split('.'); return parts.length === 2 ? parts.map(quote).join('.') : refuse(); };
const schemaNames = ['clinical_core', 'clinical_private', 'clinical_audit', 'clinical_reference',
  'commercial_reference', 'fullscript_delivery', 'clinical_telehealth'];

async function fingerprint(tx, tableNames) {
  const entries = [], maximumRows = 100000;
  for (let offset = 0; offset < tableNames.length; offset += 20) {
    const sql = tableNames.slice(offset, offset + 20).map(name => `select '${name}' table_name,count(*)::int row_count,
      encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') sha256
      from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') row_hash
      from ${qualified(name)} t limit ${maximumRows + 1}) bounded`).join('\nunion all\n');
    if (Buffer.byteLength(sql) > 20000) refuse();
    entries.push(...(await tx.query(sql)).rows);
  }
  entries.sort((a, b) => a.table_name < b.table_name ? -1 : a.table_name > b.table_name ? 1 : 0);
  if (entries.length !== tableNames.length || entries.some((r, i) => keys(r) !== 'row_count,sha256,table_name'
    || r.table_name !== tableNames[i] || !Number.isSafeInteger(r.row_count) || r.row_count < 0 || r.row_count > maximumRows
    || !/^[a-f0-9]{64}$/.test(r.sha256))) refuse();
  return { rows: entries.reduce((n, r) => n + r.row_count, 0), sha256: sha(JSON.stringify(entries)) };
}

/** Caller must use the same fenced transaction as the eventual upgrade. The
 * witness labels intentionally cannot be mistaken for operator acceptance. */
export async function readClinicHistoricalRowWitness(tx, artifact, sourceReceipt) {
  const plan = buildClinicPreservingTransition(artifact, sourceReceipt), p = plan.preservation;
  await tx.query('set local row_security=off');
  const rls = (await tx.query("select current_setting('row_security')::text value")).rows;
  if (rls.length !== 1 || keys(rls[0]) !== 'value' || rls[0].value !== 'off') refuse();
  const ledger = (await tx.query('select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"')).rows;
  if (![112, 116].includes(ledger.length) || ledger.some((r, i) => keys(r) !== 'name,sha256,version'
    || r.version !== artifact.manifest.migrations[i].version || r.name !== artifact.manifest.migrations[i].file.slice(15, -4)
    || r.sha256 !== sha(artifact.files[artifact.manifest.migrations[i].file]))) refuse();
  const expectedNames = [...p.historicalTableNames, ...(ledger.length === 116 ? p.newTableNames : []), p.ledgerTable].sort();
  const inventory = (await tx.query(`select n.nspname||'.'||c.relname table_name,c.relkind::text kind
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in(select jsonb_array_elements_text($1::jsonb)) and c.relkind in('r','p','f')
    order by (n.nspname||'.'||c.relname) collate "C"`, [JSON.stringify(schemaNames)])).rows;
  if (inventory.length !== expectedNames.length || inventory.some((r, i) => keys(r) !== 'kind,table_name'
    || r.kind !== 'r' || r.table_name !== expectedNames[i])) refuse();
  const data = await fingerprint(tx, p.historicalTableNames);
  const receipts = (await tx.query(`select count(*)::int row_count,
    encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by version),'[]'::jsonb)::text,'UTF8')),'hex') sha256
    from clinical_core.schema_migrations r where version<=$1`, [artifact.manifest.migrations[111].version])).rows;
  if (receipts.length !== 1 || keys(receipts[0]) !== 'row_count,sha256' || receipts[0].row_count !== 112
    || !/^[a-f0-9]{64}$/.test(receipts[0].sha256)) refuse();
  const newRows = ledger.length === 116 ? (await fingerprint(tx, p.newTableNames)).rows : 0;
  if (newRows !== 0) refuse();
  return { contract: 'clinic-historical-row-witness/1', evidenceLayer: 'row_witness_primitive_only', sourceOnly: true,
    observedMigrationCount: ledger.length, historicalTableCount: 217, historicalRowCount: data.rows,
    historicalDataSha256: data.sha256, historicalReceiptsSha256: receipts[0].sha256, newRows,
    schemaAdmissionProven: false, operatorAcceptance: false, custodyProven: false, managedRoleSemanticsVerified: false,
    phiAllowed: false, activation: 'blocked' };
}

export function assertClinicHistoricalRowsPreserved(before, after) {
  const expected = 'activation,contract,custodyProven,evidenceLayer,historicalDataSha256,historicalReceiptsSha256,historicalRowCount,historicalTableCount,managedRoleSemanticsVerified,newRows,observedMigrationCount,operatorAcceptance,phiAllowed,schemaAdmissionProven,sourceOnly';
  for (const value of [before, after]) if (keys(value) !== expected || value.contract !== 'clinic-historical-row-witness/1'
    || value.evidenceLayer !== 'row_witness_primitive_only' || value.sourceOnly !== true || value.activation !== 'blocked'
    || value.phiAllowed !== false || value.historicalTableCount !== 217 || value.newRows !== 0
    || !Number.isSafeInteger(value.historicalRowCount) || value.historicalRowCount < 0
    || !/^[a-f0-9]{64}$/.test(value.historicalDataSha256) || !/^[a-f0-9]{64}$/.test(value.historicalReceiptsSha256)
    || ['schemaAdmissionProven', 'operatorAcceptance', 'custodyProven', 'managedRoleSemanticsVerified'].some(k => value[k] !== false)) refuse();
  if (before.observedMigrationCount !== 112 || after.observedMigrationCount !== 116
    || before.historicalRowCount !== after.historicalRowCount || before.historicalDataSha256 !== after.historicalDataSha256
    || before.historicalReceiptsSha256 !== after.historicalReceiptsSha256) refuse();
}
