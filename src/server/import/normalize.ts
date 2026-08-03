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
  // A product row is IDENTIFIED by name — every synonym here has to be one a
  // practitioner would actually put over a product-name column. "Supplement"
  // is included because affiliate/protocol sheets typically head that column
  // with the noun rather than "Product Name".
  name: ["name", "product", "product name", "item", "item name", "title", "supplement"],
  brand: ["brand", "manufacturer", "mfr", "vendor", "supplier", "brand name", "company"],
  // `code` is intentionally listed under `sku` — SKUs, item numbers and
  // "product code" all belong here. Discount codes are a commercial concept
  // captured separately as `discountCode` below.
  sku: ["sku", "item #", "item number", "item no", "product code", "catalog #"],
  upc: ["upc", "barcode", "gtin", "ean"],
  manufacturerIdentifier: ["manufacturer id", "manufacturer identifier", "mpn", "mfr part"],
  form: ["form", "dose form", "delivery", "format"],
  servingSize: ["serving size", "serving", "amount per serving"],
  servingsPerContainer: ["servings per container", "servings", "count", "quantity per bottle"],
  category: ["category", "class", "group", "product type", "type"],
  description: ["description", "notes", "detail", "details"],
  // "Link" alone is not enough (a URL cell could point anywhere); the URL is
  // acceptance-validated by `acceptableSourceUrl` and stored as
  // `sourceUrl`. A malformed value stays in `sourceRaw` and is reported.
  sourceUrl: ["label url", "product url", "source url", "manufacturer url", "url", "link"],
  regulatoryClassification: ["regulatory classification", "regulatory class", "classification"],
  jurisdiction: ["jurisdiction", "country", "market", "region"],
  route: ["route", "administration", "route of administration"],
  ingredientsText: ["ingredients", "active ingredients", "supplement facts"],
  otherIngredients: ["other ingredients", "excipients", "inactive ingredients"],
  directions: ["directions", "label directions", "usage", "how to use"],
  warnings: ["warnings", "label warnings", "cautions"],
  // Commercial fields, captured here so `sourceRaw` is not the only place
  // they land — but the workspace is what routes them into the commercial
  // model. The parser never joins commercial + clinical data itself.
  discountCode: ["code", "discount code", "coupon", "coupon code", "promo code"],
  bestFor: ["best for", "recommended for", "intended for"],
};

/**
 * Column patterns for a NON-product row.
 *
 * A sheet whose first recognisable row is `Metabolite | Mechanism | Suggested
 * Dose`, or `SNP | Wild Type | Nutrient Support`, is a reference sheet, not a
 * catalog. Its rows describe an intervention CLASS, an interpretation RULE,
 * or a lab-marker relationship — none of which is a "product" nobody in this
 * system has held. Treating them as catalog rows would either invent dosed
 * products from prose or drop the content entirely.
 *
 * These synonyms are matched only when NO product-name column is found on the
 * sheet — a spreadsheet with both `Product` and `Metabolite` still routes as
 * a product sheet. Every reference row lands as a `knowledge_reference`
 * without a dose, so the standing rule "a dose requires an exact product
 * label" is preserved.
 */
const REFERENCE_ROW_SYNONYMS: Record<string, string[]> = {
  subjectLabel: [
    "metabolite", "snp", "nutrient", "nutrient / cofactor", "nutrient/cofactor",
    "nutrient / compound", "intervention", "compound", "biomarker",
    "oxidative stress marker",
  ],
  variantOrLevel: [
    "high/low", "wild type", "heterozygous variant", "homozygous variant",
  ],
  mechanism: [
    "mechanism", "mechanism of action", "clinical symptoms/diagnosis to consider",
    "description",
  ],
  clinicalPearl: ["clinical pearl", "clinical pearl categories"],
  supportingActions: [
    "lifestyle recommendations", "supplements", "nutrient support",
    "nutrient/supplement support",
  ],
  additionalTesting: ["additional lab testing to consider", "supportive tests"],
  suggestedDose: [
    "suggested dose", "recommended dosing", "dose", "recommended dose",
    "dose / notes",
  ],
  notes: ["other", "notes", "lifestyle factors"],
};

const HEADER_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const synonym of synonyms) map.set(synonym, field);
  }
  return map;
})();

