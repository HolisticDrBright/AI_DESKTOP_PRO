if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { createHash } from "node:crypto";
import type { DocxDocument } from "./docx";
import type { XlsxWorkbook } from "./xlsx";
import { ImportParseError } from "./limits";

/**
 * Turn parsed structure into the governed import envelope.
 *
 * KEPT SEPARATE FROM THE PARSERS ON PURPOSE. A parser decides what the file
 * SAYS; this decides what any of it MEANS in clinical terms. Fusing them would
 * make "we now also read column H" and "column H is a dose" the same change,
 * reviewed once, by whoever was reading the ZIP code that day.
 *
 * TWO THINGS THIS NEVER DOES:
 *
 *   1. It never invents a field. A column the sheet does not have produces an
 *      ABSENT key, not an empty string — absence is a fact the review surface
 *      shows, and `""` would render as a value nobody wrote.
 *   2. It never normalises away the original. Every row carries `sourceRaw`:
 *      the header-to-cell map exactly as the file reads, untrimmed of meaning.
 *      Normalisation is allowed to be lossy precisely because the loss is
 *      recoverable.
 */

export const IMPORT_SCHEMA_VERSION = "clinical-knowledge-import-v1";

export interface NormalizedItem {
  entityType: string;
  displayName: string;
  externalKey?: string;
  sourceSheet?: string;
  payload: Record<string, unknown>;
  /** The verbatim source row or section. Never normalised. */
  sourceRaw: Record<string, unknown>;
  warnings?: string[];
}

export interface NormalizeResult {
  items: NormalizedItem[];
  /** Header cells the mapper did not recognise, reported rather than dropped. */
  unmappedColumns: string[];
  /** Rows skipped because they carried no usable identity. */
  skippedRows: Array<{ sheet: string; rowNumber: number; why: string }>;
  sheetsRead: string[];
}

export const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

/* ------------------------------------------------------------ spreadsheets */

/**
 * Header synonyms.
 *
 * A practitioner's spreadsheet does not use this system's field names, and
 * asking them to rename their columns before they can import is how an
 * importer goes unused. The list is EXPLICIT rather than fuzzy: a header that
 * is not listed is reported as unmapped, and unmapped is visible on screen.
 * Fuzzy matching would guess, and a wrong guess here writes a dose into a
 * serving size.
 */
const COLUMN_SYNONYMS: Record<string, string[]> = {
  name: ["name", "product", "product name", "item", "item name", "title"],
  brand: ["brand", "manufacturer", "mfr", "vendor", "supplier", "brand name"],
  sku: ["sku", "item #", "item number", "item no", "product code", "code", "catalog #"],
  upc: ["upc", "barcode", "gtin", "ean"],
  manufacturerIdentifier: ["manufacturer id", "manufacturer identifier", "mpn", "mfr part"],
  form: ["form", "dose form", "delivery", "format", "type"],
  servingSize: ["serving size", "serving", "dose", "dosage", "amount per serving"],
  servingsPerContainer: ["servings per container", "servings", "count", "quantity per bottle"],
  category: ["category", "class", "group"],
  description: ["description", "notes", "detail", "details"],
  sourceUrl: ["label url", "product url", "source url", "manufacturer url", "url", "link"],
  regulatoryClassification: ["regulatory classification", "regulatory class", "classification"],
  jurisdiction: ["jurisdiction", "country", "market", "region"],
  route: ["route", "administration", "route of administration"],
  ingredientsText: ["ingredients", "active ingredients", "supplement facts"],
  otherIngredients: ["other ingredients", "excipients", "inactive ingredients"],
  directions: ["directions", "label directions", "usage", "how to use"],
  warnings: ["warnings", "label warnings", "cautions"],
};

const HEADER_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const synonym of synonyms) map.set(synonym, field);
  }
  return map;
})();

