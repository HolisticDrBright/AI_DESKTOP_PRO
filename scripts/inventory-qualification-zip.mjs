import { crc32 } from './care-messaging-zip.mjs';
/** Deterministic stored ZIP, root-level reviewed module names only. No ZIP64,
 * traversal, links, timestamps, absolute paths or silently omitted runtimes. */
export function inventoryQualificationZip(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) throw Error('inventory_zip_entries_refused');
  if (entries.some(e => !e || typeof e !== 'object' || typeof e.name !== 'string')) throw Error('inventory_zip_entries_refused');
  const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(sorted.map(e => e.name)).size !== sorted.length || sorted.some(e => !/^[a-z][a-z0-9-]*\.js$/.test(e.name)
    || !Buffer.isBuffer(e.bytes) || !e.bytes.length) || sorted.reduce((n, e) => n + e.bytes.length, 0) > 45 * 1024 * 1024) {
    throw Error('inventory_zip_entries_refused');
  }
  const locals = [], centrals = []; let offset = 0;
  for (const { name: text, bytes } of sorted) {
    const name = Buffer.from(text), crc = crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(2048, 6); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(2048, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x81a40000, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes); centrals.push(central, name); offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
