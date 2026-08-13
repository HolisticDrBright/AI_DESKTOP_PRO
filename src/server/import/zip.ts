if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { inflateRawSync } from "node:zlib";
import {
  ImportParseError,
  MAX_COMPRESSION_RATIO,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_INFLATED_BYTES,
  MAX_ZIP_ENTRIES,
} from "./limits";

/**
 * A local, allowlist-driven ZIP reader for OOXML containers.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. An `.xlsx` is a ZIP archive, and a
 * general-purpose extractor is a general-purpose primitive: it will happily
 * write `../../etc/anything`, inflate a 10 KB entry into 4 GB, and follow
 * whatever the archive says. This reader does none of those things because it
 * cannot — it never writes to disk, it reads ONLY the parts an OOXML document
 * needs, and every size is bounded before the bytes exist.
 *
 * It reads the CENTRAL DIRECTORY, not the stream of local headers. The two can
 * disagree, and a reader that trusts local headers can be shown a different
 * file from the one a validator saw.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Names we refuse outright, before any inflation.
 *
 * A macro-enabled workbook is not a spreadsheet with extra features; it is a
 * program. This reader has no way to run one and never will, but a file that
 * CONTAINS one was authored to be run somewhere, and importing its values
 * silently would tell the operator nothing about that.
 */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /(^|\/)vbaProject\.bin$/i,
    why: "it contains a VBA macro project",
  },
  {
    re: /(^|\/)vbaData\.xml$/i,
    why: "it contains VBA macro data",
  },
  {
    re: /^xl\/macrosheets\//i,
    why: "it contains an Excel 4.0 macro sheet",
  },
  {
    re: /(^|\/)oleObject\d*\.bin$/i,
    why: "it contains an embedded OLE object",
  },
  {
    re: /^word\/embeddings\//i,
    why: "it contains an embedded object",
  },
  {
    re: /^xl\/embeddings\//i,
    why: "it contains an embedded object",
  },
];

function assertSafeEntryName(name: string): void {
  if (name.length === 0 || name.length > 512) {
    throw new ImportParseError("unsafe", "The file contains an entry with an unusable name.");
  }
  // Absolute paths, traversal, drive letters and backslashes. Nothing here is
  // ever written to disk, but a name that tries to escape is evidence about
  // the file, and evidence like that ends the parse rather than being ignored.
  if (
    name.startsWith("/")
    || name.startsWith("\\")
    || /^[A-Za-z]:/.test(name)
    || name.includes("\\")
    || name.split("/").some((segment) => segment === "..")
  ) {
    throw new ImportParseError(
      "unsafe",
      "The file contains an entry whose path tries to escape the document. It was not read.",
    );
  }
  if (name.includes("\0")) {
    throw new ImportParseError("unsafe", "The file contains an entry with an embedded null byte.");
  }
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD is at the end, after a comment of up to 65535 bytes.
  const minOffset = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ImportParseError(
    "malformed",
    "The file is not a readable Office document (no ZIP directory was found).",
  );
}

/**
 * Read the central directory.
 *
 * ZIP64 is recognised and REFUSED rather than half-supported. A file needing
 * ZIP64 is larger than anything this importer accepts, so the only way to
 * reach this branch is with a file that lies about its size — which is a
 * refusal, not a feature request.
 */
