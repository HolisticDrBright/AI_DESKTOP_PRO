import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { ImportParseError, parseImportFile } from "@/server/import";
import { MAX_FILE_BYTES } from "@/server/import/limits";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — parse an `.xlsx` or `.docx` into a reviewable import envelope.
 *
 * THIS ROUTE WRITES NOTHING, ANYWHERE. It does not call an RPC, it does not
 * touch the database, and it does not persist the uploaded bytes. It parses,
 * and it returns what it found. Staging is a separate, explicit call the
 * operator makes after reading the report — because "the file parsed" and
 * "the content is in the system" being one action is the failure this whole
 * pipeline exists to prevent.
 *
 * The file itself never leaves this process. Only the parsed envelope does,
 * and the envelope carries a file NAME, never a path.
 *
 * A parse refusal is a REJECTED REQUEST, not a server fault. An operator
 * seeing 500 retries; an operator seeing 400 with "this is a .doc, save it as
 * .docx" fixes the file. The distinction is the whole value of the message.
 */
export const runtime = "nodejs";

/** Guards the multipart read itself, before any of it is in memory as one Buffer. */
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;

  return runLive(async () => {
    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      throw new AdapterError(
        "invalid",
        `The upload is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`,
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new AdapterError("invalid", "The upload could not be read as a file upload.");
    }

    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new AdapterError("invalid", "A file is required.");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new AdapterError(
        "invalid",
        `The file is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`,
      );
    }

    const sourceKind = form.get("sourceKind");
    if (sourceKind !== "product_spreadsheet" && sourceKind !== "protocol_document") {
      throw new AdapterError(
        "invalid",
        "Source kind must be product_spreadsheet or protocol_document.",
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const sourceNameField = form.get("sourceName");
    const sheetField = form.get("sheetName");

    try {
      return parseImportFile({
        bytes,
        filename: file.name || "upload",
        sourceKind,
        sourceName: typeof sourceNameField === "string" ? sourceNameField : undefined,
        sheetName: typeof sheetField === "string" && sheetField ? sheetField : undefined,
      });
    } catch (error) {
      if (error instanceof ImportParseError) {
        // Every parse refusal is the operator's to act on, so all four codes
        // map to `invalid`. The message says which one it was and what to do.
        throw new AdapterError("invalid", error.message);
      }
      throw error;
    }
  });
}
