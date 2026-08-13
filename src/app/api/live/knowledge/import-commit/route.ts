import { NextRequest } from "next/server";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — commit a reviewed batch.
 *
 * `expectedCounts` is the counts the reviewer actually saw. When supplied, a
 * preview that moved underneath them fails with a conflict rather than
 * applying a different set of rows than the one that was read.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.batchId !== "string" || !b.batchId) {
      throw new AdapterError("invalid", "A batch id is required.");
    }

    let expected: { added: number; changed: number } | null = null;
    if (b.expectedCounts != null) {
      const e = b.expectedCounts as Record<string, unknown>;
      if (typeof e.added !== "number" || typeof e.changed !== "number") {
        throw new AdapterError(
          "invalid",
          "Expected counts must contain numeric added and changed values.",
        );
      }
      expected = { added: e.added, changed: e.changed };
    }

    const session = await getRequestSession();
    return knowledgeImportLive.commit(
      b.batchId,
      expected,
      typeof b.note === "string" ? b.note : null,
      session.token,
    );
  });
}
