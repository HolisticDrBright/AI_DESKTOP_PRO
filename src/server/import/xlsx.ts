if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import {
  ImportParseError,
  MAX_CELL_CHARS,
  MAX_SHARED_STRINGS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_SHEETS,
} from "./limits";
import { scanXml } from "./xml";
import { ZipReader } from "./zip";

/**
 * Read the VALUES out of a workbook. Nothing else.
 *
 * THE ONE RULE: A FORMULA IS NEVER EVALUATED, AND NEVER READ.
 *
 * Every cell in an `.xlsx` may carry both a formula (`<f>`) and the value Excel
 * last calculated for it (`<v>`). This reader takes `<v>` and discards `<f>`
 * entirely. That is not a simplification — evaluating a formula would mean
 * implementing a language that includes `WEBSERVICE()`, `HYPERLINK()` and
 * `DDE`, pointed at a file somebody else authored.
 *
 * The consequence is honest and worth stating on screen: a cell whose formula
 * was never calculated has no cached value, and this reader reports it as
 * EMPTY rather than guessing what it would have produced. "Unknown" is the
 * correct answer to "what does this cell say?" when the file does not say.
 *
 * Also discarded: hyperlinks (`xl/worksheets/_rels/*`), external workbook
 * links (`xl/externalLinks/*`), and defined names. A product name is a product
 * name; a link out of the document is not data this system wants.
 */

export interface XlsxCell {
  /** Column letters, e.g. "C". */
  column: string;
  /** Text exactly as the cached value reads, trimmed only at the ends. */
  value: string;
}

export interface XlsxRow {
  /** 1-based row number as the workbook numbers it, gaps preserved. */
  rowNumber: number;
  cells: XlsxCell[];
}

export interface XlsxSheet {
  name: string;
  rows: XlsxRow[];
  /** True when the sheet had more rows than the reader is allowed to take. */
  truncated: boolean;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  /** Parts present in the file that were deliberately not read. */
  ignoredParts: string[];
  /** Cells that carried a formula whose value the file never cached. */
  uncachedFormulaCells: number;
}

const columnOf = (ref: string): string => {
  const match = /^([A-Za-z]+)/.exec(ref);
  return match ? match[1].toUpperCase() : "";
};

const clampCell = (text: string): string =>
  text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;

/**
 * Shared strings. `<si>` entries may be split across many `<t>` runs, so the
 * runs are concatenated in document order.
 */
function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  let inText = false;

  scanXml(xml, {
    onOpen: (tag) => {
      if (tag.name === "si") current = [];
      // `rPh` is phonetic guide text (furigana). It is a pronunciation aid,
      // not part of the string, and concatenating it corrupts the value.
      else if (tag.name === "t" && current) inText = true;
    },
    onText: (text) => {
      if (inText && current) current.push(text);
    },
    onClose: (name) => {
      if (name === "t") inText = false;
      else if (name === "si" && current) {
        if (out.length < MAX_SHARED_STRINGS) out.push(clampCell(current.join("")));
        current = null;
      }
    },
  });

  return out;
}

