if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { parseDocx } from "./docx";
import { ImportParseError, MAX_FILE_BYTES } from "./limits";
import {
  IMPORT_SCHEMA_VERSION,
  normalizeProductWorkbook,
  normalizeProtocolDocument,
  sha256Hex,
  type NormalizedItem,
} from "./normalize";
import { parseXlsx } from "./xlsx";

export { ImportParseError } from "./limits";
export { IMPORT_SCHEMA_VERSION } from "./normalize";

/**
 * The one entry point: bytes in, a reviewable import envelope out.
 *
 * WHAT THIS FUNCTION IS NOT. It is not a step towards the database. It parses
 * and normalises, and it returns. Nothing here calls an RPC, and the envelope
 * it produces is inert until a person reads the preview and commits it. Making
 * "the file parsed" and "the content is in the system" one action is the whole
 * failure this pipeline exists to prevent.
 *
 * FILE TYPE IS DECIDED BY CONTENT, NOT BY NAME. An extension is a claim by
 * whoever named the file. The magic bytes are checked first, and the declared
 * name is used only to choose which mapping to apply — so a `.docx` renamed
 * to `.xlsx` fails as "not a workbook" rather than being read as one.
 */

export type ImportSourceKind = "product_spreadsheet" | "protocol_document";

export interface ParsedImportEnvelope {
  schemaVersion: string;
  sourceKind: ImportSourceKind;
  /** File NAME only. A path never enters this object. */
  sourceFilename: string;
  sourceName: string;
  sourceByteSize: number;
  /** sha256 of the file exactly as supplied. */
  sourceSha256: string;
  items: NormalizedItem[];
  /** Everything the operator should see before they stage this. */
  report: {
    itemCount: number;
    sheetsRead: string[];
    unmappedColumns: string[];
    skippedRows: Array<{ sheet: string; rowNumber: number; why: string }>;
    ignoredParts: string[];
    /** Cells carrying a formula the file never cached a value for. */
    uncachedFormulaCells: number;
    /** Word field codes seen and discarded. */
    discardedFieldCodes: number;
    truncated: boolean;
    notices: string[];
  };
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * A file name, with any path the caller supplied removed.
 *
 * Where the operator keeps their clinical material is not this system's
 * business and must never reach a database that gets dumped, replicated or
 * supported. Stripping here means no caller has to remember to.
 */
export function toFileNameOnly(input: string): string {
  const lastSlash = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
  const base = lastSlash === -1 ? input : input.slice(lastSlash + 1);
  const cleaned = base.replace(/^[A-Za-z]:/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) {
    throw new ImportParseError("malformed", "The file has no usable name.");
  }
  return cleaned.slice(0, 260);
}

function assertContainerBytes(bytes: Buffer, declaredName: string): void {
  if (bytes.length === 0) {
    throw new ImportParseError("malformed", "The file is empty.");
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ImportParseError(
      "too_large",
      `The file is ${Math.round(bytes.length / 1024 / 1024)} MB; the limit is `
        + `${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }
  if (OLE2_MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw new ImportParseError(
      "unsupported",
      `"${declaredName}" is in the older Office format (.xls / .doc). Open it in Excel `
        + "or Word and save it as .xlsx or .docx, then import that.",
    );
  }
  if (!ZIP_MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw new ImportParseError(
      "unsupported",
      `"${declaredName}" is not an .xlsx or .docx file. Its contents do not match either `
        + "format, whatever its name says.",
    );
  }
}

export function parseImportFile(input: {
  bytes: Buffer;
  /** May be a full path; only the file name survives. */
  filename: string;
  sourceKind: ImportSourceKind;
  sourceName?: string;
  sheetName?: string;
}): ParsedImportEnvelope {
  const filename = toFileNameOnly(input.filename);
  assertContainerBytes(input.bytes, filename);

  const sourceSha256 = sha256Hex(input.bytes);
  const sourceName = (input.sourceName ?? filename).trim() || filename;
  const notices: string[] = [];

  if (input.sourceKind === "product_spreadsheet") {
    const workbook = parseXlsx(input.bytes);
    const result = normalizeProductWorkbook(workbook, { sheetName: input.sheetName });

    if (workbook.uncachedFormulaCells > 0) {
      notices.push(
        `${workbook.uncachedFormulaCells} cell(s) contain a formula with no saved result. `
          + "Formulas are never calculated by this importer, so those cells were read as "
          + "empty. Open the file in Excel, let it recalculate, save, and re-import if "
          + "those values matter.",
      );
    }
    if (workbook.sheets.some((s) => s.truncated)) {
      notices.push(
        "At least one sheet was longer than this importer reads in one pass; the rows "
          + "beyond the limit were not read.",
      );
    }
    if (result.unmappedColumns.length > 0) {
      notices.push(
        `${result.unmappedColumns.length} column(s) were not recognised and were kept only `
          + "as source values: " + result.unmappedColumns.join(", ") + ".",
      );
    }

    return {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      sourceKind: "product_spreadsheet",
      sourceFilename: filename,
      sourceName,
      sourceByteSize: input.bytes.length,
      sourceSha256,
      items: result.items,
      report: {
        itemCount: result.items.length,
        sheetsRead: result.sheetsRead,
        unmappedColumns: result.unmappedColumns,
        skippedRows: result.skippedRows,
        ignoredParts: workbook.ignoredParts,
        uncachedFormulaCells: workbook.uncachedFormulaCells,
        discardedFieldCodes: 0,
        truncated: workbook.sheets.some((s) => s.truncated),
        notices,
      },
    };
  }

  const doc = parseDocx(input.bytes);
  const result = normalizeProtocolDocument(doc, { sourceName });

  if (doc.discardedFieldCodes > 0) {
    notices.push(
      `${doc.discardedFieldCodes} field code(s) were found and discarded. A Word field is an `
        + "instruction rather than text — this importer never runs one, and never stores it.",
    );
  }
  if (doc.truncated) {
    notices.push(
      "The document was longer than this importer reads in one pass; the paragraphs beyond "
        + "the limit were not read.",
    );
  }
  notices.push(
    "Document sections are captured as REFERENCES — a record that the text exists and where "
      + "it came from. No dose, protocol or clinical claim is inferred from prose.",
  );

  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    sourceKind: "protocol_document",
    sourceFilename: filename,
    sourceName,
    sourceByteSize: input.bytes.length,
    sourceSha256,
    items: result.items,
    report: {
      itemCount: result.items.length,
      sheetsRead: result.sheetsRead,
      unmappedColumns: [],
      skippedRows: result.skippedRows,
      ignoredParts: doc.ignoredParts,
      uncachedFormulaCells: 0,
      discardedFieldCodes: doc.discardedFieldCodes,
      truncated: doc.truncated,
      notices,
    },
  };
}
