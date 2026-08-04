import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { orchestrateRun } from "@/server/copilot/orchestrator";

const RUN_TYPES = new Set([
  "longitudinal_brief",
  "differential_questions",
  "lab_suggestions",
  "protocol_draft",
  "practitioner_brief",
]);

const LENSES = new Set(["western", "functional", "naturopathy", "tcm", "biohacking", "synergistic"]);

/**
 * POST — orchestrate one copilot run.
 *
 * Never contacts an external service in Phase 10A. The provider is
 * `disabled` by default; `fixture` is refused in deployed environments;
 * `live` is refused entirely until Phase 10B.
 *
 * The RUN metadata is persisted via a governed RPC in a follow-up commit
 * — for the initial slice this endpoint returns the envelope only. Every
 * PHI-free field lands in audit metadata; the draft body stays in the
 * request/response, never in logs.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runType !== "string" || !RUN_TYPES.has(b.runType))
      throw new AdapterError("invalid", "runType is required.");
    if (typeof b.lens !== "string" || !LENSES.has(b.lens))
      throw new AdapterError("invalid", "lens is required.");
    await getRequestSession(); // membership check (no PHI in the request body)
    return orchestrateRun({
      runType: b.runType as Parameters<typeof orchestrateRun>[0]["runType"],
      lens: b.lens,
      approvedKnowledgeReferenceIds: Array.isArray(b.approvedKnowledgeReferenceIds)
        ? (b.approvedKnowledgeReferenceIds as string[])
        : [],
      verifiedLabelIds: Array.isArray(b.verifiedLabelIds) ? (b.verifiedLabelIds as string[]) : [],
      approvedProtocolTemplateIds: Array.isArray(b.approvedProtocolTemplateIds)
        ? (b.approvedProtocolTemplateIds as string[])
        : [],
      approvedDietTemplateIds: Array.isArray(b.approvedDietTemplateIds)
        ? (b.approvedDietTemplateIds as string[])
        : [],
    });
  });
}
