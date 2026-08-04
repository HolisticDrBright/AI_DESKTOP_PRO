import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { orchestrateRun } from "@/server/copilot/orchestrator";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";
import { resolveCopilotMode } from "@/server/copilot/provider";

const RUN_TYPES = new Set([
  "longitudinal_brief",
  "differential_questions",
  "lab_suggestions",
  "protocol_draft",
  "practitioner_brief",
]);

const LENSES = new Set(["western", "functional", "naturopathy", "tcm", "biohacking", "synergistic"]);

/**
 * POST — governed copilot run.
 *
 * The client supplies only bounded identifiers (patientId, lens,
 * runType, optional encounter/pathwayVersionId). The server:
 *   1. Calls `create_copilot_run` under the caller's RLS session.
 *   2. Runs the safety core + retrieval envelope + provider.
 *   3. Calls `finalize_copilot_run` with the input snapshot + output
 *      hashes. Disabled mode finalizes as `failed` (never fabricates
 *      completed content). Fixture mode finalizes as `completed`.
 *   4. Returns the envelope + the persisted `runId`.
 *
 * Never contacts an external service. Never fabricates completed content
 * when the provider is disabled or unavailable. Every failure carries a
 * PHI-safe `failure_category`; raw errors never surface.
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
    if (typeof b.patientId !== "string" || !b.patientId)
      throw new AdapterError("invalid", "patientId is required.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const orgId = resolveOrgId(session.orgId);

    const encounterId = typeof b.encounterId === "string" ? b.encounterId : null;
    const pathwayVersionId = typeof b.pathwayVersionId === "string" ? b.pathwayVersionId : null;

    // 1. Persist the run header first so any subsequent failure is recorded.
    const created = await clinicalRpc<{ ok: true; id: string }>(
      "create_copilot_run",
      {
        _organization_id: orgId,
        _patient_id: b.patientId,
        _encounter_id: encounterId,
        _lens: b.lens,
        _run_type: b.runType,
        _pathway_version_id: pathwayVersionId,
        _rule_set_version: "v1",
        _prompt_version: "v1",
        _json_schema_version: "v1",
        _provider_name: resolveCopilotMode(),
      },
      token,
    );
    const runId = created.id;

    // 2. Orchestrate. Never mutates a clinical row.
    const envelope = await orchestrateRun({
      runType: b.runType as Parameters<typeof orchestrateRun>[0]["runType"],
      lens: b.lens,
      approvedKnowledgeReferenceIds: [],
      verifiedLabelIds: [],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    });

    // 3. Finalize. Disabled/unavailable → failed. Only fixture/live-completed
    //    → completed with the real output hash.
    const finalizeStatus = envelope.status === "completed" ? "completed" : "failed";
    await clinicalRpc(
      "finalize_copilot_run",
      {
        _organization_id: orgId,
        _run_id: runId,
        _input_snapshot_hash: envelope.inputSnapshotHash,
        _output_hash: envelope.outputHash ?? envelope.inputSnapshotHash,
        _status: finalizeStatus,
      },
      token,
    );

    return { ...envelope, runId };
  });
}
