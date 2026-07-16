import { NextRequest } from "next/server";
import { labsLive } from "@/adapters/labs.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * POST multipart { patientId, file } -> forward the PDF to the backend
 * ingestion endpoint as the signed-in practitioner. Light checks here
 * (presence, size, declared type); the backend re-validates magic bytes and
 * authorization under RLS.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const form = await req.formData().catch(() => null);
    if (!form) throw new AdapterError("invalid", "Expected a file upload.");

    const patientId = form.get("patientId");
    const file = form.get("file");
    if (typeof patientId !== "string" || !patientId) {
      throw new AdapterError("invalid", "A patient id is required.");
    }
    if (!(file instanceof File) || file.size === 0) {
      throw new AdapterError("invalid", "A PDF file is required.");
    }
    if (file.size > MAX_BYTES) {
      throw new AdapterError("invalid", "PDF exceeds the 15 MB limit.");
    }
    const looksPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!looksPdf) {
      throw new AdapterError("invalid", "Only PDF lab reports are supported.");
    }

    const session = await getRequestSession();
    return labsLive.uploadDocument(patientId, file, session.token);
  });
}
