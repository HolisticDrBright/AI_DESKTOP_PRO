import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { knowledgeImportLive } from "@/adapters/knowledge-import.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — bounded research-handoff review read.
 *
 * The caller supplies the PRH ids it derived from the hash-verified
 * package manifest (at most 50). The RPC re-validates the bound and the
 * id shape, requires a knowledge editor, and returns clinical, evidence
 * and commercial slices under separate top-level keys. Read-only.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as { prhIds?: unknown };
    if (
      !Array.isArray(body.prhIds)
      || body.prhIds.length === 0
      || body.prhIds.length > 50
      || !body.prhIds.every((x) => typeof x === "string" && /^PRH-\d{4}$/.test(x))
    ) {
      throw new AdapterError("invalid", "prh_ids_required");
    }
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeImportLive.researchHandoffReview(session.orgId, body.prhIds, session.token);
  });
}
