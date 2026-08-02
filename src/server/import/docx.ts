if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { ImportParseError, MAX_CELL_CHARS, MAX_DOC_PARAGRAPHS } from "./limits";
import { scanXml } from "./xml";
import { ZipReader } from "./zip";

/**
 * Read the TEXT and the HEADING STRUCTURE out of a document. Nothing else.
 *
 * WHAT IS DISCARDED, AND WHY:
 *
 *   * FIELD CODES (`w:instrText`, `w:fldSimple`). A Word field is an
 *     instruction: `INCLUDETEXT` pulls in another file, `DDEAUTO` was the
 *     original macro-free remote-execution vector, `HYPERLINK` points out of
 *     the document. The rendered result of a field is not in the file, and the
 *     instruction is not text the practitioner wrote. Both are dropped.
 *   * HYPERLINK TARGETS. The visible words stay, because the practitioner
 *     wrote them. The destination does not, because nothing in this system
 *     should hold a URL it might one day follow.
 *   * `w:deleted` runs — text struck out under tracked changes. It is text the
 *     author REMOVED, and importing it would reinstate a decision they made in
 *     the opposite direction.
 *
 * Headings are kept because they are the document's own statement of where one
 * protocol ends and the next begins. That is the section provenance an
 * imported claim is later traced back through.
 */

export interface DocxParagraph {
  /** 1-based position in the document, as parsed. */
  index: number;
  /** Heading level 1-9, or 0 for body text. */
  headingLevel: number;
  text: string;
  /** Heading trail above this paragraph, outermost first. */
  sectionPath: string[];
  /** True when the paragraph is a cell in a table. */
  inTable: boolean;
}

export interface DocxDocument {
  paragraphs: DocxParagraph[];
  /** Parts present in the file that were deliberately not read. */
  ignoredParts: string[];
  /** Field codes seen and discarded. Reported, never executed. */
  discardedFieldCodes: number;
  /** True when the document had more paragraphs than the reader may take. */
  truncated: boolean;
}

const HEADING_STYLE = /^heading\s*([1-9])$/i;

function headingLevelOf(styleId: string | undefined): number {
  if (!styleId) return 0;
  const direct = HEADING_STYLE.exec(styleId.replace(/-/g, " "));
  if (direct) return Number.parseInt(direct[1], 10);
  // Word writes `Heading1` for the built-in styles and `berschrift1` in some
  // localised templates; only the ASCII built-ins are recognised, because
  // guessing at a localised style name would silently promote body text.
  const compact = /^Heading([1-9])$/.exec(styleId);
  return compact ? Number.parseInt(compact[1], 10) : 0;
}

export function parseDocx(bytes: Buffer): DocxDocument {
  const zip = new ZipReader(bytes);

  const documentXml = zip.readText("word/document.xml");
  if (documentXml === null) {
    throw new ImportParseError(
      "unsupported",
      "This file is not a .docx document. If it is an older .doc, open it in Word "
        + "and save it as .docx first.",
    );
  }

  const ignoredParts = zip
    .names()
    .filter(
      (name) =>
        name === "word/_rels/document.xml.rels"
        || name.startsWith("word/media/")
        || name.startsWith("customXml/")
        || name === "word/footnotes.xml"
        || name === "word/endnotes.xml"
        || /^word\/(header|footer)\d*\.xml$/.test(name),
    );

  const paragraphs: DocxParagraph[] = [];
  const sectionStack: string[] = [];
  let truncated = false;
  let discardedFieldCodes = 0;

  let inParagraph = false;
  let parts: string[] = [];
  let styleId: string | undefined;
  let tableDepth = 0;
  // Depth counters rather than booleans: Word nests these, and a boolean
  // reset by the first close tag would let the rest of a deleted run through.
  let deletedDepth = 0;
  let fieldDepth = 0;
  let inTextRun = false;

  scanXml(documentXml, {
    onOpen: (tag) => {
      switch (tag.name) {
        case "tbl":
          tableDepth += 1;
          return;
        case "p":
          inParagraph = true;
          parts = [];
          styleId = undefined;
          return;
        case "pStyle":
          if (inParagraph) styleId = tag.attrs["w:val"] ?? tag.attrs.val;
          return;
        case "del":
          deletedDepth += 1;
          return;
        case "instrText":
          // The instruction itself. Counted, never kept, never acted on.
          fieldDepth += 1;
          discardedFieldCodes += 1;
          return;
        case "fldSimple":
          discardedFieldCodes += 1;
          fieldDepth += 1;
          if (tag.selfClosing) fieldDepth -= 1;
          return;
        case "t":
          if (inParagraph && deletedDepth === 0 && fieldDepth === 0) inTextRun = true;
          return;
        case "tab":
          if (inParagraph && deletedDepth === 0 && fieldDepth === 0) parts.push("\t");
          return;
        case "br":
        case "cr":
          if (inParagraph && deletedDepth === 0 && fieldDepth === 0) parts.push("\n");
          return;
        default:
      }
    },
    onText: (text) => {
      if (inTextRun) parts.push(text);
    },
    onClose: (name) => {
      switch (name) {
        case "tbl":
          tableDepth = Math.max(0, tableDepth - 1);
          return;
        case "del":
          deletedDepth = Math.max(0, deletedDepth - 1);
          return;
        case "instrText":
        case "fldSimple":
          fieldDepth = Math.max(0, fieldDepth - 1);
          return;
        case "t":
          inTextRun = false;
          return;
        case "p": {
          if (!inParagraph) return;
          inParagraph = false;
          if (paragraphs.length >= MAX_DOC_PARAGRAPHS) {
            truncated = true;
            return;
          }
          const text = parts.join("").replace(/[ \t]+/g, " ").trim().slice(0, MAX_CELL_CHARS);
          const headingLevel = headingLevelOf(styleId);

          if (headingLevel > 0 && text.length > 0) {
            // A level-2 heading replaces everything from level 2 down.
            sectionStack.length = Math.min(sectionStack.length, headingLevel - 1);
            sectionStack[headingLevel - 1] = text;
            for (let i = 0; i < sectionStack.length; i += 1) {
              if (sectionStack[i] === undefined) sectionStack[i] = "";
            }
          }
          if (text.length === 0) return;

          paragraphs.push({
            index: paragraphs.length + 1,
            headingLevel,
            text,
            sectionPath: sectionStack.filter((s) => s.length > 0),
            inTable: tableDepth > 0,
          });
          return;
        }
        default:
      }
    },
  });

  return { paragraphs, ignoredParts, discardedFieldCodes, truncated };
}
