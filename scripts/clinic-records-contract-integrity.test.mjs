import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Cross-repository pins. expo/contracts/clinicRecordRequests.ts and
 * expo/contracts/fixtures/clinic-record-copy-lab-item.json in
 * AI_LONGEVITY_PRO_V2 are byte-identical mirrors of these two files, and the V2
 * suite (__tests__/clinic-records-contract-pins.test.ts) pins the SAME hashes.
 * The fixture is what the real 114 reader produced in embedded PostgreSQL
 * (clinic-record-privacy.database.test.ts regenerates and compares it).
 */
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const CONTRACT = '6aee143699f30a14ee29bbf3959c8437bba82e3c497b0abc5ebba5d651daeae8';
const FIXTURE = '93282cac82419619c27b39bd18cfa1fa3192cd712518df87bf6296db5ea818f0';
test('the contract module and the PostgreSQL copy-item fixture carry the pinned bytes', () => {
  assert.equal(sha('src/contracts/clinicRecordRequests.ts'), CONTRACT);
  assert.equal(sha('src/contracts/fixtures/clinic-record-copy-lab-item.json'), FIXTURE);
});
test('the wire form of a copy item is the digested text, never a structured copy', () => {
  const source = readFileSync('src/contracts/clinicRecordRequests.ts', 'utf8');
  assert.match(source, /CLINIC_RECORD_REQUEST_CONTRACT = 'clinic-record-requests\/2'/);
  const item = source.slice(source.indexOf('export const clinicRecordCopyItem'), source.indexOf('}).strict();', source.indexOf('export const clinicRecordCopyItem')));
  assert.match(item, /payloadText: z\.string\(\)/); assert.match(item, /payloadSha256: hash/); assert.match(item, /byteLength: z\.number\(\)/);
  assert.doesNotMatch(item, /\bpayload: /);
  const fixture = JSON.parse(readFileSync('src/contracts/fixtures/clinic-record-copy-lab-item.json', 'utf8'));
  assert.equal(createHash('sha256').update(fixture.payloadText, 'utf8').digest('hex'), fixture.payloadSha256);
  assert.equal(Buffer.byteLength(fixture.payloadText, 'utf8'), fixture.byteLength);
  assert.match(fixture.payloadText, /"valueNumeric": 1\.20/); assert.match(fixture.payloadText, /"referenceMin": 0\.0000001/);
  // The SQL reader returns the stored text under the same key the contract names.
  const sql = readFileSync('infra/aws-clinical-core/production-candidates/clinic-record-privacy.sql', 'utf8');
  assert.match(sql, /'payloadText',_item\.payload_text/); assert.doesNotMatch(sql, /'payload',_item\.payload\b/);
});