const normalizeHeader = (raw: string): string =>
  raw.toLowerCase().replace(/[_.]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Split an ingredient cell into structured entries.
 *
 * CONSERVATIVE ON PURPOSE. An amount is taken ONLY when the cell states one in
 * a recognisable shape; a part that does not match keeps its text as a name and
 * carries NO amount at all. This reads what the source says and never fills in
 * what it does not — the standing rule is that a dose requires an exact label,
 * and a number this function guessed would not be one.
 *
 * The original cell is preserved verbatim in `sourceRaw` either way, so a
 * reviewer can always check this parse against what the practitioner wrote.
 */
export function parseIngredientCell(
  cell: string,
): Array<{ name: string; amount?: string; unit?: string }> {
  const parts = cell
    .split(/[;,]|\u2022/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 64);

  return parts.map((part) => {
    const match = /^(.*\S)\s+([\d.]+)\s*(mcg|mg|g|iu|ml|µg|ug)$/i.exec(part);
    if (!match) return { name: part.slice(0, 200) };
    return {
      name: match[1].slice(0, 200),
      amount: match[2],
      unit: match[3].toLowerCase(),
    };
  });
}

/**
 * The `sourceUrl` field is the one place a URL legitimately enters, because
 * the governed schema records where a label was read from. It is stored as
 * TEXT and never fetched by anything in this system — but a value that is not
 * a URL at all should not masquerade as one, and a `javascript:` or `file:`
 * scheme has no business in a manufacturer-label field.
 */
function acceptableSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Map one spreadsheet to catalog-product items.
 *
 * The header row is the FIRST row that maps at least two known columns. Taking
 * row 1 unconditionally breaks on every sheet with a title banner above the
 * table, which is most of them.
 */
export function normalizeProductWorkbook(
  workbook: XlsxWorkbook,
  options: { sheetName?: string } = {},
): NormalizeResult {
  const unmapped = new Set<string>();
  const skippedRows: NormalizeResult["skippedRows"] = [];
  const items: NormalizedItem[] = [];
  const sheetsRead: string[] = [];

  const sheets = options.sheetName
    ? workbook.sheets.filter((s) => s.name === options.sheetName)
    : workbook.sheets;

  if (sheets.length === 0) {
    throw new ImportParseError(
      "malformed",
      options.sheetName
        ? `The workbook has no sheet named "${options.sheetName}".`
        : "The workbook contains no readable worksheets.",
    );
  }

  for (const sheet of sheets) {
    let headerRowIndex = -1;
    let headerMap: Map<string, string> = new Map();
    let headerLabels: Map<string, string> = new Map();

    for (let i = 0; i < sheet.rows.length && i < 25; i += 1) {
      const candidate = new Map<string, string>();
      const labels = new Map<string, string>();
      for (const cell of sheet.rows[i].cells) {
        const field = HEADER_LOOKUP.get(normalizeHeader(cell.value));
        if (field && !candidate.has(cell.column)) {
          candidate.set(cell.column, field);
        }
        labels.set(cell.column, cell.value);
      }
      if (candidate.size >= 2) {
        headerRowIndex = i;
        headerMap = candidate;
        headerLabels = labels;
        break;
      }
    }

    if (headerRowIndex === -1) {
      skippedRows.push({
        sheet: sheet.name,
        rowNumber: 0,
        why: "No header row was recognised on this sheet, so no row could be read as a product.",
      });
      continue;
    }

    sheetsRead.push(sheet.name);
    for (const [column, label] of headerLabels) {
      if (!headerMap.has(column) && label.trim()) unmapped.add(label.trim());
    }

    for (let i = headerRowIndex + 1; i < sheet.rows.length; i += 1) {
      const row = sheet.rows[i];
      const payload: Record<string, unknown> = {};
      const sourceRaw: Record<string, unknown> = {};

      for (const cell of row.cells) {
        const label = headerLabels.get(cell.column) ?? cell.column;
        sourceRaw[label] = cell.value;
        const field = headerMap.get(cell.column);
        if (!field) continue;
        const value = cell.value.trim();
        if (value.length === 0) continue;
        if (field === "sourceUrl" && !acceptableSourceUrl(value)) {
          // Kept in sourceRaw, refused as a governed value. The reviewer can
          // still see exactly what the cell said.
          continue;
        }
        if (field === "ingredientsText") {
          const parsed = parseIngredientCell(value);
          if (parsed.length > 0) payload.ingredients = parsed;
          continue;
        }
        payload[field] = value;
      }

      if (typeof payload.name !== "string" || payload.name.length === 0) {
        if (Object.keys(sourceRaw).length > 0) {
          skippedRows.push({
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            why: "The row has no product name, so it cannot be identified.",
          });
        }
        continue;
      }

      items.push({
        entityType: "catalog_product",
        displayName: String(payload.name),
        sourceSheet: sheet.name,
        externalKey: `${sheet.name}:${row.rowNumber}`,
        payload,
        sourceRaw,
      });
    }
  }

  return {
    items,
    unmappedColumns: [...unmapped].sort(),
    skippedRows,
    sheetsRead,
  };
}

/* ---------------------------------------------------------------- documents */

/**
 * Map a protocol document to knowledge-reference items, one per heading
 * section.
 *
 * A DOCUMENT IS NOT A PROTOCOL, and this is where that shows. A section of
 * practitioner prose is captured as a REFERENCE — a record that this text
 * exists and where it came from — and never as a `protocol_template` with
 * doses. Turning paragraphs into a governed protocol would mean inferring the
 * dose, which the standing rules forbid outright.
 *
 * The short excerpt is capped at 300 characters because the governed schema
 * refuses more: the registry stores a structured summary and a pointer, not a
 * copy of somebody's copyrighted document.
 */
export function normalizeProtocolDocument(
  doc: DocxDocument,
  options: { sourceName: string },
): NormalizeResult {
  const items: NormalizedItem[] = [];
  const skippedRows: NormalizeResult["skippedRows"] = [];

  type Section = { heading: string; path: string[]; body: string[]; firstIndex: number };
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const paragraph of doc.paragraphs) {
    if (paragraph.headingLevel > 0) {
      if (current) sections.push(current);
      current = {
        heading: paragraph.text,
        path: paragraph.sectionPath,
        body: [],
        firstIndex: paragraph.index,
      };
      continue;
    }
    if (current) current.body.push(paragraph.text);
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    skippedRows.push({
      sheet: options.sourceName,
      rowNumber: 0,
      why: "The document has no headings, so it could not be divided into sections. "
        + "Add headings in Word and re-import.",
    });
    return { items, unmappedColumns: [], skippedRows, sheetsRead: [] };
  }

  for (const section of sections) {
    const body = section.body.join("\n").trim();
    if (body.length === 0) {
      skippedRows.push({
        sheet: options.sourceName,
        rowNumber: section.firstIndex,
        why: `The section "${section.heading}" has a heading but no text under it.`,
      });
      continue;
    }
    const excerpt = body.length > 300 ? `${body.slice(0, 297)}...` : body;

    items.push({
      entityType: "knowledge_reference",
      displayName: section.heading,
      externalKey: `${options.sourceName}#${section.firstIndex}`,
      payload: {
        code: `${slug(options.sourceName)}-${slug(section.heading)}`.slice(0, 96),
        title: section.heading,
        referenceType: "practitioner_document",
        shortExcerpt: excerpt,
        sectionPath: section.path,
      },
      sourceRaw: {
        heading: section.heading,
        sectionPath: section.path,
        paragraphIndex: section.firstIndex,
        // The full section text, verbatim, so the reviewer compares the
        // 300-character excerpt against what the document actually says.
        body,
      },
      warnings:
        body.length > 300
          ? ["Only the first 300 characters are stored as an excerpt; the full section text is kept as the source record."]
          : undefined,
    });
  }

  return { items, unmappedColumns: [], skippedRows, sheetsRead: [options.sourceName] };
}

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "section";
