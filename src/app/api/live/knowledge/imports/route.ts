import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import type { KnowledgeImportSourceItem } from "@/adapters/clinical-import.types";
import { knowledgeLive } from "@/adapters/knowledge.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.imports(session.orgId, session.token);
  });
}

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      sourceName?: unknown;
      sourceRevision?: unknown;
      schemaVersion?: unknown;
      items?: unknown;
      attestsNoPhi?: unknown;
    };
    if (
      typeof body.sourceName !== "string"
      || typeof body.schemaVersion !== "string"
      || !Array.isArray(body.items)
      || body.attestsNoPhi !== true
    ) {
      throw new AdapterError("invalid", "A valid import bundle and no-PHI attestation are required.");
    }
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.stageImport(session.orgId, {
      sourceName: body.sourceName,
      sourceRevision: typeof body.sourceRevision === "string" ? body.sourceRevision : undefined,
      schemaVersion: body.schemaVersion,
      items: body.items as KnowledgeImportSourceItem[],
      attestsNoPhi: true,
    }, session.token);
  });
}