export function readZipDirectory(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) {
    throw new ImportParseError("malformed", "The file is too small to be an Office document.");
  }

  const eocd = findEndOfCentralDirectory(buf);
  let entryCount = buf.readUInt16LE(eocd + 10);
  let directoryOffset = buf.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    // Locate the ZIP64 EOCD only to produce an honest message.
    let hasZip64 = false;
    for (let i = eocd - 20; i >= 0; i -= 1) {
      if (buf.readUInt32LE(i) === EOCD64_LOCATOR_SIGNATURE) {
        hasZip64 = true;
        break;
      }
    }
    if (hasZip64) {
      const locator = buf.lastIndexOf(
        Buffer.from([0x50, 0x4b, 0x06, 0x07]),
      );
      const z64Offset = Number(buf.readBigUInt64LE(locator + 8));
      if (
        z64Offset >= 0
        && z64Offset + 56 <= buf.length
        && buf.readUInt32LE(z64Offset) === EOCD64_SIGNATURE
      ) {
        entryCount = Number(buf.readBigUInt64LE(z64Offset + 32));
        directoryOffset = Number(buf.readBigUInt64LE(z64Offset + 48));
      }
    }
    if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
      throw new ImportParseError(
        "unsupported",
        "The file uses ZIP64 extensions, which this importer does not read.",
      );
    }
  }

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new ImportParseError(
      "too_large",
      `The file contains ${entryCount} internal parts; the limit is ${MAX_ZIP_ENTRIES}.`,
    );
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ImportParseError("malformed", "The file's internal directory is damaged.");
    }
    const compressionMethod = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    if (nameStart + nameLength > buf.length) {
      throw new ImportParseError("malformed", "The file's internal directory is damaged.");
    }
    const name = buf.subarray(nameStart, nameStart + nameLength).toString("utf8");
    assertSafeEntryName(name);

    for (const forbidden of FORBIDDEN_PATTERNS) {
      if (forbidden.re.test(name)) {
        throw new ImportParseError(
          "unsafe",
          `This file was refused because ${forbidden.why} (${name}). `
            + "Re-save it as a plain .xlsx or .docx with no macros or embedded objects, "
            + "then import that.",
        );
      }
    }

    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ImportParseError(
        "too_large",
        `An internal part of the file (${name}) declares ${uncompressedSize} bytes, `
          + `beyond the ${MAX_ENTRY_BYTES}-byte limit.`,
      );
    }
    if (
      compressedSize > 0
      && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new ImportParseError(
        "unsafe",
        `An internal part of the file (${name}) expands more than `
          + `${MAX_COMPRESSION_RATIO}× when decompressed. It was not read.`,
      );
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * A reader bound to one archive, tracking cumulative inflation.
 *
 * The running total is why this is a class. Per-entry caps do not stop a file
 * with two hundred entries that are each just under the ceiling.
 */
export class ZipReader {
  private readonly buf: Buffer;
  private readonly entries: Map<string, ZipEntry>;
  private inflatedTotal = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.entries = new Map();
    for (const entry of readZipDirectory(buf)) {
      // First writer wins. A duplicate name is how two readers are shown two
      // different documents from the same bytes.
      if (!this.entries.has(entry.name)) this.entries.set(entry.name, entry);
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** Read one entry as UTF-8 text, or null when it is not present. */
  readText(name: string): string | null {
    const bytes = this.readBytes(name);
    return bytes === null ? null : bytes.toString("utf8");
  }

  readBytes(name: string): Buffer | null {
    const entry = this.entries.get(name);
    if (!entry) return null;

    const header = entry.localHeaderOffset;
    if (header + 30 > this.buf.length || this.buf.readUInt32LE(header) !== LOCAL_SIGNATURE) {
      throw new ImportParseError("malformed", `An internal part of the file (${name}) is damaged.`);
    }
    const nameLength = this.buf.readUInt16LE(header + 26);
    const extraLength = this.buf.readUInt16LE(header + 28);
    const dataStart = header + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.buf.length) {
      throw new ImportParseError("malformed", `An internal part of the file (${name}) is truncated.`);
    }

    const raw = this.buf.subarray(dataStart, dataEnd);
    let out: Buffer;
    if (entry.compressionMethod === 0) {
      out = Buffer.from(raw);
    } else if (entry.compressionMethod === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        // `maxOutputLength` throws on overflow, and so does corrupt deflate
        // data. Both are "we are not reading this", and neither is a fault.
        throw new ImportParseError(
          "unsafe",
          `An internal part of the file (${name}) could not be decompressed within `
            + "the size limit. It was not read.",
        );
      }
    } else {
      throw new ImportParseError(
        "unsupported",
        `An internal part of the file (${name}) uses an unsupported compression method.`,
      );
    }

    this.inflatedTotal += out.length;
    if (this.inflatedTotal > MAX_TOTAL_INFLATED_BYTES) {
      throw new ImportParseError(
        "too_large",
        "The file expands beyond the total size this importer will hold in memory.",
      );
    }
    return out;
  }
}
