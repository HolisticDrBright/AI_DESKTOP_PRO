/**
 * The refusal budget for parsing an operator's file.
 *
 * Every value here is a REFUSAL, not a preference. A parser without bounds is
 * an arbitrary-resource primitive pointed at a file the practitioner received
 * from someone else, and "the file was probably fine" is not a security
 * property.
 *
 * The numbers are deliberately generous for real practitioner material and
 * still far below anything that could exhaust the process. A real product
 * spreadsheet is hundreds of rows; the cap is 5000 because that is what the
 * import batch itself accepts, and two different limits would mean the parser
 * could produce a file the pipeline then refuses.
 */

/** Bytes. A 25 MB spreadsheet is already extraordinary for a product list. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Entries inside the container. OOXML files use dozens, not thousands. */
export const MAX_ZIP_ENTRIES = 512;

/** Bytes, per entry, after decompression. Guards the classic zip bomb. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Bytes, summed across every entry we actually read. */
export const MAX_TOTAL_INFLATED_BYTES = 128 * 1024 * 1024;

/**
 * Compression ratio ceiling.
 *
 * A 1000:1 entry is not a spreadsheet. `MAX_ENTRY_BYTES` alone would let a
 * 50 KB upload expand to 64 MB before anything noticed; the ratio catches it
 * at the point the intent becomes obvious.
 */
export const MAX_COMPRESSION_RATIO = 200;

/** Rows read from one worksheet, matching what the import batch accepts. */
export const MAX_SHEET_ROWS = 5000;

/** Columns read from one row. Beyond this a "row" is not a record. */
export const MAX_SHEET_COLUMNS = 128;

/** Worksheets read from one workbook. */
export const MAX_SHEETS = 32;

/** Characters kept from a single cell or paragraph. */
export const MAX_CELL_CHARS = 4000;

/** Paragraphs read from one document. */
export const MAX_DOC_PARAGRAPHS = 20_000;

/** Shared strings read from one workbook. */
export const MAX_SHARED_STRINGS = 200_000;

/** Nesting depth accepted by the XML reader. */
export const MAX_XML_DEPTH = 64;

/**
 * A parse refusal.
 *
 * `reason` is written for the operator who has to decide whether to fix the
 * file or stop. `code` is what the route maps to an HTTP status, so a refused
 * file reads as a rejected request rather than a server fault.
 */
export class ImportParseError extends Error {
  readonly code: "unsupported" | "too_large" | "malformed" | "unsafe";

  constructor(code: ImportParseError["code"], message: string) {
    super(message);
    this.name = "ImportParseError";
    this.code = code;
  }
}
