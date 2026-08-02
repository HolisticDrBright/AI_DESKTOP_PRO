/**
 * A deliberately small XML reader for OOXML parts.
 *
 * WHAT IT REFUSES, AND WHY THAT IS THE POINT:
 *
 *   * `<!DOCTYPE` — refused outright. Every classic XML attack needs it:
 *     external entities that read local files or reach the network (XXE), and
 *     nested internal entities that expand exponentially (billion laughs). A
 *     reader that supports DTDs and then tries to disable the dangerous parts
 *     is one flag away from a file-read primitive. This one has no DTD support
 *     to disable, and says so when it sees one.
 *   * `<!ENTITY` — refused, for the same reason and independently, because a
 *     declaration can appear without the word DOCTYPE nearby in a crafted file.
 *   * Any entity reference other than the five predefined ones and bounded
 *     numeric character references. An unknown `&thing;` is left verbatim
 *     rather than resolved — it came from the source and belongs in the raw
 *     record, not expanded into something the source did not say.
 *
 * It is a streaming tokenizer rather than a tree builder. A worksheet is read
 * once, top to bottom, and nothing accumulates except the rows the caller
 * keeps.
 */

import { ImportParseError, MAX_XML_DEPTH } from "./limits";

export interface XmlTag {
  /** Local name with any namespace prefix stripped: `w:p` reads as `p`. */
  name: string;
  /** Name exactly as written, prefix included. */
  rawName: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}

export interface XmlHandlers {
  onOpen?: (tag: XmlTag) => void;
  onClose?: (name: string, rawName: string) => void;
  onText?: (text: string) => void;
}

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode text content.
 *
 * Numeric references are bounded to valid Unicode scalar values; anything
 * outside is left as written. Nothing here can expand: one reference produces
 * at most one code point, so the output is never longer than the input.
 */
export function decodeXmlText(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = hex ? body.slice(2) : body.slice(1);
      if (digits.length === 0 || digits.length > 7) return whole;
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // Surrogates are not scalar values; a file that names one is malformed
      // rather than meaningful.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const predefined = PREDEFINED[body];
    return predefined ?? whole;
  });
}

function assertNoDoctype(xml: string): void {
  // Scan for the declarations rather than for a well-formed prologue: a reader
  // that only looks at the top of the file can be fed one with the declaration
  // further down.
  const doctype = /<!DOCTYPE/i.exec(xml);
  if (doctype) {
    throw new ImportParseError(
      "unsafe",
      "The file contains an XML document-type declaration, which this importer refuses "
        + "because it is how a document reaches files or servers it should not. "
        + "Re-save the file from Excel or Word and import that.",
    );
  }
  const entity = /<!ENTITY/i.exec(xml);
  if (entity) {
    throw new ImportParseError(
      "unsafe",
      "The file declares XML entities, which this importer refuses. "
        + "Re-save the file from Excel or Word and import that.",
    );
  }
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = re.exec(source);
  while (match !== null) {
    const value = match[3] ?? match[4] ?? "";
    attrs[match[1]] = decodeXmlText(value);
    match = re.exec(source);
  }
  return attrs;
}

const localName = (raw: string): string => {
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(colon + 1);
};

/**
 * Walk an XML part, calling handlers as elements open, close and yield text.
 *
 * Comments, processing instructions and CDATA are recognised so their contents
 * are never mistaken for markup. CDATA text is passed through verbatim, which
 * is correct: it is character data by definition and carries no entities.
 */
export function scanXml(xml: string, handlers: XmlHandlers): void {
  assertNoDoctype(xml);

  let i = 0;
  let depth = 0;
  const length = xml.length;

  while (i < length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      if (handlers.onText && i < length) handlers.onText(decodeXmlText(xml.slice(i)));
      return;
    }
    if (lt > i && handlers.onText) {
      handlers.onText(decodeXmlText(xml.slice(i, lt)));
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const text = xml.slice(lt + 9, end === -1 ? length : end);
      if (handlers.onText && text) handlers.onText(text);
      i = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) {
      throw new ImportParseError("malformed", "The file contains an unterminated XML tag.");
    }
    const inner = xml.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      const rawName = inner.slice(1).trim();
      depth -= 1;
      if (handlers.onClose) handlers.onClose(localName(rawName), rawName);
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const rawName = (nameEnd === -1 ? body : body.slice(0, nameEnd)).trim();
    if (!rawName) {
      throw new ImportParseError("malformed", "The file contains an XML tag with no name.");
    }

    if (!selfClosing) {
      depth += 1;
      if (depth > MAX_XML_DEPTH) {
        throw new ImportParseError(
          "unsafe",
          `The file nests XML more than ${MAX_XML_DEPTH} levels deep. It was not read.`,
        );
      }
    }

    const tag: XmlTag = {
      name: localName(rawName),
      rawName,
      attrs: nameEnd === -1 ? {} : parseAttributes(body.slice(nameEnd)),
      selfClosing,
    };
    if (handlers.onOpen) handlers.onOpen(tag);
    if (selfClosing && handlers.onClose) handlers.onClose(tag.name, tag.rawName);

    i = gt + 1;
  }
}
