import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import type { KnowledgePathwayContent } from "@/adapters/clinical-knowledge.types";
import { knowledgeLive } from "@/adapters/knowledge.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      pathwayId?: unknown;
      content?: unknown;
      sourceRefs?: unknown;
      changeSummary?: unknown;
    };
    if (typeof body.pathwayId !== "string" || !body.content || typeof body.content !== "object") {
      throw new AdapterError("invalid", "A pathway and draft content are required.");
    }
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.createDraft(
      session.orgId,
      body.pathwayId,
      body.content as KnowledgePathwayContent,
      Array.isArray(body.sourceRefs)
        ? body.sourceRefs.filter((item): item is string => typeof item === "string")
        : [],
      typeof body.changeSummary === "string" ? body.changeSummary : "",
      session.token,
    );
  });
}

export async function PUT(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      versionId?: unknown;
      content?: unknown;
      sourceRefs?: unknown;
      changeSummary?: unknown;
    };
    if (typeof body.versionId !== "string" || !body.content || typeof body.content !== "object") {
      throw new AdapterError("invalid", "A draft version and content are required.");
    }
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.updateDraft(
      session.orgId,
      body.versionId,
      body.content as KnowledgePathwayContent,
      Array.isArray(body.sourceRefs)
        ? body.sourceRefs.filter((item): item is string => typeof item === "string")
        : [],
      typeof body.changeSummary === "string" ? body.changeSummary : "",
      session.token,
    );
  });
}
