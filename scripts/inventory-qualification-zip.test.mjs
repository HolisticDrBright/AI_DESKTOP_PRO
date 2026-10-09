import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryQualificationZip } from './inventory-qualification-zip.mjs';
import { careMessagingZip, crc32 } from './care-messaging-zip.mjs';
test('one index entry retains the established deterministic ZIP bytes', () => {
  const bytes = Buffer.from('fictional code'); assert.deepEqual(inventoryQualificationZip([{ name: 'index.js', bytes }]), careMessagingZip(bytes));
});
test('multiple modules have exact CRC, size and central offsets regardless of input order', () => {
  const entries = [{ name: 'recording-runtime.js', bytes: Buffer.from('fictional runtime') }, { name: 'index.js', bytes: Buffer.from('fictional entry') }];
  const zip = inventoryQualificationZip(entries); assert.deepEqual(zip, inventoryQualificationZip([...entries].reverse()));
  let offset = 0;
  for (const e of [...entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50); const n = zip.readUInt16LE(offset + 26), length = zip.readUInt32LE(offset + 18);
    assert.equal(zip.subarray(offset + 30, offset + 30 + n).toString(), e.name);
    assert.equal(length, e.bytes.length); assert.equal(zip.readUInt32LE(offset + 14), crc32(e.bytes));
    assert.deepEqual(zip.subarray(offset + 30 + n, offset + 30 + n + length), e.bytes); offset += 30 + n + length;
  }
  const central = zip.readUInt32LE(zip.length - 6); assert.equal(central, offset); assert.equal(zip.readUInt16LE(zip.length - 12), 2);
  let local = 0;
  for (const e of [...entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50); assert.equal(zip.readUInt32LE(offset + 42), local);
    local += 30 + Buffer.byteLength(e.name) + e.bytes.length; offset += 46 + Buffer.byteLength(e.name);
  }
  assert.equal(offset, zip.length - 22);
});
test('invalid names, duplicate modules, empty/oversize data and missing entries refuse', () => {
  for (const name of ['../index.js', '/index.js', 'folder/index.js', 'folder\\index.js', 'Index.js', 'index.mjs', '', 'é.js']) {
    assert.throws(() => inventoryQualificationZip([{ name, bytes: Buffer.from('x') }]), /inventory_zip_entries_refused/);
  }
  const entry = { name: 'index.js', bytes: Buffer.from('x') };
  for (const entries of [[], [null], [entry, entry], [{ ...entry, bytes: Buffer.alloc(0) }], [{ ...entry, bytes: 'x' }],
    [{ ...entry, bytes: Buffer.alloc(45 * 1024 * 1024 + 1) }]]) assert.throws(() => inventoryQualificationZip(entries), /inventory_zip_entries_refused/);
});