/** Sheet name → part path, read from the workbook and its relationships. */
function readSheetIndex(zip: ZipReader): Array<{ name: string; path: string }> {
  const workbookXml = zip.readText("xl/workbook.xml");
  if (workbookXml === null) {
    throw new ImportParseError(
      "malformed",
      "The file is not a readable workbook (xl/workbook.xml is missing).",
    );
  }
  const relsXml = zip.readText("xl/_rels/workbook.xml.rels") ?? "";

  const relTargets = new Map<string, string>();
  scanXml(relsXml, {
    onOpen: (tag) => {
      if (tag.name !== "Relationship") return;
      const id = tag.attrs.Id;
      const target = tag.attrs.Target;
      const mode = tag.attrs.TargetMode;
      // External relationships are the ones that point out of the document.
      // They are never resolved, and never fetched.
      if (!id || !target || mode === "External") return;
      relTargets.set(id, target.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
    },
  });

  const sheets: Array<{ name: string; path: string }> = [];
  scanXml(workbookXml, {
    onOpen: (tag) => {
      if (tag.name !== "sheet") return;
      if (sheets.length >= MAX_SHEETS) return;
      const name = tag.attrs.name ?? `Sheet${sheets.length + 1}`;
      const rid = tag.attrs["r:id"] ?? tag.attrs.id ?? "";
      const target = relTargets.get(rid);
      // A sheet whose relationship is missing or external is skipped rather
      // than guessed at by position: guessing would silently read the wrong
      // sheet's rows under the right sheet's name.
      if (!target) return;
      sheets.push({ name, path: `xl/${target}` });
    },
  });

  if (sheets.length === 0) {
    throw new ImportParseError("malformed", "The workbook contains no readable worksheets.");
  }
  return sheets;
}

function readSheet(
  xml: string,
  sharedStrings: string[],
  stats: { uncachedFormulaCells: number },
): { rows: XlsxRow[]; truncated: boolean } {
  const rows: XlsxRow[] = [];
  let truncated = false;

  let rowNumber = 0;
  let cells: XlsxCell[] = [];
  let cellRef = "";
  let cellType = "";
  let inValue = false;
  let inInlineText = false;
  let sawFormula = false;
  let valueParts: string[] = [];
  let skippingRow = false;

  scanXml(xml, {
    onOpen: (tag) => {
      switch (tag.name) {
        case "row": {
          if (rows.length >= MAX_SHEET_ROWS) {
            truncated = true;
            skippingRow = true;
            return;
          }
          skippingRow = false;
          rowNumber = Number.parseInt(tag.attrs.r ?? "", 10) || rows.length + 1;
          cells = [];
          return;
        }
        case "c": {
          if (skippingRow) return;
          cellRef = tag.attrs.r ?? "";
          cellType = tag.attrs.t ?? "";
          valueParts = [];
          sawFormula = false;
          return;
        }
        case "f": {
          // Seen and DISCARDED. Recorded only so the operator can be told how
          // many cells this file expected a spreadsheet engine to fill in.
          if (!skippingRow) sawFormula = true;
          return;
        }
        case "v": {
          if (!skippingRow) inValue = true;
          return;
        }
        case "t": {
          // Inline strings (`<is><t>`) — the only other place a value lives.
          if (!skippingRow) inInlineText = true;
          return;
        }
        default:
      }
    },
    onText: (text) => {
      if (inValue || inInlineText) valueParts.push(text);
    },
    onClose: (name) => {
      switch (name) {
        case "v":
          inValue = false;
          return;
        case "t":
          inInlineText = false;
          return;
        case "c": {
          if (skippingRow) return;
          const raw = valueParts.join("");
          if (raw.length === 0) {
            // A formula with no cached value. The file does not say what this
            // cell contains, so neither does the import.
            if (sawFormula) stats.uncachedFormulaCells += 1;
            return;
          }
          let value = raw;
          if (cellType === "s") {
            const index = Number.parseInt(raw, 10);
            value = Number.isInteger(index) && index >= 0 && index < sharedStrings.length
              ? sharedStrings[index]
              : "";
          }
          value = clampCell(value.trim());
          if (value.length === 0) return;
          if (cells.length < MAX_SHEET_COLUMNS) {
            cells.push({ column: columnOf(cellRef), value });
          }
          return;
        }
        case "row": {
          if (skippingRow) return;
          if (cells.length > 0) rows.push({ rowNumber, cells });
          cells = [];
          return;
        }
        default:
      }
    },
  });

  return { rows, truncated };
}

/**
 * Parse a workbook from bytes already checked for size and type.
 *
 * Returns values and structure. It does not decide what any of it MEANS —
 * mapping columns to governed fields is `normalize.ts`, deliberately separate,
 * so a parsing change cannot quietly become a clinical-meaning change.
 */
export function parseXlsx(bytes: Buffer): XlsxWorkbook {
  const zip = new ZipReader(bytes);

  if (!zip.has("xl/workbook.xml")) {
    throw new ImportParseError(
      "unsupported",
      "This file is not an .xlsx workbook. If it is an older .xls, open it in Excel "
        + "and save it as .xlsx first.",
    );
  }

  const ignoredParts = zip
    .names()
    .filter(
      (name) =>
        name.startsWith("xl/externalLinks/")
        || /_rels\/sheet\d+\.xml\.rels$/.test(name)
        || name === "xl/calcChain.xml"
        || name.startsWith("xl/media/")
        || name.startsWith("customXml/"),
    );

  const sharedStringsXml = zip.readText("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml === null ? [] : readSharedStrings(sharedStringsXml);

  const stats = { uncachedFormulaCells: 0 };
  const sheets: XlsxSheet[] = [];

  for (const entry of readSheetIndex(zip)) {
    const sheetXml = zip.readText(entry.path);
    if (sheetXml === null) continue;
    const { rows, truncated } = readSheet(sheetXml, sharedStrings, stats);
    sheets.push({ name: entry.name, rows, truncated });
  }

  if (sheets.length === 0) {
    throw new ImportParseError("malformed", "The workbook contains no readable worksheets.");
  }

  return { sheets, ignoredParts, uncachedFormulaCells: stats.uncachedFormulaCells };
}
