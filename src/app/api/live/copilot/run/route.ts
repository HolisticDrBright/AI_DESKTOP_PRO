import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { orchestrateRun } from "@/server/copilot/orchestrator";
import { buildPatientSnapshot, hashInputSnapshot } from "@/server/copilot/input-builder";
import { fetchGovernedRetrieval } from "@/server/copilot/retrieval";
import { clinicalRpc, clinicalSelect } from "@/adapters/supabase-rest.server";
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
 * The client supplies only bounded identifiers (patientId, lens, runType,
 * optional encounter/pathwayVersionId). Order under Phase 10A:
 *   1. Build the RLS-scoped input snapshot via the SECURITY DEFINER RPC.
 *      This refuses cross-tenant patients (42501) BEFORE any run is written.
 *   2. Fetch the governed retrieval envelope via its RPC.
 *   3. Call `create_copilot_run` with the real input snapshot + hash written
 *      at CREATE time. The identity + input snapshot are locked from creation
 *      (trigger `private.clinical_copilot_run_guard`).
 *   4. Run the safety core + provider + citation validation.
 *   5. Call `finalize_copilot_run` with the SAME input hash as passed at
 *      create — finalize touches ONLY output-side fields and refuses a
 *      mismatched input hash (55000).
 *   6. Return the envelope + the persisted `runId`.
 *
 * Never contacts an external service. Never fabricates completed content
 * when the provider is disabled or unavailable.
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

    // 1. Build patient snapshot first — refuses cross-tenant patients before
    //    any row is written to clinical_copilot_runs.
    const bundle = await buildPatientSnapshot({
      organizationId: orgId,
      patientId: b.patientId,
      accessToken: token,
    });
    // 2. Fetch governed retrieval — an empty set is the honest current-staging
    //    answer; the model has nothing to cite from.
    const retrieval = await fetchGovernedRetrieval({
      organizationId: orgId,
      accessToken: token,
    });

    const inputSnapshotHash = hashInputSnapshot(bundle.snapshot, bundle.records);

    // 2b. Read the governed provider facts. These come from the registry
    //     and activation rows — audited records, not the environment — and
    //     they are what decides whether a synthetic-fixture provider is
    //     permitted for this organization. A failure to read them is NOT
    //     fatal: the run proceeds and the live provider refuses, which is
    //     the same honest outcome as having no approval at all.
    const governed = await readGovernedProviderFacts(orgId, token);

    // 3. Persist the run header with the real input snapshot + hash. The
    //    identity + input fields are locked from creation by the trigger.
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
        _input_snapshot_hash: inputSnapshotHash,
        _input_snapshot: bundle.snapshot,
      },
      token,
    );
    const runId = created.id;

    // 4. Orchestrate on the same snapshot + retrieval.
    const envelope = await orchestrateRun({
      runType: b.runType as Parameters<typeof orchestrateRun>[0]["runType"],
      lens: b.lens,
      snapshot: bundle.snapshot,
      records: bundle.records,
      retrieval,
      governed: {
        registryKind: governed.registryKind,
        registryName: governed.registryName,
        activationState: governed.activationState,
        containsPHI: snapshotContainsPHI(bundle),
      },
    });

    // 5. Finalize with the SAME input hash as create — this proves the
    //    orchestrator did not swap the snapshot between create and finalize.
    //    Any mismatch is refused by `finalize_copilot_run` (55000).
    const finalizeStatus = envelope.status === "completed" ? "completed" : "failed";
    await clinicalRpc(
      "finalize_copilot_run",
      {
        _organization_id: orgId,
        _run_id: runId,
        _input_snapshot_hash: inputSnapshotHash,
        _output_hash: envelope.outputHash ?? inputSnapshotHash,
        _status: finalizeStatus,
      },
      token,
    );

    return { ...envelope, runId };
  });
}

/**
 * Read the governed provider facts for this organization.
 *
 * Returns nulls rather than throwing when the registry is empty or
 * unreadable: "we could not confirm an approval" and "there is no
 * approval" lead to the same refusal, and a run that fails here would
 * hide that with an error banner instead of an honest unavailable state.
 */
async function readGovernedProviderFacts(
  orgId: string,
  token: string | null,
): Promise<{ registryKind: string | null; registryName: string | null; activationState: string | null }> {
  const none = { registryKind: null, registryName: null, activationState: null };
  try {
    const rows = await clinicalSelect<Array<{ id: string; provider_kind: string; provider_name: string }>>(
      "clinical_copilot_provider_registry",
      new URLSearchParams({
        select: "id,provider_kind,provider_name",
        order: "created_at.desc",
        limit: "1",
      }),
      token,
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row?.id) return none;
    const activation = await clinicalRpc<{ state?: string }>(
      "get_copilot_activation",
      { _organization_id: orgId, _provider_id: row.id },
      token,
    );
    return {
      registryKind: row.provider_kind ?? null,
      registryName: row.provider_name ?? null,
      activationState: activation?.state ?? null,
    };
  } catch {
    return none;
  }
}

/**
 * Whether the input snapshot carries anything that counts as PHI.
 *
 * Deliberately conservative: any demographic value, any clinical record,
 * or any dated observation makes this true. The synthetic-fixture provider
 * is only reachable when this is false, so a false negative here would be
 * the serious failure — an empty snapshot is the only thing treated as
 * PHI-free.
 */
function snapshotContainsPHI(bundle: {
  snapshot: { demographics?: Record<string, unknown> };
  records: unknown[];
}): boolean {
  if (bundle.records.length > 0) return true;
  const demo = bundle.snapshot.demographics ?? {};
  return Object.values(demo).some((v) => v !== null && v !== undefined);
}
