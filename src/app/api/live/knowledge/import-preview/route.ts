import { NextRequest } from "next/server";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — stage an import preview.
 *
 * WRITES NOTHING GOVERNED. Validation failures are typed `invalid` so a
 * malformed request reads as a rejected request (400) rather than a server
 * fault (500) — the difference matters to an operator deciding whether to
 * retry or fix their file.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (typeof b.sourceName !== "string" || !b.sourceName.trim()) {
      throw new AdapterError("invalid", "A source name is required.");
    }
    if (typeof b.schemaVersion !== "string" || !b.schemaVersion.trim()) {
      throw new AdapterError("invalid", "A schema version is required.");
    }
    if (!Array.isArray(b.items) || b.items.length === 0) {
      throw new AdapterError("invalid", "Import items must be a non-empty array.");
    }
    // Never defaulted. An attestation the caller did not make is not one.
    if (b.attestsNoPhi !== true) {
      throw new AdapterError(
        "invalid",
        "A no-PHI attestation is required before an import can be previewed.",
      );
    }

    const session = await getRequestSession();
    return knowledgeImportLive.preview(
      {
        sourceKind: typeof b.sourceKind === "string" ? b.sourceKind : null,
        sourceName: b.sourceName,
        schemaVersion: b.schemaVersion,
        items: b.items,
        attestsNoPhi: true,
        sourceFilename: typeof b.sourceFilename === "string" ? b.sourceFilename : null,
        sourceByteSize: typeof b.sourceByteSize === "number" ? b.sourceByteSize : null,
        sourceRevision: typeof b.sourceRevision === "string" ? b.sourceRevision : null,
      },
      session.orgId,
      session.token,
    );
  });
}