const REFERENCE_HEADER_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [field, synonyms] of Object.entries(REFERENCE_ROW_SYNONYMS)) {
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
 * Map one spreadsheet to items.
 *
 * The header row is the FIRST row that maps at least two known columns. Taking
 * row 1 unconditionally breaks on every sheet with a title banner above the
 * table, which is most of them.
 *
 * A SHEET IS EITHER A CATALOG OR A REFERENCE, not both. If the header row
 * carries a product-name column (any `COLUMN_SYNONYMS.name` synonym), the
 * sheet is a catalog and every row becomes a `catalog_product`. If it does
 * not — but the header carries at least two `REFERENCE_ROW_SYNONYMS` — the
 * sheet is a REFERENCE and every row becomes a `knowledge_reference`
 * describing an intervention/interpretation subject with no dose claim.
 * Rows without a product name on a catalog sheet stay skipped, exactly as
 * before, so a partial spreadsheet does not silently produce reference rows
 * that a reviewer never asked for.
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
    // Search up to the first 25 rows for a header. For each candidate row we
    // record BOTH the catalog-column matches and the reference-column
    // matches, then pick the mode with more matches (ties resolved to
    // catalog, because catalog rows carry more governance and are the
    // stricter interpretation).
    let headerRowIndex = -1;
    let sheetMode: "catalog" | "reference" | null = null;
    let headerMap: Map<string, string> = new Map();
    let headerLabels: Map<string, string> = new Map();

    for (let i = 0; i < sheet.rows.length && i < 25; i += 1) {
      const catalogHits = new Map<string, string>();
      const referenceHits = new Map<string, string>();
      const labels = new Map<string, string>();
      for (const cell of sheet.rows[i].cells) {
        const normalized = normalizeHeader(cell.value);
        const catField = HEADER_LOOKUP.get(normalized);
        const refField = REFERENCE_HEADER_LOOKUP.get(normalized);
        if (catField && !catalogHits.has(cell.column)) catalogHits.set(cell.column, catField);
        if (refField && !referenceHits.has(cell.column)) referenceHits.set(cell.column, refField);
        labels.set(cell.column, cell.value);
      }
      const catalogHasName = [...catalogHits.values()].includes("name");
      const catalogUsable = catalogHits.size >= 2 && catalogHasName;
      const referenceUsable = referenceHits.size >= 2;

      if (catalogUsable) {
        headerRowIndex = i;
        headerMap = catalogHits;
        headerLabels = labels;
        sheetMode = "catalog";
        break;
      }
      if (referenceUsable) {
        headerRowIndex = i;
        headerMap = referenceHits;
        headerLabels = labels;
        sheetMode = "reference";
        break;
      }
    }

    if (headerRowIndex === -1 || sheetMode === null) {
      skippedRows.push({
        sheet: sheet.name,
        rowNumber: 0,
        why: "No header row was recognised on this sheet. Neither a product-name "
          + "column nor a recognised reference column (metabolite, SNP, nutrient, "
          + "intervention, biomarker, compound) was present in the first 25 rows.",
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

      if (sheetMode === "catalog") {
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
        continue;
      }

      // Reference sheet: identity is the subject label (metabolite, SNP, ...).
      // Rows without a subject are skipped rather than invented.
      const subject = typeof payload.subjectLabel === "string" ? payload.subjectLabel : "";
      if (subject.length === 0) {
        if (Object.keys(sourceRaw).some((k) => String(sourceRaw[k]).trim().length > 0)) {
          skippedRows.push({
            sheet: sheet.name,
            rowNumber: row.rowNumber,
            why: "The row has no subject value under its identifying column "
              + "(metabolite, SNP, nutrient, etc.), so it cannot be identified.",
          });
        }
        continue;
      }

      const displayName = payload.variantOrLevel
        ? `${subject} (${String(payload.variantOrLevel)})`
        : subject;

      items.push({
        entityType: "knowledge_reference",
        displayName: displayName.slice(0, 200),
        sourceSheet: sheet.name,
        externalKey: `${sheet.name}:${row.rowNumber}`,
        payload: {
          code: `${slug(sheet.name)}-${slug(displayName)}`.slice(0, 96),
          title: displayName,
          referenceType: "practitioner_reference_row",
          sectionPath: [sheet.name],
          subjectLabel: subject,
          ...(payload.variantOrLevel !== undefined
            ? { variantOrLevel: payload.variantOrLevel }
            : {}),
          ...(payload.mechanism !== undefined ? { mechanism: payload.mechanism } : {}),
          ...(payload.suggestedDose !== undefined
            ? { suggestedDose: payload.suggestedDose }
            : {}),
          ...(payload.supportingActions !== undefined
            ? { supportingActions: payload.supportingActions }
            : {}),
          ...(payload.additionalTesting !== undefined
            ? { additionalTesting: payload.additionalTesting }
            : {}),
          ...(payload.clinicalPearl !== undefined
            ? { clinicalPearl: payload.clinicalPearl }
            : {}),
          ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
        },
        sourceRaw,
        warnings: payload.suggestedDose !== undefined
          ? ["Suggested-dose text was preserved as reference metadata. A dose only becomes a governed clinical recommendation when it names an exact product label."]
          : undefined,
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
 * Structural patterns for a section boundary in a document that uses no
 * Heading 1-9 styles.
 *
 * These are FORMATTING signals — a paragraph that looks like a subheading
 * without having a heading style — and they only affect where sections
 * begin. A section label never says what the section MEANS: the reference
 * that lands still carries the excerpt verbatim, and no clinical fact is
 * inferred from the fact that a line was numbered or bold. The reason is
 * recorded on the section itself so a reviewer can see WHY the parser
 * split there.
 */
const NUMBERED_SECTION_PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: "chapter", re: /^\s*Chapter\s+[0-9IVX]+\s*[:.–—-]?\s+/i },
  { tag: "section", re: /^\s*Section\s+[0-9IVX]+\s*[:.–—-]?\s+/i },
  { tag: "part", re: /^\s*Part\s+[0-9IVX]+\s*[:.–—-]?\s+/i },
  { tag: "numbered_paren", re: /^\s*\d+\)\s+\S/ },
];

const LABEL_COLON_PATTERN = /^\s*[A-Z][A-Za-z0-9 ,/&+()'\-]{1,79}:\s*$/;

/**
 * Signals we accept for a paragraph to open a new section when no explicit
 * heading style is present. Each returns the section's tag (why we split)
 * or `null`. The check is intentionally strict: length limits, single-line
 * requirement, and no in-line punctuation that would make prose look like
 * a heading. False positives promote a body line to a section label; a
 * reviewer would then see two sections where the author wrote one.
 */
function structuralHeadingReason(text: string, boldRun: boolean): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (trimmed.includes("\n")) return null;

  for (const p of NUMBERED_SECTION_PATTERNS) {
    if (p.re.test(trimmed)) return `numbered:${p.tag}`;
  }
  // A short, standalone paragraph ending in `:` is a label. The colon rules
  // out prose sentences (which end in `.` or `?`), and the length cap rules
  // out list items ("If X, then Y:").
  if (trimmed.length <= 80 && LABEL_COLON_PATTERN.test(trimmed)) return "label:colon";
  // A bold-only paragraph — every visible run bold, nothing else — that is
  // short enough to be a heading. Length-capped for the same reason.
  if (boldRun && trimmed.length <= 120) return "bold:short";
  return null;
}

/**
 * Map a protocol document to knowledge-reference items, one per detected
 * section.
 *
 * A DOCUMENT IS NOT A PROTOCOL, and this is where that shows. A section of
 * practitioner prose is captured as a REFERENCE — a record that this text
 * exists and where it came from — and never as a `protocol_template` with
 * doses. Turning paragraphs into a governed protocol would mean inferring
 * the dose, which the standing rules forbid outright.
 *
 * SECTION BOUNDARIES ARE DETECTED IN THIS ORDER, and the first that fires
 * wins:
 *   1. `Heading 1-9` styles (as before). This is the author's explicit
 *      statement of section boundaries and always takes precedence.
 *   2. `Chapter N:` / `Section N:` / `Part N:` / `N)` numbered prefix.
 *   3. A short paragraph ending in `:` (a "label:" line).
 *   4. A short paragraph whose every visible run is bold.
 *
 * SIGNALS 2-4 ARE FORMAT-BASED, NOT MEANING-BASED. They decide where a
 * reference RECORD begins; they never decide what the record CLAIMS. The
 * decision reason is recorded on the section so a reviewer sees why the
 * parser split there.
 *
 * Tables are captured as part of the section they appear in. Each table row
 * becomes an additional `knowledge_reference` with its own table
 * provenance, so a reviewer chasing "row 5 of table 2 in section X" can
 * find it. Table headings are inferred from the first row of the table
 * only when its cells match `REFERENCE_ROW_SYNONYMS` — otherwise the row
 * texts are kept as raw cells.
 *
 * The short excerpt is capped at 300 characters because the governed
 * schema refuses more: the registry stores a structured summary and a
 * pointer, not a copy of somebody's copyrighted document.
 */
export function normalizeProtocolDocument(
  doc: DocxDocument,
  options: { sourceName: string },
): NormalizeResult {
  const items: NormalizedItem[] = [];
  const skippedRows: NormalizeResult["skippedRows"] = [];

  type ParagraphRef = {
    text: string;
    index: number;
    inTable: boolean;
    tableIndex?: number;
    tableRowIndex?: number;
    tableCellIndex?: number;
  };
  type Section = {
    heading: string;
    path: string[];
    body: ParagraphRef[];
    firstIndex: number;
    reason: string;
  };
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const paragraph of doc.paragraphs) {
    // In-table paragraphs never open a section — that would split every
    // Bold table-header cell into its own section, which is a much noisier
    // record than the source justifies. Tables belong to the section that
    // OWNS them.
    if (!paragraph.inTable) {
      if (paragraph.headingLevel > 0) {
        if (current) sections.push(current);
        current = {
          heading: paragraph.text,
          path: paragraph.sectionPath,
          body: [],
          firstIndex: paragraph.index,
          reason: `heading_style:${paragraph.headingLevel}`,
        };
        continue;
      }
      const structural = structuralHeadingReason(paragraph.text, paragraph.boldRun);
      if (structural) {
        if (current) sections.push(current);
        current = {
          heading: paragraph.text,
          path: paragraph.sectionPath,
          body: [],
          firstIndex: paragraph.index,
          reason: structural,
        };
        continue;
      }
    }
    if (current) {
      current.body.push({
        text: paragraph.text,
        index: paragraph.index,
        inTable: paragraph.inTable,
        tableIndex: paragraph.tableIndex,
        tableRowIndex: paragraph.tableRowIndex,
        tableCellIndex: paragraph.tableCellIndex,
      });
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    // A document that carries no explicit heading style AND no structural
    // signal (no bold subheading, no numbered chapter/section, no "label:"
    // line) refuses to guess a section boundary. Making one up here would
    // let a single blob of prose become a reference item nobody scoped, and
    // "the parser split the document exactly here" is a claim nobody made.
    skippedRows.push({
      sheet: options.sourceName,
      rowNumber: 0,
      why: "The document has no headings, and no numbered chapter/section prefix, "
        + "bold subheading, or short label-colon line to divide it into sections. "
        + "Add a heading style, or a `Chapter N:` / `Section N:` / `N)` prefix, "
        + "then re-import.",
    });
    return { items, unmappedColumns: [], skippedRows, sheetsRead: [] };
  }

  for (const section of sections) {
    const nonTable = section.body.filter((p) => !p.inTable);
    const bodyText = nonTable.map((p) => p.text).join("\n").trim();
    const tableGroups = new Map<number, ParagraphRef[]>();
    for (const p of section.body) {
      if (!p.inTable || p.tableIndex === undefined) continue;
      const list = tableGroups.get(p.tableIndex) ?? [];
      list.push(p);
      tableGroups.set(p.tableIndex, list);
    }

    if (bodyText.length === 0 && tableGroups.size === 0) {
      skippedRows.push({
        sheet: options.sourceName,
        rowNumber: section.firstIndex,
        why: `The section "${section.heading}" has a heading but no text under it.`,
      });
      continue;
    }

    if (bodyText.length > 0) {
      const excerpt = bodyText.length > 300 ? `${bodyText.slice(0, 297)}...` : bodyText;
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
          detectionReason: section.reason,
        },
        sourceRaw: {
          heading: section.heading,
          sectionPath: section.path,
          paragraphIndex: section.firstIndex,
          detectionReason: section.reason,
          // The full section text, verbatim, so the reviewer compares the
          // 300-character excerpt against what the document actually says.
          body: bodyText,
        },
        warnings:
          bodyText.length > 300
            ? ["Only the first 300 characters are stored as an excerpt; the full section text is kept as the source record."]
            : undefined,
      });
    }

    // Each table row inside the section is its own reference item. The
    // first row is treated as headers when its cells align with the
    // reference synonyms — otherwise every row's cells are kept as raw
    // cells with column-number keys.
    for (const [tableIdx, cells] of tableGroups) {
      const rows = new Map<number, ParagraphRef[]>();
      for (const p of cells) {
        if (p.tableRowIndex === undefined) continue;
        const list = rows.get(p.tableRowIndex) ?? [];
        list.push(p);
        rows.set(p.tableRowIndex, list);
      }
      const rowKeys = [...rows.keys()].sort((a, b) => a - b);
      if (rowKeys.length === 0) continue;

      const headerCells = rows.get(rowKeys[0]) ?? [];
      const headerMap = new Map<number, string>();
      let mappedCount = 0;
      for (const c of headerCells) {
        if (c.tableCellIndex === undefined) continue;
        const field = REFERENCE_HEADER_LOOKUP.get(normalizeHeader(c.text));
        if (field && !headerMap.has(c.tableCellIndex)) {
          headerMap.set(c.tableCellIndex, field);
          mappedCount += 1;
        }
      }
      const headerLabelsByCol = new Map<number, string>();
      for (const c of headerCells) {
        if (c.tableCellIndex !== undefined) headerLabelsByCol.set(c.tableCellIndex, c.text);
      }
      const startAt = mappedCount >= 2 ? 1 : 0;

      for (let ri = startAt; ri < rowKeys.length; ri += 1) {
        const rowKey = rowKeys[ri];
        const rowCells = rows.get(rowKey) ?? [];
        const payload: Record<string, unknown> = {};
        const sourceRaw: Record<string, unknown> = {};

        for (const c of rowCells) {
          if (c.tableCellIndex === undefined) continue;
          const label = headerLabelsByCol.get(c.tableCellIndex) ?? `col${c.tableCellIndex}`;
          sourceRaw[label] = c.text;
          const field = headerMap.get(c.tableCellIndex);
          if (!field) continue;
          const value = c.text.trim();
          if (value.length === 0) continue;
          payload[field] = value;
        }
        // A row of nothing is a spacer row; the source authored it that way.
        if (Object.values(sourceRaw).every((v) => String(v).trim().length === 0)) continue;

        const subject = typeof payload.subjectLabel === "string" ? payload.subjectLabel : "";
        const rowLabel = subject.length > 0
          ? subject
          : `${section.heading} — table ${tableIdx}, row ${rowKey}`;

        items.push({
          entityType: "knowledge_reference",
          displayName: rowLabel.slice(0, 200),
          externalKey: `${options.sourceName}#${section.firstIndex}#t${tableIdx}r${rowKey}`,
          payload: {
            code: `${slug(options.sourceName)}-${slug(rowLabel)}-t${tableIdx}r${rowKey}`.slice(0, 96),
            title: rowLabel,
            referenceType: "practitioner_document_table_row",
            sectionPath: [...section.path, section.heading],
            tableIndex: tableIdx,
            tableRowIndex: rowKey,
            ...(payload.subjectLabel !== undefined
              ? { subjectLabel: payload.subjectLabel }
              : {}),
            ...(payload.mechanism !== undefined ? { mechanism: payload.mechanism } : {}),
            ...(payload.suggestedDose !== undefined
              ? { suggestedDose: payload.suggestedDose }
              : {}),
            ...(payload.supportingActions !== undefined
              ? { supportingActions: payload.supportingActions }
              : {}),
          },
          sourceRaw,
          warnings: payload.suggestedDose !== undefined
            ? ["Suggested-dose text was preserved as reference metadata. A dose only becomes a governed clinical recommendation when it names an exact product label."]
            : undefined,
        });
      }
    }
  }

  return { items, unmappedColumns: [], skippedRows, sheetsRead: [options.sourceName] };
}

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "section";
